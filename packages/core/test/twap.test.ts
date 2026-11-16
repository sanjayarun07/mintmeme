import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimChain, CpAmm, Store, PolicySigner, Router, Engine, NATIVE, TwapRunner, validateTwap, splitSlices, twapSchedule, MAX_TWAP_SLICES } from '../src/index.ts';
import type { TwapSpec, WalletPolicy, ChainPort } from '../src/index.ts';

const TOK = '0xMEME', tick = () => new Promise(r => setTimeout(r, 1)), E18 = 10n ** 18n;
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); if (c.rpcDown) throw new Error('rpc down'); p.time = c.time; p.block = c.block; p.state = c.state; },
    async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); }, async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); },
    async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
function setup(o: { funds?: bigint; tokens?: bigint; maxPerTx?: bigint; reserve?: bigint; store?: Store } = {}) {
  const chain = new SimChain(); chain.addVenue(new CpAmm('uni-v2:MEME', 'uniswap-v2', TOK, NATIVE, o.reserve ?? 1_000_000n, o.reserve ?? 1_000_000n));
  chain.credit('w1', NATIVE, o.funds ?? 1_000_000n); if (o.tokens) chain.credit('w1', TOK, o.tokens);
  const pol: WalletPolicy = { userId: 'u1', chains: ['sim-evm'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: o.maxPerTx ?? 500_000n, [TOK]: o.maxPerTx ?? 500_000n }, dailyLimit: { [NATIVE]: 5_000_000n, [TOK]: 5_000_000n }, destinations: [], deviceSe: undefined } as any;
  const signer = new PolicySigner(new Map([['w1', 'k-w1']]), new Map([['w1', pol]]));
  const p = port(chain), store = o.store ?? new Store(), engine = new Engine({ store, chain: p, signer, router: new Router(p), platformFeeBps: 0 });
  return { chain, p, store, engine };
}
const spec = (o: Partial<TwapSpec> = {}): TwapSpec => ({ id: 't1', userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, venues: ['uniswap-v2'], side: 'buy', total: 40_000n, slices: 4, intervalS: 300, slippageBps: 500, ...o });
/** One round: tick, let the chain confirm, settle, then move the clock forward `secs`. */
const round = async (s: ReturnType<typeof setup>, r: TwapRunner, secs = 300) => { await r.tick(); s.chain.mine(4); await r.settle(); s.chain.time += secs; };
const drive = async (s: ReturnType<typeof setup>, r: TwapRunner, rounds = 12, secs = 300) => { for (let i = 0; i < rounds && !r.summary().done; i++) await round(s, r, secs); };

test('validation: 2..100 slices, positive whole-second interval, each slice gets at least 1 unit, limits bounded', () => {
  validateTwap(spec()); assert.equal(MAX_TWAP_SLICES, 100); validateTwap(spec({ slices: 100, total: 100n }));
  assert.throws(() => validateTwap(spec({ slices: 1 })), /at least 2/); assert.throws(() => validateTwap(spec({ slices: 101, total: 1000n })), /at most 100/);
  assert.throws(() => validateTwap(spec({ slices: 5, maxSlices: 4 })), /at most 4/); assert.throws(() => validateTwap(spec({ intervalS: 0 })), /intervalS/);
  assert.throws(() => validateTwap(spec({ total: 0n })), /positive/); assert.throws(() => validateTwap(spec({ total: 3n, slices: 4 })), /too small/);
  assert.throws(() => validateTwap(spec({ slippageBps: 10_001 })), /slippage/); assert.throws(() => validateTwap(spec({ jitterPct: 51 })), /jitterPct/);
  assert.throws(() => validateTwap(spec({ limitPriceE18: 0n })), /limitPriceE18/); assert.throws(() => validateTwap(spec({ quoteToken: TOK })), /same/);
  assert.throws(() => validateTwap(spec({ id: '' })), /id/); assert.throws(() => validateTwap(spec({ side: 'hold' as any })), /side/); assert.throws(() => validateTwap(spec({ windowS: 0 })), /windowS/);
});

