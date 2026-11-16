import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, TOK } from './fixtures.ts';
import { Engine, Router, Ledger, FeeCollector, NATIVE, Reservations, OrderManager, defaultTierConfig, enforce } from '../src/index.ts';
import type { FeeSchedule, Order } from '../src/index.ts';

const schedule: FeeSchedule = { chains: { 'sim-evm': { mode: 'in-tx', sweepMin: 0n, bps: { free: 100, premium: 50, default: 100 } } } };
function tiered(tiers: Record<string, string>) {
  const w = world(); const ledger = new Ledger(); const collector = new FeeCollector(ledger, schedule);
  const engine = new Engine({ store: w.store, chain: w.chain, signer: w.signer, router: new Router(w.chain), platformFeeBps: 999,
    fees: { schedule, collector, tierOf: u => tiers[u] ?? 'free' } });
  return { ...w, engine, ledger };
}

test('fee rate comes from the schedule by user tier, not the flat default', async () => {
  const t = tiered({ u1: 'premium' });
  await t.engine.submit(t.intent({ idempotencyKey: 'p1', amountIn: 10_000n })); t.chain.mine(4);
  const r = await t.engine.advance('p1'); assert.equal(r.state, 'finalized'); assert.equal(r.fill!.platformFee, 50n);   // 0.5%, not 1% or 9.99%
  const f = tiered({}); await f.engine.submit(f.intent({ idempotencyKey: 'f1', amountIn: 10_000n })); f.chain.mine(4);
  assert.equal((await f.engine.advance('f1')).fill!.platformFee, 100n);
});

test('fee is booked to the ledger only when FINAL, exactly once, and matches the on-chain fee', async () => {
  const t = tiered({ u1: 'premium' });
  await t.engine.submit(t.intent({ idempotencyKey: 'b1', amountIn: 10_000n })); t.chain.mine(1);
  assert.equal((await t.engine.advance('b1')).state, 'confirmed'); assert.equal(t.ledger.balance('revenue', NATIVE), 0n);     // not yet
  t.chain.mine(3); const r = await t.engine.advance('b1'); await t.engine.advance('b1'); await t.engine.submit(t.intent({ idempotencyKey: 'b1', amountIn: 10_000n }));
  assert.equal(r.state, 'finalized'); assert.equal(t.ledger.balance('revenue', NATIVE), r.fill!.platformFee);                     // once, equal to chain fee
  assert.equal(t.ledger.total(NATIVE), 0n);
});

test('failed and reverted trades book no platform fee', async () => {
  const t = tiered({}); const r = await t.engine.submit(t.intent({ idempotencyKey: 'x', amountIn: 10_000n, tokenOut: '0xHONEY', tokenIn: '0xHONEY' }));
  assert.equal(r.state, 'failed'); assert.equal(t.ledger.balance('revenue', NATIVE), 0n);
});

test('fee above the user fee limit is rejected before anything is sent', async () => {
  const t = tiered({}); const r = await t.engine.submit(t.intent({ idempotencyKey: 'lim', maxFeeBps: 50 }));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /fee limit/); assert.equal(t.chain.mempool.size, 0);
});

test('plan limit gate stops order number N+1 with a clear reason', () => {
  const w = world(); w.chain.credit('w1', TOK, 10_000n); const res = new Reservations((a, b) => w.chain.balance(a, b)); const cfg = defaultTierConfig();
  const mgr = new OrderManager(res, () => {}, () => w.chain.time, () => Date.now(), (o, active) => enforce(cfg, 'free', 'limitOrders', active));
  const mk = (id: string): Order => ({ id, userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, kind: 'limit_sell', amount: 100n, triggerPriceE18: 2n * 10n ** 18n,
    expiresAt: w.chain.time + 1000, maxQuoteAgeMs: 1000, minLiquidity: 1n, maxDeviationBps: 300, maxAttempts: 1, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0 });
  for (const id of ['a', 'b', 'c']) mgr.place(mk(id));                       // free plan allows 3
  assert.throws(() => mgr.place(mk('d')), /plan limit: limitOrders limit 3 reached on free/);
});
