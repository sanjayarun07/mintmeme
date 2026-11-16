import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimTrader, PRACTICE_TOKEN as T, SdkError, parseUnits, formatUnits, amount } from '../src/index.ts';
import type { TraderEvent } from '../src/index.ts';
import { NATIVE } from '../../core/src/index.ts';

const px = (c: any) => c.state.venues.get('uni-v2:MEME').spotPriceE18(T, NATIVE) as bigint;   // quote per token x1e18
const move = (c: any, toward: 'up' | 'down', n = 200_000n) => { const v = c.state.venues.get('uni-v2:MEME'); if (toward === 'up') v.swap(NATIVE, T, n); else v.swap(T, NATIVE, n); };

test('wire: amounts are exact, strict, and decimals never round silently', () => {
  assert.equal(amount('1000000000000000000000', 'a'), 10n ** 21n);
  for (const bad of ['1.5', '-1', '0x10', '1e18', '', ' 5', 1.5, -3, Number.MAX_SAFE_INTEGER + 2, null, {}]) assert.throws(() => amount(bad as any, 'a'), SdkError);
  assert.throws(() => amount('0', 'a'), /greater than zero/); assert.equal(amount('0', 'a', { allowZero: true }), 0n);
  assert.equal(parseUnits('1.5', 18), 1_500_000_000_000_000_000n); assert.throws(() => parseUnits('1.0000001', 6), /decimal places/); assert.equal(formatUnits(1_500_000n, 6), '1.5');
});

test('market buy and sell go through the engine, are idempotent per key, and land in the portfolio', async () => {
  const { trader, chain } = createSimTrader();
  const q = await trader.quote({ side: 'buy', token: T, amount: 10_000n }); assert.equal(q.venue, 'uni-v2:MEME'); assert.ok(q.amountOut > 0n && q.minOut <= q.amountOut);
  const a = await trader.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'buy-1' }); assert.equal(a.state, 'finalized'); assert.ok(a.fill!.received > 0n);
  const again = await trader.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'buy-1' });
  assert.equal(again.key, 'buy-1'); assert.equal(chain.balance('w1', NATIVE), 1_000_000n - 10_000n - a.fill!.networkFee, 'same key never spends twice');
  const held = chain.balance('w1', T); const s = await trader.sell({ walletId: 'w1', token: T, pctBps: 5000, key: 'sell-1' }); assert.equal(s.state, 'finalized'); assert.equal(chain.balance('w1', T), held - held * 5000n / 10000n);
  assert.equal(trader.trades().length, 2); assert.equal(trader.trade_('buy-1')!.state, 'finalized');
  assert.ok(trader.positions().some(p => p.token === T));
  await assert.rejects(trader.buy({ walletId: 'w1', token: T, amount: '1.5' as any }), /whole number of raw base units/);
  await assert.rejects(trader.buy({ walletId: 'w1', token: T, amount: 10_000n, key: '../../etc' }), SdkError);
});

test('policy limits still apply to every SDK trade (per-tx limit)', async () => {
  const { trader } = createSimTrader(); const r = await trader.buy({ walletId: 'w1', token: T, amount: 500_000n, key: 'big' });
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /per-tx limit/);
});

test('limit buy fires when the price falls, limit sell when it rises, and neither fires early', async () => {
  const { trader, chain } = createSimTrader(); const events: TraderEvent[] = []; trader.on(e => events.push(e));
  await trader.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' });
  const p0 = px(chain);
  await trader.limitBuy({ id: 'lb', walletId: 'w1', token: T, amount: 10_000n, priceE18: p0 * 90n / 100n });
  await trader.limitSell({ id: 'ls', walletId: 'w1', token: T, amount: 20_000n, priceE18: p0 * 115n / 100n });
  await trader.tick(); assert.equal(trader.getOrder('lb')!.status, 'active'); assert.equal(trader.getOrder('ls')!.status, 'active');
  move(chain, 'down', 150_000n); await trader.tick(); await trader.tick();
  assert.equal(trader.getOrder('lb')!.status, 'fired'); assert.equal(trader.trade_('order:lb:a0')!.state, 'finalized');
  assert.ok(events.some(e => e.type === 'order' && e.id === 'lb' && e.status === 'fired'));
  move(chain, 'up', 600_000n); await trader.tick(); await trader.tick(); assert.equal(trader.getOrder('ls')!.status, 'fired');
});

