import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE, CopyEngine, MAESTRO_COPY_DEFAULTS, validateCopyConfig, planDisperse, collect, distribute } from '../src/index.ts';
import type { CopyConfig, LeaderEvent, Intent, Market } from '../src/index.ts';

const E18 = 10n ** 18n, TOK = '0xTOK', USDC = '0xUSDC';
const cfg = (o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f1', walletId: 'w1', userId: 'u1', leader: 'L', chain: 'sim-evm', quoteToken: NATIVE, mode: 'fixed', fixed: 10_000n, ratioBps: 0, sides: 'both',
  maxPerLeader: 1_000_000n, maxPerToken: 1_000_000n, dailyLimit: 2_500_000n, maxPositions: 5, cooldownS: 0, minLiquidity: 100n, maxDeviationBps: 500, minConfirmations: 0, followLeaderExit: true, slippageBps: 100, venues: ['v'], ...o });
const ev = (o: Partial<LeaderEvent> = {}): LeaderEvent => ({ provider: 'rpc', chain: 'sim-evm', txHash: '0xaa', logIndex: 1, leader: 'L', kind: 'swap', side: 'buy', token: TOK, quoteAmount: 50_000n, tokenAmount: 50_000n,
  leaderBalanceBefore: 0n, leaderBalanceAfter: 50_000n, leaderPriceE18: E18, confirmations: 1, ...o });
const mk = (c: CopyConfig, m: Partial<Market> = {}) => { const out: Intent[] = []; const e = new CopyEngine([c], () => ({ priceE18: E18, liquidity: 1000n, ...m }), i => out.push(i), () => 1000); return { e, out }; };
const last = (e: CopyEngine) => e.log[e.log.length - 1].decision;

test('Max Buy caps one copied buy and wins over Buy % (up to 1000%)', () => {
  const { e, out } = mk(cfg({ mode: 'proportional', ratioBps: 100_000, maxBuy: 120_000n })); e.onEvent(ev({ quoteAmount: 50_000n }));   // 1000% of 50k = 500k, capped at 120k
  assert.equal(out[0].amountIn, 120_000n);
  const b = mk(cfg({ mode: 'proportional', ratioBps: 100_000 })); b.e.onEvent(ev({ quoteAmount: 50_000n })); assert.equal(b.out[0].amountIn, 500_000n, 'without maxBuy, 1000% is honoured');
  assert.throws(() => validateCopyConfig(cfg({ ratioBps: 100_001 })), /1000%/); assert.throws(() => validateCopyConfig(cfg({ maxBuy: 0n })), /positive/);
});

test('Track Only runs the rules, logs what it would do, and emits nothing or consumes any allocation', () => {
  const { e, out } = mk(cfg({ trackOnly: true })); e.onEvent(ev());
  assert.equal(out.length, 0); assert.match(last(e), /^track-only: would buy 10000 of 0xTOK/); assert.equal(e.exposure('f1', 'L'), 0n, 'no in-flight reservation');
  e.onEvent(ev({ txHash: '0xbb' })); assert.match(last(e), /track-only: would buy 10000/, 'a second event is not blocked by a phantom allocation');
  const r = mk(cfg({ trackOnly: true })); r.e.recordFill(cfg(), TOK, 'buy', 1000n, 1000n);   // held tokens exist, leader sells
  r.e.onEvent(ev({ txHash: '0xcc', side: 'sell', tokenAmount: 25n, leaderBalanceBefore: 100n, leaderBalanceAfter: 75n })); assert.equal(r.out.length, 0); assert.match(last(r.e), /track-only: would sell 250/);
});

test('Auto Buy Checks: pass, fail, and fail CLOSED when the data is unavailable', () => {
  const run = (checks: CopyConfig['checks'], m: Partial<Market>) => { const x = mk(cfg({ checks }), m); x.e.onEvent(ev()); return { n: x.out.length, why: last(x.e) }; };
  assert.equal(run({ minMc: 100n, maxMc: 900n }, { marketCap: 500n }).n, 1);
  assert.match(run({ minMc: 100n }, { marketCap: 50n }).why, /market cap below minimum/); assert.match(run({ maxMc: 100n }, { marketCap: 500n }).why, /above maximum/);
  assert.match(run({ minMc: 100n }, {}).why, /market cap unavailable/, 'no market cap known => skip, never guess'); assert.equal(run({ minMc: 100n }, {}).n, 0);
  assert.match(run({ maxLiq: 500n }, { liquidity: 1000n }).why, /liquidity above maximum/); assert.match(run({ minLiq: 5000n }, { liquidity: 1000n }).why, /liquidity below minimum/);
  assert.equal(run({ maxBuyTaxBps: 500, maxSellTaxBps: 500 }, { buyTaxBps: 100, sellTaxBps: 100 }).n, 1);
  assert.match(run({ maxBuyTaxBps: 500 }, { buyTaxBps: 1000 }).why, /buy tax 1000 bps is above 500/); assert.match(run({ maxSellTaxBps: 500 }, { sellTaxBps: 1000 }).why, /sell tax 1000/);
  assert.match(run({ maxSellTaxBps: 500 }, { buyTaxBps: 0 }).why, /sell tax unavailable/);
  assert.throws(() => validateCopyConfig(cfg({ checks: { minMc: 5n, maxMc: 1n } })), /minMc is above maxMc/); assert.throws(() => validateCopyConfig(cfg({ checks: { maxBuyTaxBps: 20_000 } })), /0\.\.10000/);
});

