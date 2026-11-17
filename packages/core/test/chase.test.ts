/** Slippage chase: an opted-in order retries a failed fill with more slippage each attempt, capped; an order without chase keeps its slippage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, TOK } from './fixtures.ts';
import { NATIVE, Reservations, OrderManager, slippageFor } from '../src/index.ts';
import type { Order, Intent } from '../src/index.ts';

const E18 = 10n ** 18n;
function setup() {
  const w = world(); w.chain.credit('w1', TOK, 1000n);
  const res = new Reservations((wl, t) => w.chain.balance(wl, t)); const ran: Intent[] = [];
  const mgr = new OrderManager(res, i => ran.push(i), () => w.chain.time, () => 1000);
  const order = (o: Partial<Order>): Order => ({ id: 'o', userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, kind: 'limit_sell', amount: 400n,
    triggerPriceE18: 2n * E18, expiresAt: w.chain.time + 1000, maxQuoteAgeMs: 500, minLiquidity: 0n, maxDeviationBps: 300, maxAttempts: 4, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0, ...o });
  const hit = () => mgr.tick(() => ({ priceE18: 3n * E18, ts: 1000, liquidity: 1000n, executableOut: od => od.amount * 3n }));
  return { mgr, ran, order, hit };
}

test('slippageFor: original without chase; +step per attempt with chase, capped at the maximum and never below the original', () => {
  assert.equal(slippageFor({ slippageBps: 300, attempts: 5 }), 300);
  const c = { stepBps: 100, maxBps: 500 };
  assert.deepEqual([0, 1, 2, 3, 9].map(attempts => slippageFor({ slippageBps: 300, attempts, chase: c })), [300, 400, 500, 500, 500]);
  assert.equal(slippageFor({ slippageBps: 300, attempts: 1, chase: { stepBps: 100, maxBps: 200 } }), 300);
});

test('a chase order sends 3%, 4%, 5%, 5% on successive failed fills, then is marked failed', () => {
  const { mgr, ran, order, hit } = setup();
  mgr.place(order({ chase: { stepBps: 100, maxBps: 500 } }));
  for (let i = 0; i < 4; i++) { assert.deepEqual(hit(), ['o']); mgr.onResult('o', false); }
  assert.deepEqual(ran.map(i => i.slippageBps), [300, 400, 500, 500]);
  assert.deepEqual(new Set(ran.map(i => i.idempotencyKey)).size, 4, 'each attempt has its own idempotency key');
  assert.equal(mgr.orders.get('o')!.status, 'failed');
});

test('an order without chase retries at the same slippage', () => {
  const { mgr, ran, order, hit } = setup();
  mgr.place(order({}));
  for (let i = 0; i < 3; i++) { hit(); mgr.onResult('o', false); }
  assert.deepEqual(ran.map(i => i.slippageBps), [300, 300, 300]);
});

test('a chase order that fills on the second attempt stops there', () => {
  const { mgr, ran, order, hit } = setup();
  mgr.place(order({ chase: { stepBps: 100, maxBps: 500 } }));
  hit(); mgr.onResult('o', false); hit(); mgr.onResult('o', true);
  assert.deepEqual(ran.map(i => i.slippageBps), [300, 400]); assert.deepEqual(hit(), []);
});

test('editing a trigger moves it in place: same reservation, and the order fires at the new price, not the old one', () => {
  const { mgr, order, hit, ran } = setup();
  mgr.place(order({ triggerPriceE18: 2n * E18 }));
  mgr.retrigger('o', 4n * E18);
  assert.deepEqual(hit(), [], 'price 3 no longer meets the moved trigger of 4');
  assert.equal(mgr.orders.get('o')!.reason, 'trigger not met'); assert.equal(ran.length, 0);
  mgr.retrigger('o', 3n * E18); assert.deepEqual(hit(), ['o']);
});

test('editing is refused for non-active orders, trailing stops, zero prices, and a bracket take profit below its stop loss', () => {
  const { mgr, order } = setup();
  mgr.place(order({ id: 'tp', kind: 'take_profit', ocoGroup: 'g', triggerPriceE18: 3n * E18 }));
  mgr.place(order({ id: 'sl', kind: 'stop_loss', ocoGroup: 'g', triggerPriceE18: 1n * E18 }));
  assert.throws(() => mgr.retrigger('tp', E18 / 2n), /take profit must stay above/);
  assert.throws(() => mgr.retrigger('sl', 4n * E18), /stop loss must stay below/);
  assert.throws(() => mgr.retrigger('tp', 0n), /above zero/);
  mgr.retrigger('sl', E18 * 3n / 2n); assert.equal(mgr.orders.get('sl')!.triggerPriceE18, E18 * 3n / 2n);
  mgr.cancel('tp'); assert.throws(() => mgr.retrigger('tp', 5n * E18), /only an active order/);
  mgr.place(order({ id: 'tr', kind: 'trailing_stop', trailBps: 2000, triggerPriceE18: undefined, amount: 100n }));
  assert.throws(() => mgr.retrigger('tr', E18), /trailing stop/);
});