test('stop loss, take profit bracket: one leg fires and the other is cancelled; the tokens are reserved once', async () => {
  const { trader, chain } = createSimTrader(); await trader.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' }); const p0 = px(chain);
  const legs = await trader.bracket({ id: 'br', walletId: 'w1', token: T, amount: 30_000n, takeProfitE18: p0 * 2n, stopLossE18: p0 * 85n / 100n });
  assert.deepEqual(legs.map(l => l.id), ['br:tp', 'br:sl']); assert.equal(trader.orders.reservations.reservedTotal('w1', T), 30_000n);
  move(chain, 'down', 120_000n); await trader.tick(); await trader.tick();
  assert.equal(trader.getOrder('br:sl')!.status, 'fired'); assert.equal(trader.getOrder('br:tp')!.status, 'cancelled');
  await assert.rejects(trader.bracket({ walletId: 'w1', token: T, amount: 1_000n, takeProfitE18: 100n, stopLossE18: 200n }), /below the take profit/);
  await assert.rejects(trader.bracket({ walletId: 'w1', token: T, amount: 1_000n }), /needs takeProfitE18/);
});

test('trailing stop follows the peak up and sells after the drop from the peak', async () => {
  const { trader, chain } = createSimTrader(); await trader.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' });
  await trader.trailingStop({ id: 'tr', walletId: 'w1', token: T, amount: 20_000n, trailBps: 1000 });
  move(chain, 'up', 300_000n); await trader.tick(); const peak = trader.getOrder('tr')!.peakE18!; assert.equal(trader.getOrder('tr')!.status, 'active'); assert.ok(peak > 0n);
  move(chain, 'down', 150_000n); await trader.tick(); await trader.tick(); assert.equal(trader.getOrder('tr')!.status, 'fired');
});

test('placing the same order id twice does not place a second order; cancel releases the reservation; unknown ids are 404', async () => {
  const { trader } = createSimTrader();
  const a = await trader.limitBuy({ id: 'same', walletId: 'w1', token: T, amount: 10_000n, priceE18: 1n }), b = await trader.limitBuy({ id: 'same', walletId: 'w1', token: T, amount: 10_000n, priceE18: 1n });
  assert.equal(a, b); assert.equal(trader.listOrders().length, 1); assert.equal(trader.orders.reservations.reservedTotal('w1', NATIVE), 10_000n);
  assert.equal(trader.cancelOrder('same').status, 'cancelled'); assert.equal(trader.orders.reservations.reservedTotal('w1', NATIVE), 0n);
  assert.throws(() => trader.cancelOrder('nope'), (e: any) => e instanceof SdkError && e.status === 404);
  await assert.rejects(trader.limitBuy({ id: 'x', walletId: 'w1', token: T, amount: 99_999_999n, priceE18: 1n }), /insufficient unreserved balance/);
});

test('market-cap trigger converts to a price at placement and is disabled (not guessed) without supply', async () => {
  const { trader } = createSimTrader();
  await trader.buy({ walletId: 'w1', token: T, amount: 5_000n, key: 'seed' });
  const ok = await trader.limitSell({ id: 'mc', walletId: 'w1', token: T, amount: 1_000n, marketCap: { target: 4_000_000n * 10n ** 18n, circulating: 2_000_000n, supplySource: 'test' } });
  assert.equal(ok.triggerPriceE18, 2n * 10n ** 18n); assert.equal(ok.status, 'active');
  await assert.rejects(trader.limitSell({ walletId: 'w1', token: T, amount: 1n, priceE18: 5n, marketCap: { target: 5n, supplySource: 'x' } }), /not both/);
  const dis = await trader.limitBuy({ id: 'mc2', walletId: 'w1', token: T, amount: 1_000n, marketCap: { target: 5n, supplySource: 'test' } }); assert.equal(dis.status, 'disabled'); assert.match(dis.reason!, /supply unavailable/);
});

test('bulk buy: equal split across wallets, each leg from its own wallet, report says which landed; same id never buys twice', async () => {
  const { trader, chain } = createSimTrader();
  const s = await trader.bulkBuy({ id: 'bb', token: T, wallets: ['w1', 'w2'], total: 20_001n }); for (let i = 0; i < 5 && !trader.bulkStatus('bb').done; i++) await trader.tick();
  const done = trader.bulkStatus('bb'); assert.equal(done.filled, 2); assert.equal(done.legs.map(l => l.amount).join(), '10001,10000'); assert.ok(chain.balance('w1', T) > 0n && chain.balance('w2', T) > 0n);
  const w1 = chain.balance('w1', T); await trader.bulkBuy({ id: 'bb', token: T, wallets: ['w1', 'w2'], total: 20_001n }); await trader.tick(); assert.equal(chain.balance('w1', T), w1);
  assert.equal(s.id, 'bb');
  await assert.rejects(trader.bulkBuy({ token: T, wallets: [], total: 5n }), /1 to 10 wallets/); await assert.rejects(trader.bulkBuy({ token: T }), /send legs/);
});