test('Duplicate Buy: blocked when false (held or in flight), allowed when unset, MAESTRO defaults block', () => {
  const blocked = mk(cfg({ duplicateBuy: false })); blocked.e.onEvent(ev()); blocked.e.onEvent(ev({ txHash: '0xbb' }));
  assert.equal(blocked.out.length, 1); assert.match(last(blocked.e), /duplicate buy blocked/, 'second buy while the first is still in flight');
  blocked.e.recordFill(cfg(), TOK, 'buy', 100n, 10_000n, '', blocked.out[0].idempotencyKey); blocked.e.onEvent(ev({ txHash: '0xcc' })); assert.match(last(blocked.e), /duplicate buy blocked/, 'and once it is held');
  blocked.e.onEvent(ev({ txHash: '0xdd', token: '0xOTHER' })); assert.equal(blocked.out.length, 2, 'a different token is fine');
  const legacy = mk(cfg()); legacy.e.onEvent(ev()); legacy.e.onEvent(ev({ txHash: '0xbb' })); assert.equal(legacy.out.length, 2, 'unset keeps legacy behaviour');
  const d = mk(cfg({ ...MAESTRO_COPY_DEFAULTS }), {}); d.e.onEvent(ev()); assert.equal(d.out.length, 0, 'defaults also set a 20% impact alert and the market has no impact function => skipped, fail closed');
});

test('Price Impact Alert (default 20%): skips above it, passes below, never raises slippage, unquotable fails closed', () => {
  const imp = (bps: number | undefined) => ({ impactBps: () => bps });
  const above = mk(cfg({ priceImpactAlertBps: MAESTRO_COPY_DEFAULTS.priceImpactAlertBps }), imp(2500)); above.e.onEvent(ev()); assert.equal(above.out.length, 0); assert.match(last(above.e), /2500 bps is above the 2000 bps alert/);
  const ok = mk(cfg({ priceImpactAlertBps: 2000 }), imp(1500)); ok.e.onEvent(ev()); assert.equal(ok.out.length, 1); assert.equal(ok.out[0].slippageBps, 100, 'slippage is the configured value, not raised');
  const none = mk(cfg({ priceImpactAlertBps: 2000 }), imp(undefined)); none.e.onEvent(ev()); assert.match(last(none.e), /price impact unavailable/);
  const off = mk(cfg(), imp(9999)); off.e.onEvent(ev()); assert.equal(off.out.length, 1, 'no alert configured = no check');
});

test('Copy Sell: same percentage as the leader of YOUR copied inventory; stablecoin trades and non-swaps are never copied', () => {
  const x = mk(cfg({ stablecoins: [USDC] })); const c = cfg(); x.e.recordFill(c, TOK, 'buy', 1000n, 1000n);
  x.e.onEvent(ev({ txHash: '0xs1', side: 'sell', tokenAmount: 25n, leaderBalanceBefore: 100n, leaderBalanceAfter: 75n })); assert.equal(x.out[0].amountIn, 250n, 'leader sold 25% => we sell 25% of what we copied');
  x.e.recordFill(c, USDC, 'buy', 500n, 500n); x.e.onEvent(ev({ txHash: '0xs2', token: USDC, side: 'sell', tokenAmount: 50n, leaderBalanceBefore: 100n, leaderBalanceAfter: 50n })); assert.match(last(x.e), /stablecoin trade not copied/);
  x.e.onEvent(ev({ txHash: '0xs3', kind: 'airdrop', side: 'buy' })); assert.match(last(x.e), /not an economic swap \(airdrop\)/);
  x.e.onEvent(ev({ txHash: '0xs4', kind: 'transfer', side: 'sell' })); assert.match(last(x.e), /not an economic swap \(transfer\)/); assert.equal(x.out.length, 1);
  x.e.onEvent(ev({ txHash: '0xs5', token: '0xUNHELD', side: 'sell', tokenAmount: 5n, leaderBalanceBefore: 10n, leaderBalanceAfter: 5n })); assert.match(last(x.e), /no leader-attributed inventory/, 'unrelated or airdropped holdings are untouched');
});

