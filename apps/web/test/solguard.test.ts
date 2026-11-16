import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeGuard, limitsFromEnv, DEFAULT_LIMITS, GuardError } from '../solguard.ts';

const buy = (l: bigint, slip = 300) => ({ side: 'buy' as const, mint: 'M', lamports: l, slippageBps: slip, venue: 'jupiter', summary: {} });

test('limits default small and come from the environment; bad values are refused', () => {
  assert.equal(limitsFromEnv({}).maxTradeLamports, 10_000_000n);
  assert.equal(limitsFromEnv({ SOL_MAX_TRADE_LAMPORTS: '5000', SOL_DAILY_CAP_LAMPORTS: '20000', SOL_MAX_SLIPPAGE_BPS: '100' }).maxSlippageBps, 100);
  assert.throws(() => limitsFromEnv({ SOL_MAX_TRADE_LAMPORTS: '1e9' }), /whole number/);
  assert.throws(() => limitsFromEnv({ SOL_MAX_TRADE_LAMPORTS: '100', SOL_DAILY_CAP_LAMPORTS: '50' }), /at least/);
  assert.throws(() => limitsFromEnv({ SOL_MAX_SLIPPAGE_BPS: '9999' }), /0 to 5000/);
});

test('a buy above the per-trade limit or the slippage limit is refused before a ticket exists', () => {
  const g = new TradeGuard(DEFAULT_LIMITS);
  assert.throws(() => g.prepare(buy(10_000_001n)), /per-trade limit/);
  assert.throws(() => g.prepare(buy(1000n, 501)), /slippage/);
  assert.throws(() => g.prepare(buy(0n)), /above zero/);
  assert.ok(g.prepare(buy(10_000_000n, 500)).id);
});

test('a ticket can be redeemed once, expires, and the daily cap counts confirmed buys only', () => {
  let t = 1_000_000; const g = new TradeGuard({ ...DEFAULT_LIMITS, maxTradeLamports: 10n, dailyCapLamports: 25n }, () => t);
  const a = g.prepare(buy(10n)); assert.equal(g.spentToday(), 0n, 'preparing spends nothing');
  g.redeem(a.id); assert.equal(g.spentToday(), 10n); assert.throws(() => g.redeem(a.id), (e: any) => e instanceof GuardError && e.status === 409);
  const b = g.prepare(buy(10n)); g.redeem(b.id); assert.throws(() => g.prepare(buy(10n)), /daily cap/);
  const c = g.prepare(buy(5n)); t += 61_000; assert.throws(() => g.redeem(c.id), (e: any) => e.status === 410);
  t += 86_400_000; assert.equal(g.spentToday(), 0n, 'a new UTC day starts at zero');
});

test('the kill switch refuses new tickets and confirmations, survives a restart, and a refunded buy frees its cap', () => {
  let saved: any; const g = new TradeGuard(DEFAULT_LIMITS, Date.now, s => { saved = s; });
  const k = g.prepare(buy(1000n)); g.setKill(true);
  assert.throws(() => g.prepare(buy(1000n)), (e: any) => e.status === 423); assert.throws(() => g.redeem(k.id), (e: any) => e.status === 423);
  const g2 = new TradeGuard(DEFAULT_LIMITS, Date.now, () => {}, saved); assert.equal(g2.killed, true);
  g2.setKill(false); const t = g2.prepare(buy(1000n)); g2.redeem(t.id); assert.equal(g2.spentToday(), 1000n); g2.refund(t); assert.equal(g2.spentToday(), 0n);
});

test('a sell needs a valid percentage and uses no SOL budget', () => {
  const g = new TradeGuard(DEFAULT_LIMITS); const s = { side: 'sell' as const, mint: 'M', lamports: 0n, slippageBps: 300, venue: 'jupiter', summary: {} };
  assert.throws(() => g.prepare(s), /percentage/); const t = g.prepare({ ...s, pctBps: 5000 }); g.redeem(t.id); assert.equal(g.spentToday(), 0n);
});