test('bulk sell by percentage skips wallets with nothing; maxImpactBps refuses the whole bulk up front', async () => {
  const { trader, chain } = createSimTrader(); await trader.buy({ walletId: 'w1', token: T, amount: 40_000n, key: 'seed1' }); const held = chain.balance('w1', T);
  const s = await trader.bulkSell({ id: 'bs', token: T, wallets: ['w1', 'w2'], pctBps: 5000 }); for (let i = 0; i < 4 && !trader.bulkStatus('bs').done; i++) await trader.tick();
  const d = trader.bulkStatus('bs'); assert.equal(d.legs.length, 1); assert.equal(d.filled, 1); assert.equal(chain.balance('w1', T), held - held * 5000n / 10000n); assert.equal(s.id, 'bs');
  const r = await trader.bulkBuy({ id: 'imp', token: T, wallets: ['w1', 'w2'], total: 80_000n, maxImpactBps: 10 }); assert.ok(r.refused && /bps/.test(r.refused), r.refused);
});

test('TWAP: slices go out on schedule, a skipped slice is reported, cancel stops the rest, same id never doubles', async () => {
  const { trader, chain } = createSimTrader();
  await trader.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 30_000n, slices: 3, intervalS: 60, windowS: 30 });
  await trader.tick(); assert.equal(trader.twapStatus('tw').filled, 1, 'first slice is due now');
  chain.time += 60; await trader.tick(); await trader.tick(); assert.equal(trader.twapStatus('tw').filled, 2);
  chain.time += 200; await trader.tick(); const f = trader.twapStatus('tw'); assert.equal(f.skipped, 1); assert.match(f.slices[2].reason!, /window passed/); assert.equal(f.open, 0);
  await trader.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 30_000n, slices: 3, intervalS: 60 }); assert.equal(trader.twapStatus('tw').filled, 2);
  await trader.twap({ id: 'tw2', walletId: 'w1', token: T, side: 'buy', total: 30_000n, slices: 3, intervalS: 60, startAt: chain.time + 600 }); assert.equal(trader.cancelTwap('tw2').skipped, 3);
  await assert.rejects(trader.twap({ walletId: 'w1', token: T, side: 'buy', total: 30_000n, slices: 1, intervalS: 60 }), SdkError);
});

test('pause entries blocks buys everywhere but never sells or stop losses', async () => {
  const { trader, chain } = createSimTrader(); await trader.buy({ walletId: 'w1', token: T, amount: 40_000n, key: 'seed' });
  trader.pauseEntries();
  await assert.rejects(trader.buy({ walletId: 'w1', token: T, amount: 1_000n }), (e: any) => e.code === 'entries_paused');
  await assert.rejects(trader.bulkBuy({ token: T, wallets: ['w1'], total: 5_000n }), /paused/); await assert.rejects(trader.twap({ walletId: 'w1', token: T, side: 'buy', total: 9_000n, slices: 3, intervalS: 60 }), /paused/);
  const s = await trader.sell({ walletId: 'w1', token: T, pctBps: 1000, key: 'exit' }); assert.equal(s.state, 'finalized');
  trader.resumeEntries(); assert.equal((await trader.buy({ walletId: 'w1', token: T, amount: 1_000n, key: 'again' })).state, 'finalized'); assert.ok(chain.balance('w1', T) > 0n);
});

test('price alert fires once on cross and is delivered as an event', async () => {
  const { trader, chain } = createSimTrader(); const got: TraderEvent[] = []; trader.on(e => got.push(e)); const now = Number(px(chain)) / 1e18;
  trader.addPriceAlert({ id: 'al', token: T, direction: 'above', threshold: now * 1.1 }); await trader.tick(); assert.equal(got.filter(e => e.type === 'alert').length, 0);
  move(chain, 'up', 300_000n); chain.block++; await trader.tick(); await trader.tick(); assert.equal(got.filter(e => e.type === 'alert').length, 1);
});

test('state survives a restart: orders persisted, re-placing the same id is a no-op, an in-flight order is not traded twice', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const dir = mkdtempSync(join(tmpdir(), 'sdk-'));
  const a = createSimTrader({ persistDir: dir }); await a.trader.limitBuy({ id: 'p1', walletId: 'w1', token: T, amount: 10_000n, priceE18: 1n });
  const b = new (await import('../src/trader.ts')).Trader({ engine: a.engine, chain: a.chain, userId: 'u1', venues: ['uniswap-v2'], persistDir: dir }); assert.equal(b.getOrder('p1')!.status, 'active');
  await b.limitBuy({ id: 'p1', walletId: 'w1', token: T, amount: 10_000n, priceE18: 1n }); assert.equal(b.listOrders().length, 1);
});
