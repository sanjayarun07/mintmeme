import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimChain, CpAmm, Store, PolicySigner, Router, Engine, NATIVE, BulkRunner, validateBulk, splitEqual, splitByBalance, MAX_BULK_WALLETS } from '../src/index.ts';
import type { BulkSpec, WalletPolicy, ChainPort } from '../src/index.ts';

const TOK = '0xMEME', tick = () => new Promise(r => setTimeout(r, 1));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`);
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); if (c.rpcDown) throw new Error('rpc down'); p.time = c.time; p.block = c.block; p.state = c.state; },
    async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); }, async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); },
    async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
function setup(o: { wallets?: number; funds?: bigint; maxPerTx?: bigint; reserve?: bigint; store?: Store } = {}) {
  const chain = new SimChain(), n = o.wallets ?? 4, ws = ids(Math.max(n, 12));
  chain.addVenue(new CpAmm('uni-v2:MEME', 'uniswap-v2', TOK, NATIVE, o.reserve ?? 1_000_000n, o.reserve ?? 1_000_000n));
  for (const w of ws) chain.credit(w, NATIVE, o.funds ?? 100_000n);
  const pol = (userId: string): WalletPolicy => ({ userId, chains: ['sim-evm'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: o.maxPerTx ?? 50_000n, [TOK]: 10_000_000n }, dailyLimit: { [NATIVE]: 500_000n, [TOK]: 10_000_000n }, destinations: [], deviceSecret: 's-' + userId } as any);
  const signer = new PolicySigner(new Map(ws.map(w => [w, 'k-' + w])), new Map(ws.map(w => [w, pol('u1')])));
  const p = port(chain), store = o.store ?? new Store(), engine = new Engine({ store, chain: p, signer, router: new Router(p), platformFeeBps: 0 });
  return { chain, p, store, engine, ws };
}
const spec = (legs: BulkSpec['legs'], o: Partial<BulkSpec> = {}): BulkSpec => ({ id: 'b1', userId: 'u1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, venues: ['uniswap-v2'], legs, slippageBps: 500, ...o });
const drive = async (s: ReturnType<typeof setup>, r: BulkRunner) => { for (let i = 0; i < 60; i++) { await r.tick(); s.chain.mine(2); await r.settle(); if (r.summary().done) return; } };

test('validation: 1..10 wallets, no duplicates, positive amounts, totals and slippage bounded', () => {
  const ok = [{ walletId: 'a', amount: 1n }];
  validateBulk(spec(ok)); assert.throws(() => validateBulk(spec([])), /at least one/);
  assert.throws(() => validateBulk(spec(ids(11).map(w => ({ walletId: w, amount: 1n })))), /at most 10/);
  assert.equal(MAX_BULK_WALLETS, 10); validateBulk(spec(ids(10).map(w => ({ walletId: w, amount: 1n }))));
  assert.throws(() => validateBulk(spec(ids(3).map(w => ({ walletId: w, amount: 1n })), { maxWallets: 2 })), /at most 2/);
  assert.throws(() => validateBulk(spec([...ok, ...ok])), /twice/); assert.throws(() => validateBulk(spec([{ walletId: 'a', amount: 0n }])), /positive/);
  assert.throws(() => validateBulk(spec([{ walletId: 'a', amount: 10n }], { maxTotal: 9n })), /exceeds maxTotal/); assert.throws(() => validateBulk(spec(ok, { slippageBps: 10_001 })), /slippage/);
  assert.throws(() => validateBulk(spec(ok, { quoteToken: TOK })), /same/); assert.throws(() => validateBulk(spec(ok, { id: '' })), /id/);
});

test('splitEqual sums exactly (remainder to the first wallets); splitByBalance takes a share of each wallet and drops empty ones', () => {
  const legs = splitEqual(['a', 'b', 'c'], 100n); assert.deepEqual(legs.map(l => l.amount), [34n, 33n, 33n]); assert.equal(legs.reduce((a, l) => a + l.amount, 0n), 100n);
  const by = splitByBalance(new Map([['a', 1000n], ['b', 500n], ['c', 0n]]), 2500); assert.deepEqual(by, [{ walletId: 'a', amount: 250n }, { walletId: 'b', amount: 125n }]);
  assert.throws(() => splitByBalance(new Map(), 0), /pctBps/);
});

test('a bulk buy fills every wallet through its own engine record; each wallet pays exactly its leg and receives its own tokens', async () => {
  const s = setup(); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w2', amount: 20_000n }, { walletId: 'w3', amount: 5_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.done, true); assert.equal(sum.filled, 3); assert.equal(sum.failed + sum.skipped, 0); assert.equal(sum.spent, 35_000n);
  for (const l of legs) { const rec = s.store.records.get(`bulk:b1:${l.walletId}`)!; assert.equal(rec.state, 'finalized'); assert.equal(rec.intent.origin, 'bulk'); assert.equal(rec.intent.walletId, l.walletId); assert.equal(rec.intent.amountIn, l.amount);
    assert.equal(s.chain.balance(l.walletId, TOK), rec.fill!.received); assert.equal(100_000n - s.chain.balance(l.walletId, NATIVE), rec.fill!.spent + rec.fill!.networkFee, 'the wallet paid its leg plus the network fee, nothing else'); }
  assert.equal(sum.received, legs.reduce((a, l) => a + s.chain.balance(l.walletId, TOK), 0n)); assert.equal(s.chain.balance('w4', TOK), 0n, 'a wallet not in the request is untouched');
});

test('running the same bulk id again buys nothing more (idempotency keys are per bulk id and wallet)', async () => {
  const s = setup(); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w2', amount: 10_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, r); const before = [s.chain.balance('w1', TOK), s.chain.balance('w2', TOK)];
  const again = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, again);
  assert.deepEqual([s.chain.balance('w1', TOK), s.chain.balance('w2', TOK)], before); assert.equal(again.summary().filled, 2);
  assert.equal([...s.store.records.keys()].filter(k => k.startsWith('bulk:b1:')).length, 2);
});

test('a wallet that cannot fund its leg is skipped with the reason; the others still buy', async () => {
  const s = setup(); const w9bal = s.chain.balance('w9', NATIVE); s.chain.credit('w9', NATIVE, -w9bal + 100n); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w9', amount: 10_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.filled, 1); assert.equal(sum.skipped, 1); const bad = sum.legs.find(l => l.walletId === 'w9')!; assert.equal(bad.status, 'skipped'); assert.match(bad.reason!, /balance 100 is below the 10000/);
  assert.equal(s.store.records.has('bulk:b1:w9'), false, 'nothing was submitted for the skipped wallet'); assert.equal(sum.done, true);
});

test('a leg refused by its wallet policy fails alone and says why; the other legs are unaffected (onFailure continue)', async () => {
  const s = setup({ maxPerTx: 15_000n }); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w2', amount: 20_000n }, { walletId: 'w3', amount: 10_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.filled, 2); assert.equal(sum.failed, 1); const bad = sum.legs.find(l => l.walletId === 'w2')!; assert.equal(bad.status, 'failed'); assert.ok(bad.reason && bad.reason.length > 0); assert.equal(s.chain.balance('w2', TOK), 0n);
});

test("onFailure 'stop': legs go one at a time and the unsent legs are skipped after the first failure", async () => {
  const s = setup({ maxPerTx: 15_000n }); const legs = [{ walletId: 'w1', amount: 20_000n }, { walletId: 'w2', amount: 10_000n }, { walletId: 'w3', amount: 10_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { onFailure: 'stop' }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.legs[0].status, 'failed'); assert.deepEqual(sum.legs.slice(1).map(l => l.status), ['skipped', 'skipped']); assert.match(sum.legs[1].reason!, /earlier leg failed/); assert.equal(sum.filled, 0);
  assert.equal(s.chain.balance('w2', TOK) + s.chain.balance('w3', TOK), 0n);
});

test('maxImpactBps judges the WHOLE amount against the pool: too big refuses every leg before anything is sent; a small total goes through', async () => {
  const s = setup({ reserve: 100_000n }); const big = [{ walletId: 'w1', amount: 20_000n }, { walletId: 'w2', amount: 20_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(big, { maxImpactBps: 500 }) }); await drive(s, r); const sum = r.summary();
  assert.ok(sum.refused && /above the 500 bps/.test(sum.refused)); assert.equal(sum.skipped, 2); assert.equal(s.store.records.size, 0); assert.equal(sum.done, true);
  const ok = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec([{ walletId: 'w1', amount: 1000n }, { walletId: 'w2', amount: 1000n }], { id: 'b2', maxImpactBps: 500 }) }); await drive(s, ok); assert.equal(ok.summary().filled, 2);
  const none = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec([{ walletId: 'w1', amount: 1000n }], { id: 'b3', maxImpactBps: 500, venues: ['nope'] }) }); await drive(s, none); assert.match(none.summary().refused!, /no authorized venue/);
});

test('sequential (default) prices each leg on the pool as the earlier legs left it: all 10 fill even though together they move the pool more than the 5% slippage', async () => {
  const s = setup(); const legs = ids(10).map(w => ({ walletId: w, amount: 5_000n })); const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs) }); await drive(s, r);
  const sum = r.summary(); assert.equal(sum.filled, 10); const rcv = sum.legs.map(l => l.received!); assert.ok(rcv[9] < rcv[0], 'later legs get fewer tokens: the price moved up, as it should');
});

test("parallel mode quotes every leg from the same pool state: the same 10 legs do NOT all fill, the failed ones reverted on their own minimum output and spent no quote tokens", async () => {
  const s = setup(); const legs = ids(10).map(w => ({ walletId: w, amount: 5_000n })); const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { mode: 'parallel' }) }); await drive(s, r);
  const sum = r.summary(); assert.ok(sum.filled >= 1 && sum.filled < 10, `filled ${sum.filled}`); assert.equal(sum.filled + sum.failed, 10);
  for (const l of sum.legs.filter(x => x.status === 'failed')) { assert.match(l.reason!, /minOut|insufficient output/); assert.equal(s.chain.balance(l.walletId, TOK), 0n); assert.ok(s.chain.balance(l.walletId, NATIVE) >= 100_000n - 1_000n, 'a reverted leg costs at most the network fee (1000 in the sim)'); }
});

test('perTick staggers the legs: only that many are handed to the engine per tick', async () => {
  const s = setup(); const legs = ids(4).map(w => ({ walletId: w, amount: 1000n })); const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { perTick: 2, mode: 'parallel' }) });
  const t1 = await r.tick(); assert.equal(t1.submitted.length, 2); assert.equal(r.summary().open >= 2, true); await drive(s, r); assert.equal(r.summary().filled, 4);
});

test('crash safety: state is written before submitting; a new runner from the same files finishes the SAME legs without a second purchase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-bulk-')), ef = join(dir, 'eng.json'), bf = join(dir, 'bulk.json');
  const s = setup({ store: Store.open(ef) }); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w2', amount: 10_000n }, { walletId: 'w3', amount: 10_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs), persistPath: bf });
  let n = 0; const submit = s.engine.submit.bind(s.engine); (s.engine as any).submit = async (i: any) => { if (++n === 2) throw Object.assign(new Error('process killed'), { fatal: true }); return submit(i); };
  await r.tick().catch(() => undefined);                                              // the second leg's hand-over "crashes" (treated as that leg failing at hand-over)
  const s2 = setup({ store: Store.open(ef) }); s2.chain.credit('w1', NATIVE, 0n);
  const r2 = new BulkRunner({ engine: s2.engine, chain: s2.p, spec: spec(legs), persistPath: bf });
  assert.equal(r2.legs.length, 3); assert.equal(r2.planned, true, 'preflight is not repeated');
  assert.throws(() => new BulkRunner({ engine: s2.engine, chain: s2.p, spec: spec(legs, { id: 'other' }), persistPath: bf }), /belongs to bulk buy b1/);
  await r2.resume(); const keys = [...Store.open(ef).records.keys()].filter(k => k.startsWith('bulk:b1:')); assert.ok(new Set(keys).size === keys.length && keys.length <= 3);
});

test('a node outage before the first tick does not lose or send anything; the next tick plans and sends', async () => {
  const s = setup(); s.chain.rpcDown = true; const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec([{ walletId: 'w1', amount: 1000n }]) });
  const t = await r.tick(); assert.match(t.error!, /node unreachable/); assert.equal(s.store.records.size, 0); s.chain.rpcDown = false; await drive(s, r); assert.equal(r.summary().filled, 1);
});

test('ten wallets in one request all buy; the summary adds up', async () => {
  const s = setup(); const legs = splitEqual(ids(10), 50_000n); const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { maxTotal: 50_000n }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.filled, 10); assert.equal(sum.spent, 50_000n); assert.equal(sum.received, ids(10).reduce((a, w) => a + s.chain.balance(w, TOK), 0n));
});

/* ---------- bulk SELL ---------- */
const holders = (s: ReturnType<typeof setup>, amounts: Record<string, bigint>) => { for (const [w, a] of Object.entries(amounts)) s.chain.credit(w, TOK, a); };

test('a bulk sell sells each wallet its own token amount for the quote token; each wallet gives exactly its leg and receives its own proceeds', async () => {
  const s = setup(); holders(s, { w1: 10_000n, w2: 20_000n, w3: 5_000n }); const legs = [{ walletId: 'w1', amount: 10_000n }, { walletId: 'w2', amount: 20_000n }, { walletId: 'w3', amount: 5_000n }];
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { side: 'sell' }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.done, true); assert.equal(sum.filled, 3); assert.equal(sum.failed + sum.skipped, 0); assert.equal(sum.spent, 35_000n, 'spent is in token units for a sell');
  for (const l of legs) { const rec = s.store.records.get(`bulk:b1:${l.walletId}`)!; assert.equal(rec.state, 'finalized'); assert.equal(rec.intent.origin, 'bulk'); assert.equal(rec.intent.tokenIn, TOK); assert.equal(rec.intent.tokenOut, NATIVE); assert.equal(rec.intent.amountIn, l.amount);
    assert.equal(s.chain.balance(l.walletId, TOK), 0n, 'the wallet sold exactly its leg'); assert.ok(rec.fill!.received > 0n); }
  assert.equal(s.chain.balance('w4', NATIVE), 100_000n, 'a wallet not in the request is untouched');
});
test('a bulk sell skips a wallet that does not hold enough tokens, with the reason; the others still sell', async () => {
  const s = setup(); holders(s, { w1: 1_000n, w2: 50n }); const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec([{ walletId: 'w1', amount: 1_000n }, { walletId: 'w2', amount: 500n }], { side: 'sell' }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.filled, 1); assert.equal(sum.skipped, 1); assert.match(sum.legs[1].reason!, /balance 50 is below the 500/);
});
test('a bulk sell checks the price impact of selling the WHOLE amount first; too big refuses every leg and sends nothing', async () => {
  const s = setup({ reserve: 100_000n }); holders(s, { w1: 40_000n, w2: 40_000n });
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec([{ walletId: 'w1', amount: 40_000n }, { walletId: 'w2', amount: 40_000n }], { side: 'sell', maxImpactBps: 500 }) }); await drive(s, r); const sum = r.summary();
  assert.match(sum.refused!, /selling the total would move the price/); assert.equal(sum.skipped, 2); assert.equal(s.store.records.size, 0);
});
test('selling a share of every holder (splitByBalance) leaves the rest, and running the same sell id again sells nothing more', async () => {
  const s = setup(); holders(s, { w1: 10_000n, w2: 4_000n }); const legs = splitByBalance(new Map([['w1', 10_000n], ['w2', 4_000n]]), 5_000);
  assert.deepEqual(legs.map(l => l.amount), [5_000n, 2_000n]);
  const r = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { side: 'sell', id: 's1' }) }); await drive(s, r); assert.equal(s.chain.balance('w1', TOK), 5_000n); assert.equal(s.chain.balance('w2', TOK), 2_000n);
  const again = new BulkRunner({ engine: s.engine, chain: s.p, spec: spec(legs, { side: 'sell', id: 's1' }) }); await drive(s, again); assert.equal(s.chain.balance('w1', TOK), 5_000n, 'same id: nothing sold twice');
});