test('slices sum exactly (remainder to the first); the schedule is evenly spaced, never before the start, and jitter is fixed per id and keeps slices in order', () => {
  const parts = splitSlices(103n, 4); assert.deepEqual(parts, [26n, 26n, 26n, 25n]); assert.equal(parts.reduce((a, b) => a + b, 0n), 103n);
  assert.deepEqual(twapSchedule({ id: 'x', slices: 4, intervalS: 60 }, 1000), [1000, 1060, 1120, 1180]);
  const a = twapSchedule({ id: 'x', slices: 50, intervalS: 60, jitterPct: 50 }, 1000), b = twapSchedule({ id: 'x', slices: 50, intervalS: 60, jitterPct: 50 }, 1000), c = twapSchedule({ id: 'y', slices: 50, intervalS: 60, jitterPct: 50 }, 1000);
  assert.deepEqual(a, b, 'same id, same schedule'); assert.notDeepEqual(a, c, 'a different order is jittered differently'); assert.ok(a[0] >= 1000);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], 'slices stay in order'); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - (1000 + i * 60)) <= 15, 'at most a quarter interval off');
});

test('a TWAP buy sends one slice per interval, each through its own engine record; the wallet pays exactly the total', async () => {
  const s = setup(); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() });
  const t0 = s.chain.time; await r.tick(); assert.deepEqual([...s.store.records.keys()].filter(k => k.startsWith('twap:')), ['twap:t1:0'], 'only the first slice goes at the start');
  s.chain.mine(4); await r.settle(); await r.tick(); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('twap:')).length, 1, 'the second slice is not due yet (nothing is sent early)');
  s.chain.time = t0 + 300; await r.tick(); s.chain.mine(4); await r.settle(); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('twap:')).length, 2);
  s.chain.time = t0 + 600; await drive(s, r); const sum = r.summary();
  assert.equal(sum.done, true); assert.equal(sum.filled, 4); assert.equal(sum.failed + sum.skipped, 0); assert.equal(sum.spent, 40_000n);
  for (let n = 0; n < 4; n++) { const rec = s.store.records.get(`twap:t1:${n}`)!; assert.equal(rec.state, 'finalized'); assert.equal(rec.intent.origin, 'twap'); assert.equal(rec.intent.amountIn, 10_000n); assert.equal(rec.intent.tokenIn, NATIVE); }
  assert.equal(s.chain.balance('w1', TOK), sum.received); assert.ok(sum.avgPriceE18! > 0n); assert.equal(sum.nextDueAt, undefined);
});

test('a TWAP sell trades tokens for the quote token, slice by slice', async () => {
  const s = setup({ tokens: 40_000n }); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ side: 'sell' }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.filled, 4); assert.equal(sum.spent, 40_000n, 'spent is the token side for a sell'); assert.equal(s.chain.balance('w1', TOK), 0n);
  const rec = s.store.records.get('twap:t1:0')!; assert.equal(rec.intent.tokenIn, TOK); assert.equal(rec.intent.tokenOut, NATIVE); assert.ok(sum.received > 0n);
});

test('running the same id again trades nothing more (keys are per order id and slice)', async () => {
  const s = setup(); await drive(s, new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() })); const before = s.chain.balance('w1', TOK);
  const again = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() }); await drive(s, again);
  assert.equal(s.chain.balance('w1', TOK), before); assert.equal(again.summary().filled, 4); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('twap:t1:')).length, 4);
});

test('a wallet that cannot fund the whole order is refused up front and nothing is sent', async () => {
  const s = setup({ funds: 30_000n }); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() }); await drive(s, r, 3); const sum = r.summary();
  assert.match(sum.refused!, /balance 30000 is below the 40000/); assert.equal(sum.skipped, 4); assert.equal(sum.done, true); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('twap:')).length, 0);
});

test('price limit (buy): slices wait while the pool price is above the limit and are skipped once their window passes; nothing is bought at a worse price', async () => {
  const s = setup(); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ limitPriceE18: E18 / 2n }) }); await drive(s, r, 8); const sum = r.summary();
  assert.equal(sum.filled, 0); assert.equal(sum.skipped, 4); assert.match(sum.slices[0].reason!, /window passed.*above your limit/); assert.equal(s.chain.balance('w1', TOK), 0n);
  const ok = setup(); const r2 = new TwapRunner({ engine: ok.engine, chain: ok.p, spec: spec({ limitPriceE18: 2n * E18 }) }); await drive(ok, r2); assert.equal(r2.summary().filled, 4, 'a limit above the price lets every slice go');
});

test('price limit (sell): waits while the price is below the limit', async () => {
  const s = setup({ tokens: 40_000n }); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ side: 'sell', limitPriceE18: 2n * E18 }) }); await drive(s, r, 8);
  assert.equal(r.summary().filled, 0); assert.match(r.summary().slices[0].reason!, /below your limit/); assert.equal(s.chain.balance('w1', TOK), 40_000n, 'nothing sold');
});

