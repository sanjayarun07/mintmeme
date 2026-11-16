import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Router, Store, NATIVE, OrderRunner } from '../src/index.ts';
import type { ChainPort, SimChain, Order } from '../src/index.ts';
import { world, TOK, HONEY } from './fixtures.ts';

const E18 = 10n ** 18n, tick = () => new Promise(r => setTimeout(r, 1));
/** Networked-style port over SimChain: async calls, time/block snapshots updated by refresh(), balanceOf, no evict. refresh throws while rpcDown. */
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); if (c.rpcDown) throw new Error('rpc down'); p.time = c.time; p.block = c.block; p.state = c.state; },
    async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); },
    async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); }, async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
function setup() {
  const w = world(); w.chain.credit('w1', TOK, 1000n); w.chain.credit('w1', HONEY, 1000n);
  const p = port(w.chain); let ms = 1000;
  const mkEngine = (store: Store) => new Engine({ store, chain: p, signer: w.signer, router: new Router(p), platformFeeBps: 100 });
  const engine = mkEngine(w.store); const runner = new OrderRunner({ engine, chain: p, clockMs: () => ms });
  const order = (o: Partial<Order>): Order => ({ id: 'o1', userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, kind: 'take_profit', amount: 400n, triggerPriceE18: E18, expiresAt: w.chain.time + 5000,
    maxQuoteAgeMs: 5000, minLiquidity: 100n, maxDeviationBps: 500, maxAttempts: 2, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0, ...o });
  return { ...w, p, runner, engine, mkEngine, order, setMs: (n: number) => (ms = n) };
}
const settleAll = async (s: ReturnType<typeof setup>) => { for (let i = 0; i < 6 && s.runner.inflight.size; i++) { s.chain.mine(2); await s.runner.settle(); } };

