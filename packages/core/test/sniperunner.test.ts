import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, NATIVE, OrderRunner, SnipeRunner } from '../src/index.ts';
import type { ChainPort, SimChain, LaunchEvent, LaunchSource, SnipeConfig } from '../src/index.ts';
import { world, TOK } from './fixtures.ts';

const tick = () => new Promise(r => setTimeout(r, 1));
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); if (c.rpcDown) throw new Error('rpc down'); p.time = c.time; p.block = c.block; p.state = c.state; },
    async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); }, async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); },
    async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
class FakeLaunches implements LaunchSource {
  cursor = 0; reorg: { chain: string; txHash: string }[] = []; pairs = new Map<string, { pair: string }>(); fail = false;
  constructor(public script: LaunchEvent[]) {}
  async poll() { if (this.fail) throw new Error('scan failed'); const events = this.script.slice(this.cursor); this.cursor = this.script.length; const reorged = this.reorg; this.reorg = []; return { events, reorged }; }
  snapshot() { return { cursor: this.cursor }; } load(s: any) { this.cursor = s.cursor; }
}
const launchEvents = (token = TOK, venueId = 'uni-v2:MEME', liq = 1_000_000n): LaunchEvent[] => [
  { type: 'pool-created', chain: 'sim-evm', token, txHash: '0xL1', logIndex: 0, block: 1, venueId },
  { type: 'liquidity-added', chain: 'sim-evm', token, txHash: '0xL1', logIndex: 1, block: 1, venueId, quoteLiquidity: liq }];
const cfg = (o: Partial<SnipeConfig> = {}): SnipeConfig => ({ userId: 'u1', walletId: 'w1', chain: 'sim-evm', quoteToken: NATIVE, venues: ['uniswap-v2'], maxSpend: 20_000n, delayBlocks: 0, minLiquidity: 100n,
  maxTaxBps: 500, maxAttempts: 2, slippageBps: 300, exit: { takeProfitBps: 1000, stopLossBps: 1000 }, ...o });
function setup(script: LaunchEvent[], c = cfg(), opts: { persist?: string; store?: Store } = {}) {
  const w = world(); const p = port(w.chain); const source = new FakeLaunches(script); const store = opts.store ?? w.store;
  const engine = new Engine({ store, chain: p, signer: w.signer, router: new Router(p), platformFeeBps: 100 });
  const orders = new OrderRunner({ engine, chain: p, clockMs: () => Date.now() });
  const runner = new SnipeRunner({ engine, chain: p, source, cfg: c, orders, persistPath: opts.persist });
  return { ...w, store, p, source, engine, orders, runner };
}
const settleAll = async (s: { chain: SimChain; runner: SnipeRunner }) => { for (let i = 0; i < 8 && s.runner.inflight.size; i++) { s.chain.mine(2); await s.runner.settle(); } };