test('planDisperse splits a percentage equally after the reserve; the remainder stays; bad input is refused', () => {
  const p = planDisperse(1_000n, 5_000, ['a', 'b', 'c'], 100n); assert.deepEqual(p.map(x => x.amount), [150n, 150n, 150n], '(1000-100) * 50% / 3');
  assert.deepEqual(planDisperse(50n, 10_000, ['a'], 100n)[0].amount, 0n);
  assert.throws(() => planDisperse(1n, 0, ['a']), /percentage/); assert.throws(() => planDisperse(1n, 5_000, []), /no recipients/); assert.throws(() => planDisperse(1n, 5_000, ['a', 'a']), /duplicate/);
  const sent: string[] = []; const items = distribute(planDisperse(1_000n, 10_000, ['a', 'b']), (to, a) => { sent.push(`${to}:${a}`); return true; }, 0n, 1_000n); assert.deepEqual(sent, ['a:500', 'b:500']); assert.ok(items.every(i => i.done));
});

test('collect sweeps wallets into one receiver: gas reserve on native, raw balance for tokens, policy caps, resumable', () => {
  const bal = new Map([['w1|NATIVE', 1000n], ['w2|NATIVE', 40n], ['w3|NATIVE', 500n], ['w1|TOK', 70n], ['w2|TOK', 0n], ['w3|TOK', 900n]]); const log: string[] = []; let failOn = '';
  const d = (o = {}) => ({ receiver: 'w0', wallets: ['w0', 'w1', 'w2', 'w3'], nativeToken: 'NATIVE', reserveNative: 50n, balanceOf: (w: string, t: string) => bal.get(`${w}|${t}`) ?? 0n,
    send: (f: string, to: string, t: string, a: bigint) => { if (`${f}|${t}` === failOn) return false; log.push(`${f}>${to} ${t} ${a}`); bal.set(`${f}|${t}`, (bal.get(`${f}|${t}`) ?? 0n) - a); return true; }, ...o });
  const items = [{ from: 'w1', token: 'NATIVE' }, { from: 'w2', token: 'NATIVE' }, { from: 'w3', token: 'TOK' }, { from: 'w1', token: 'TOK' }, { from: 'w2', token: 'TOK' }];
  failOn = 'w3|TOK'; collect(items, d({ cap: (f: string, t: string) => (t === 'TOK' ? 500n : undefined) }));
  assert.deepEqual(log, ['w1>w0 NATIVE 950'], 'native keeps the 50 reserve; w2 (40) is below the reserve; the failed send stops the run');
  assert.equal(items[1].note, 'balance does not cover the gas reserve'); assert.equal(items[2].done, undefined); assert.equal(items[2].note, 'send failed; resume to retry');
  failOn = ''; collect(items, d({ cap: (f: string, t: string) => (t === 'TOK' ? 500n : undefined) }));
  assert.deepEqual(log.slice(1), ['w3>w0 TOK 500', 'w1>w0 TOK 70'], 'resumed: w1 NATIVE is not sent twice; w3 is capped at 500 and flagged');
  assert.equal(items[2].note, 'capped'); assert.equal(items[2].sent, 500n); assert.equal(items[4].note, 'nothing to send'); assert.ok(items.every(i => i.done));
  const again = log.length; collect(items, d()); assert.equal(log.length, again, 'a finished sweep is a no-op');
});

test('collect refuses an outside receiver or a source that is not yours, and rejects duplicate items', () => {
  const base = { receiver: 'attacker', wallets: ['w1', 'w2'], nativeToken: 'N', reserveNative: 0n, balanceOf: () => 10n, send: () => true };
  assert.throws(() => collect([{ from: 'w1', token: 'N' }], base), /receiver is not one of your wallets/);
  const sent: string[] = []; collect([{ from: 'w1', token: 'N' }], { ...base, allowExternalReceiver: true, send: (f, t, k, a) => { sent.push(`${f}>${t}`); return true; } }); assert.deepEqual(sent, ['w1>attacker'], 'explicit opt-in only');
  assert.throws(() => collect([{ from: 'mallory', token: 'N' }], { ...base, receiver: 'w1' }), /not one of your wallets/);
  assert.throws(() => collect([{ from: 'w1', token: 'N' }, { from: 'w1', token: 'N' }], { ...base, receiver: 'w2' }), /duplicate sweep item/);
  const self = [{ from: 'w2', token: 'N' }]; collect(self, { ...base, receiver: 'w2' }); assert.equal(self[0].note, 'source is the receiver');
});