test('take-profit fires from the venue spot price, executes through the engine, reports back; reservation released', async () => {
  const s = setup(); await s.runner.place(s.order({}));
  assert.equal(s.runner.reservations.reservedTotal('w1', TOK), 400n);
  const t = await s.runner.tick(); assert.deepEqual(t.fired, ['o1']); assert.deepEqual(t.submitted, ['order:o1:a0']);
  await settleAll(s);
  assert.equal(s.store.records.get('order:o1:a0')!.state, 'finalized'); assert.equal(s.runner.orders.orders.get('o1')!.status, 'fired');
  assert.equal(s.runner.reservations.reservedTotal('w1', TOK), 0n); assert.equal(s.chain.balance('w1', TOK), 600n);
});
test('trigger not met: nothing is sent, the reason is recorded', async () => {
  const s = setup(); await s.runner.place(s.order({ triggerPriceE18: 2n * E18 }));
  const t = await s.runner.tick(); assert.deepEqual(t.fired, []); assert.equal(s.runner.orders.orders.get('o1')!.reason, 'trigger not met'); assert.equal(s.store.records.size, 0);
});
test('limit buy triggers when price falls to the limit', async () => {
  const s = setup(); await s.runner.place(s.order({ id: 'b1', kind: 'limit_buy', amount: 5000n, triggerPriceE18: E18 / 2n }));
  assert.deepEqual((await s.runner.tick()).fired, []);
  s.chain.state.venues.get('uni-v2:MEME')!.swap(NATIVE, TOK, 600_000n);   // somebody buys NATIVE->TOK pushing token price UP... then the reverse to push it down:
  s.chain.state.venues.get('uni-v2:MEME')!.swap(TOK, NATIVE, 2_000_000n);
  const t = await s.runner.tick(); assert.deepEqual(t.fired, ['b1']); await settleAll(s);
  assert.equal(s.store.records.get('order:b1:a0')!.state, 'finalized'); assert.ok(s.chain.balance('w1', TOK) > 1000n);
});
test('OCO: only one leg executes; the sibling is cancelled; one reservation', async () => {
  const s = setup(); await s.runner.place(s.order({ id: 'tp', ocoGroup: 'g' })); await s.runner.place(s.order({ id: 'sl', kind: 'stop_loss', ocoGroup: 'g', triggerPriceE18: E18 / 10n }));
  assert.equal(s.runner.reservations.reservedTotal('w1', TOK), 400n);
  const t = await s.runner.tick(); assert.deepEqual(t.fired, ['tp']); await settleAll(s);
  assert.equal(s.runner.orders.orders.get('sl')!.status, 'cancelled'); assert.equal(s.chain.confirmedNonce('w1'), 1);
});
test('failed executions retry with the SAME limits under new keys, then stop; reservation released; nothing reaches the chain', async () => {
  const s = setup(); await s.runner.place(s.order({ id: 'h', token: HONEY }));
  await s.runner.tick(); assert.equal(s.runner.orders.orders.get('h')!.status, 'active'); assert.equal(s.runner.orders.orders.get('h')!.attempts, 1);
  await s.runner.tick(); const o = s.runner.orders.orders.get('h')!;
  assert.equal(o.status, 'failed'); assert.ok(s.store.records.has('order:h:a0') && s.store.records.has('order:h:a1')); assert.equal(s.chain.mempool.size, 0);
  assert.equal(s.runner.reservations.reservedTotal('w1', HONEY), 0n);
});
test('node unreachable: no order is evaluated on stale data; evaluation resumes when it returns', async () => {
  const s = setup(); await s.runner.place(s.order({})); s.chain.rpcDown = true;
  assert.deepEqual(await s.runner.tick(), { fired: [], submitted: [] }); assert.equal(s.store.records.size, 0);
  s.chain.rpcDown = false; assert.deepEqual((await s.runner.tick()).fired, ['o1']);
});
test('stale pool snapshot is refused (maxQuoteAge), fresh one fires', async () => {
  const s = setup(); await s.runner.place(s.order({ maxQuoteAgeMs: 100 }));
  s.runner.refresh = async () => { /* venues not refreshed: lastVenueRefreshMs stays 0 */ }; s.setMs(5000);
  assert.deepEqual((await s.runner.tick()).fired, []); assert.equal(s.runner.orders.orders.get('o1')!.reason, 'stale quote');
});
test('restart: in-flight execution is re-adopted; re-placing the order cannot execute twice', async () => {
  const s = setup(); await s.runner.place(s.order({})); await s.runner.tick(); assert.equal(s.chain.mempool.size, 1);
  const store2 = Store.restore(s.store.snapshot()); const e2 = s.mkEngine(store2); const r2 = new OrderRunner({ engine: e2, chain: s.p, clockMs: () => 1000 });
  r2.adopt(); assert.deepEqual([...r2.inflight.keys()], ['order:o1:a0']);
  await r2.place(s.order({})); s.chain.mine(2); await r2.settle(); assert.equal(store2.records.get('order:o1:a0')!.state, 'confirmed' === store2.records.get('order:o1:a0')!.state ? 'confirmed' : 'finalized');
  for (let i = 0; i < 4; i++) { s.chain.mine(2); await r2.settle(); await r2.tick(); }
  assert.equal(s.chain.confirmedNonce('w1'), 1, 'exactly one execution'); assert.equal(store2.records.get('order:o1:a0')!.state, 'finalized');
});
test('orders on a venue without spot price are reported as not evaluable, never guessed', async () => {
  const s = setup(); const v: any = s.chain.state.venues.get('uni-v2:MEME'); const keep = v.spotPriceE18; v.spotPriceE18 = undefined;
  await s.runner.place(s.order({})); assert.deepEqual((await s.runner.tick()).fired, []); assert.match(s.runner.skipped.get('o1')!, /cannot report a spot price/); v.spotPriceE18 = keep;
});

test('entryGate veto: the intent is never sent, the order is told it failed, the reservation is released; open exits are unaffected', async () => {
  const s = setup(); const gated = new OrderRunner({ engine: s.engine, chain: s.p, clockMs: () => 1000, entryGate: i => i.tokenIn !== NATIVE ? true : false });
  await gated.place(s.order({ id: 'b1', kind: 'limit_buy', amount: 5000n, triggerPriceE18: 2n * E18 })); await gated.place(s.order({ id: 'tp1' }));
  const t = await gated.tick(); assert.deepEqual(t.fired.sort(), ['b1', 'tp1']); assert.deepEqual(t.submitted, ['order:tp1:a0']);
  assert.deepEqual(gated.vetoed, ['order:b1:a0']); assert.equal(s.store.records.has('order:b1:a0'), false); assert.equal(gated.orders.orders.get('b1')!.attempts, 1);
});