test('detected pool with liquidity: dry-run passes, buy goes through the engine, fill recorded, exits placed as ONE OCO pair with the tokens reserved', async () => {
  const s = setup(launchEvents()); const t = await s.runner.tick(); assert.equal(t.submitted.length, 1); assert.match(t.submitted[0], /^snipe:w1:sim-evm:0xMEME:a1$/);
  await settleAll(s); const r = s.store.records.get(t.submitted[0])!; assert.equal(r.state, 'finalized'); assert.equal(r.intent.origin, 'snipe'); assert.equal(r.intent.amountIn, 20_000n);
  const lk = `sim-evm:${TOK}`; assert.equal(s.runner.sniper.state(lk).done, true); assert.equal(s.runner.results.get(lk)!.tokens, r.fill!.received);
  const ids = [...s.orders.orders.orders.keys()].sort(); assert.deepEqual(ids, [`snipe:${lk}:sl`, `snipe:${lk}:tp`]);
  assert.equal(s.orders.reservations.reservedTotal('w1', TOK), r.fill!.received);   // one reservation for the OCO pair, not two
  await s.runner.tick(); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('snipe:')).length, 1);   // never buys again
});
test('trading not open yet: the dry-run revert is waited out (reason shown, NO attempt consumed), then it buys once open', async () => {
  const s = setup(launchEvents()); s.chain.tokens.set(TOK, { tradingOpenBlock: s.chain.block + 5 });
  let t = await s.runner.tick(); assert.equal(t.submitted.length, 0); assert.match(s.runner.status.get(`sim-evm:${TOK}`)!, /not tradable yet: trading not enabled/);
  assert.equal(s.runner.sniper.state(`sim-evm:${TOK}`).attempts.length, 0);
  s.chain.mine(6); t = await s.runner.tick(); assert.equal(t.submitted.length, 1); await settleAll(s); assert.equal(s.runner.sniper.state(`sim-evm:${TOK}`).done, true);
});
test('pool without enough liquidity, or only a pool-created event, is not bought', async () => {
  const a = setup(launchEvents(), cfg({ minLiquidity: 10n ** 9n })); await a.runner.tick(); assert.equal(a.store.records.size, 0); assert.match(a.runner.status.get(`sim-evm:${TOK}`)!, /liquidity-low/);
  const b = setup([launchEvents()[0]]); await b.runner.tick(); assert.equal(b.store.records.size, 0); assert.match(b.runner.status.get(`sim-evm:${TOK}`)!, /launch detected/);
});
test('launch reorged out before we act is revoked: nothing is bought even once trading opens', async () => {
  const s = setup(launchEvents()); s.chain.tokens.set(TOK, { tradingOpenBlock: s.chain.block + 5 });
  await s.runner.tick(); assert.equal(s.store.records.size, 0);                                   // seen, but not tradable yet
  s.source.reorg = [{ chain: 'sim-evm', txHash: '0xL1' }]; s.chain.mine(6); const t = await s.runner.tick();
  assert.equal(t.submitted.length, 0); assert.match(s.runner.status.get(`sim-evm:${TOK}`)!, /launch revoked/); assert.equal(s.store.records.size, 0);
});
test('the honest risk report says what was NOT checked, and a high measured buy tax is recorded after the fill', async () => {
  const s = setup(launchEvents()); await s.runner.tick(); await settleAll(s);
  const rep = s.runner.sniper.cfg.riskCheck!({ key: `sim-evm:${TOK}`, token: TOK } as any, 1n, {} as any); assert.equal(rep.verdict, 'warn'); assert.match(rep.flags[0], /NOT detected before the buy/);
  assert.equal(typeof s.runner.results.get(`sim-evm:${TOK}`)!.buyTaxBps, 'number');
});
test('scan failure / node down: nothing is bought, error reported, recovers', async () => {
  const s = setup(launchEvents()); s.source.fail = true; let t = await s.runner.tick(); assert.match(t.error!, /launch scan failed/); assert.equal(s.store.records.size, 0);
  s.source.fail = false; s.chain.rpcDown = true; t = await s.runner.tick(); assert.match(t.error!, /node unreachable/); s.chain.rpcDown = false;
  t = await s.runner.tick(); assert.equal(t.submitted.length, 1);
});
test('crash after the write-ahead checkpoint but before the hand-over: restart buys ONCE (same key), places exits once', async () => {
  const d = mkdtempSync(join(tmpdir(), 'memedesk-snipe-')); const ef = join(d, 'e.json'), sf = join(d, 's.json');
  const s1 = setup(launchEvents(), cfg(), { persist: sf, store: Store.open(ef) }); (s1.engine as any).submit = async () => { throw new Error('process killed'); };
  await assert.rejects(() => s1.runner.tick(), /process killed/); assert.equal(s1.runner.outbox.length, 1); assert.equal(s1.runner.sniper.state(`sim-evm:${TOK}`).attempts.length, 1);
  const s2 = setup(launchEvents(), cfg(), { persist: sf, store: Store.open(ef) }); assert.equal(s2.runner.outbox.length, 1); assert.equal(s2.source.cursor, 2);
  await s2.runner.resume(); await settleAll(s2); await s2.runner.tick();
  assert.equal([...s2.store.records.keys()].filter(k => k.startsWith('snipe:')).length, 1); assert.equal(s2.runner.sniper.state(`sim-evm:${TOK}`).done, true);
  assert.equal(s2.orders.orders.orders.size, 2);
});
test('crash BEFORE the checkpoint (old state file): launch re-read, SAME attempt key reused, still one buy', async () => {
  const d = mkdtempSync(join(tmpdir(), 'memedesk-snipe-')); const ef = join(d, 'e.json'), sf = join(d, 's.json');
  const s1 = setup(launchEvents(), cfg(), { persist: sf, store: Store.open(ef) }); s1.runner.checkpoint(); copyFileSync(sf, sf + '.old');
  await s1.runner.tick(); await settleAll(s1); copyFileSync(sf + '.old', sf);
  const s2 = setup(launchEvents(), cfg(), { persist: sf, store: Store.open(ef) }); assert.equal(s2.source.cursor, 0);
  await s2.runner.resume(); await s2.runner.tick(); await settleAll(s2);
  assert.equal([...s2.store.records.keys()].filter(k => k.startsWith('snipe:')).length, 1);
});
test('exit orders that cannot be placed are reported and do NOT wedge the runner', async () => {
  const s = setup(launchEvents()); await s.runner.tick(); (s.orders as any).place = async () => { throw new Error('insufficient unreserved balance (test)'); };
  await settleAll(s); const lk = `sim-evm:${TOK}`; assert.match(s.runner.exitErrors.get(lk)!, /insufficient unreserved/); assert.match(s.runner.status.get(lk)!, /exit orders were NOT placed/);
  assert.equal(s.runner.inflight.size, 0); await s.runner.tick();   // keeps ticking
});