test('impact limit: a slice that would move the pool more than allowed waits, then is skipped', async () => {
  const s = setup({ reserve: 20_000n }); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ maxSliceImpactBps: 100 }) }); await drive(s, r, 8); const sum = r.summary();
  assert.equal(sum.filled, 0); assert.match(sum.slices[0].reason!, /would move the price \d+ bps, above the 100 bps limit/);
});

test('a slice whose window passed (node was away) is skipped and reported; the later slices still go on schedule', async () => {
  const s = setup(); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() }); const t0 = s.chain.time;
  await round(s, r, 0); s.chain.time = t0 + 300 + 400; await drive(s, r, 1, 0);          // slice 1 (due t0+300, window 300) is missed; at t0+700 slice 2 (due t0+600) is still in window
  const sum = r.summary(); assert.equal(sum.slices[1].status, 'skipped'); assert.match(sum.slices[1].reason!, /window passed/); assert.equal(sum.slices[2].status, 'filled');
  s.chain.time = t0 + 900; await drive(s, r, 3); assert.equal(r.summary().filled, 3); assert.equal(r.summary().skipped, 1); assert.equal(r.summary().spent, 30_000n, 'the skipped slice is not made up later');
});

test('a slice refused by the wallet policy fails alone (continue) or stops the rest (stop)', async () => {
  const ok = setup({ maxPerTx: 12_000n }); const rOk = new TwapRunner({ engine: ok.engine, chain: ok.p, spec: spec({ total: 44_000n }) }); await drive(ok, rOk); assert.equal(rOk.summary().filled, 4, 'every 11,000 slice is inside the 12,000 limit');
  const s = setup({ maxPerTx: 9_000n }); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ onFailure: 'stop' }) }); await drive(s, r); const sum = r.summary();
  assert.equal(sum.slices[0].status, 'failed'); assert.ok(sum.slices[0].reason && sum.slices[0].reason.length > 0); assert.equal(sum.skipped, 3); assert.match(sum.slices[3].reason!, /stopped after an earlier slice failed/); assert.equal(sum.filled, 0);
  const s2 = setup({ maxPerTx: 9_000n }); const r2 = new TwapRunner({ engine: s2.engine, chain: s2.p, spec: spec() }); await drive(s2, r2); assert.equal(r2.summary().failed, 4, 'continue keeps trying each slice, each fails on its own');
});

test('cancel stops the schedule: unsent slices are skipped, filled ones stay filled, nothing more is sent', async () => {
  const s = setup(); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() }); await round(s, r); await round(s, r); r.cancel(); await drive(s, r, 4);
  const sum = r.summary(); assert.equal(sum.cancelled, true); assert.equal(sum.filled, 2); assert.equal(sum.skipped, 2); assert.equal(sum.slices[3].reason, 'cancelled'); assert.equal(sum.done, true); assert.equal(sum.spent, 20_000n);
});

test('node outage: no slice is sent while the node is unreachable, and the order carries on when it returns (a missed window is skipped, not rushed)', async () => {
  const s = setup(); const r = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec() }); await round(s, r);
  s.chain.rpcDown = true; const out = await r.tick(); assert.match(out.error!, /node unreachable/); assert.deepEqual(out.submitted, []);
  s.chain.rpcDown = false; await drive(s, r); assert.equal(r.summary().done, true); assert.ok(r.summary().filled >= 3);
});

test('durable: after a crash the same order resumes from disk with the same keys and never trades a slice twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'twap-')), file = join(dir, 'twap.json'), s = setup();
  const r1 = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec(), persistPath: file }); await round(s, r1); await round(s, r1);
  const r2 = new TwapRunner({ engine: s.engine, chain: s.p, spec: spec(), persistPath: file }); await r2.resume();               // "restart": new process objects, same engine store and file
  assert.equal(r2.summary().filled, 2); assert.equal(r2.startAt, r1.startAt, 'the schedule survives the restart'); await drive(s, r2);
  const sum = r2.summary(); assert.equal(sum.filled, 4); assert.equal(sum.spent, 40_000n); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('twap:t1:')).length, 4);
  assert.throws(() => new TwapRunner({ engine: s.engine, chain: s.p, spec: spec({ id: 'other' }), persistPath: file }), /belongs to twap order t1/);
});
