import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE, CopyEngine, CONFIRMATION_PRESETS, withConfirmationPolicy } from '../src/index.ts';
import type { CopyConfig, LeaderEvent, Intent } from '../src/index.ts';

const E18 = 10n ** 18n, TOK = '0xMEME';
const cfg = (o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f1', walletId: 'w1', userId: 'u1', leader: 'L', chain: 'sim-evm', quoteToken: NATIVE, mode: 'fixed', fixed: 1000n,
  ratioBps: 1000, sides: 'both', maxPerLeader: 2500n, maxPerToken: 50_000n, dailyLimit: 1_000_000n, maxPositions: 5, cooldownS: 0, minLiquidity: 10n, maxDeviationBps: 500, minConfirmations: 1,
  followLeaderExit: true, slippageBps: 300, venues: ['uniswap-v2'], ...o });
let n = 0;
const ev = (o: Partial<LeaderEvent> = {}): LeaderEvent => ({ provider: 'p1', chain: 'sim-evm', txHash: '0xh' + n++, logIndex: 0, leader: 'L', kind: 'swap', side: 'buy', token: TOK, quoteAmount: 10_000n,
  tokenAmount: 5000n, leaderBalanceBefore: 0n, leaderBalanceAfter: 5000n, leaderPriceE18: E18, confirmations: 3, ...o });
const mk = (c: CopyConfig) => { const out: Intent[] = []; const e = new CopyEngine([c], () => ({ priceE18: E18, liquidity: 1000n }), i => out.push(i), () => 1000); return { e, out }; };
const sell = (o: Partial<LeaderEvent>) => ev({ side: 'sell', ...o });

test('cap is NET exposure: sells free allocation, cumulative spend does not exhaust it', () => {
  const c = cfg(); const { e, out } = mk(c);
  e.onEvent(ev()); e.recordFill(c, TOK, 'buy', 1000n, 1000n, '', out[0].idempotencyKey);
  e.onEvent(ev()); e.recordFill(c, TOK, 'buy', 1000n, 1000n);
  assert.equal(e.exposure('f1', 'L'), 2000n);
  e.onEvent(ev()); assert.equal(out[2].amountIn, 500n);                              // only 500 headroom (2500 cap) ... and it is in flight
  e.onEvent(ev()); assert.equal(out.length, 3, 'in-flight 500 consumes the rest of the cap');
  e.recordFailure(out[2].idempotencyKey); assert.equal(e.exposure('f1', 'L'), 2000n);
  // leader exits fully -> we sell everything, basis returns to 0, cap fully available again (cumulative spend 2000 would otherwise block later)
  e.onEvent(sell({ tokenAmount: 5000n, leaderBalanceBefore: 5000n, leaderBalanceAfter: 0n })); assert.equal(out[3].amountIn, 2000n);
  e.recordFill(c, TOK, 'sell', 2000n, 1900n);
  assert.equal(e.exposure('f1', 'L'), 0n); assert.equal(e.attributed('f1', 'L', TOK), 0n);
  e.onEvent(ev()); e.onEvent(ev()); assert.equal(out.at(-1)!.amountIn, 1000n); assert.equal(out.length, 6);
});
test('cost basis reduced proportionally on partial sells', () => {
  const c = cfg({ maxPerLeader: 10_000n }); const { e } = mk(c);
  e.recordFill(c, TOK, 'buy', 1000n, 3000n); e.recordFill(c, TOK, 'sell', 250n, 1000n);
  assert.equal(e.attributed('f1', 'L', TOK), 750n); assert.equal(e.costBasis.get('f1|L|' + TOK), 2250n);
  e.recordFill(c, TOK, 'sell', 99_999n, 1n);                                           // over-sell is clamped to attributed
  assert.equal(e.attributed('f1', 'L', TOK), 0n); assert.equal(e.costBasis.get('f1|L|' + TOK), 0n);
});
test('exit modes: proportional, full-on-exit, full-on-any-sell, ignore', () => {
  const run = (mode: CopyConfig['exitMode'], evt: Partial<LeaderEvent>) => {
    const c = cfg({ exitMode: mode, maxPerLeader: 10_000n }); const { e, out } = mk(c); e.recordFill(c, TOK, 'buy', 1000n, 1000n); e.onEvent(sell(evt)); return out[0]?.amountIn;
  };
  const partial = { tokenAmount: 1000n, leaderBalanceBefore: 4000n, leaderBalanceAfter: 3000n };
  assert.equal(run('proportional', partial), 250n);
  assert.equal(run('proportional', { tokenAmount: 4000n, leaderBalanceBefore: 4000n, leaderBalanceAfter: 0n }), 1000n);
  assert.equal(run('full-on-exit', partial), 250n);
  assert.equal(run('full-on-exit', { tokenAmount: 3999n, leaderBalanceBefore: 4000n, leaderBalanceAfter: 0n }), 1000n);
  assert.equal(run('full-on-any-sell', partial), 1000n);
  assert.equal(run('ignore', { tokenAmount: 4000n, leaderBalanceBefore: 4000n, leaderBalanceAfter: 0n }), undefined);
  // backward compat: followLeaderExit=false behaves as proportional
  const c = cfg({ followLeaderExit: false }); const { e, out } = mk(c); e.recordFill(c, TOK, 'buy', 1000n, 1000n);
  e.onEvent(sell({ tokenAmount: 4000n, leaderBalanceBefore: 4000n, leaderBalanceAfter: 0n })); assert.equal(out[0].amountIn, 1000n);
});
test('partial-sell rounding floors, never exceeds attributed; dust sweep; leader oversell clamp', () => {
  for (const [mine, sold, before] of [[7n, 1n, 3n], [1n, 1n, 1000n], [999n, 3n, 7n], [10n, 50n, 10n]] as [bigint, bigint, bigint][]) {
    const c = cfg({ exitMode: 'proportional', maxPerLeader: 10n ** 9n }); const { e, out } = mk(c); e.recordFill(c, TOK, 'buy', mine, mine);
    e.onEvent(sell({ tokenAmount: sold, leaderBalanceBefore: before, leaderBalanceAfter: before > sold ? before - sold : 0n }));
    const amt = out[0]?.amountIn ?? 0n; assert.ok(amt <= mine, `${amt} <= ${mine}`); assert.equal(amt, mine * (sold > before ? before : sold) / before);
  }
  const c = cfg({ exitMode: 'proportional', dustTokens: 5n }); const { e, out } = mk(c); e.recordFill(c, TOK, 'buy', 100n, 100n);
  e.onEvent(sell({ tokenAmount: 97n, leaderBalanceBefore: 100n, leaderBalanceAfter: 3n })); assert.equal(out[0].amountIn, 100n);   // 3 left < dust -> sweep, still <= attributed
  const { e: e2, out: o2 } = mk(cfg()); e2.onEvent(sell({ tokenAmount: 1n, leaderBalanceBefore: 1n, leaderBalanceAfter: 0n })); assert.equal(o2.length, 0);
});
test('confirmation presets: fast 0 conf acts early, safe N conf waits', () => {
  assert.equal(CONFIRMATION_PRESETS.fast.minConfirmations, 0); assert.match(CONFIRMATION_PRESETS.fast.tradeoff, /reorg risk/);
  assert.equal(CONFIRMATION_PRESETS.safe(5).minConfirmations, 5); assert.match(CONFIRMATION_PRESETS.safe(5).tradeoff, /latency/);
  const fast = mk(withConfirmationPolicy(cfg(), 'fast')), safe = mk(withConfirmationPolicy(cfg(), 'safe', 4));
  fast.e.onEvent(ev({ confirmations: 0 })); safe.e.onEvent(ev({ confirmations: 0 }));
  assert.equal(fast.out.length, 1); assert.equal(safe.out.length, 0);
  safe.e.onEvent(ev({ confirmations: 3 })); assert.equal(safe.out.length, 0); safe.e.onEvent(ev({ confirmations: 4 })); assert.equal(safe.out.length, 1);
  assert.equal(withConfirmationPolicy(cfg(), 'safe', 0).minConfirmations, 1);        // safe never degrades to 0
});
test('recordReorg after fill: attributed inventory reversed, position orphaned, no automatic sell', () => {
  const c = withConfirmationPolicy(cfg({ maxPerLeader: 10_000n }), 'fast'); const { e, out } = mk(c);
  const buy = ev({ txHash: '0xREORG', confirmations: 0 }); e.onEvent(buy); assert.equal(out.length, 1);
  e.recordFill(c, TOK, 'buy', 800n, 1000n, '', out[0].idempotencyKey);
  e.onEvent(ev({ txHash: '0xOK', confirmations: 0 })); e.recordFill(c, TOK, 'buy', 300n, 1000n, 'sim-evm:0xOK:0');
  assert.equal(e.positionStatus('f1', 'L', TOK), 'open'); assert.equal(e.attributed('f1', 'L', TOK), 1100n);
  const hit = e.recordReorg('sim-evm', '0xREORG');
  assert.deepEqual(hit, ['f1|L|' + TOK]); assert.equal(e.attributed('f1', 'L', TOK), 300n); assert.equal(e.costBasis.get('f1|L|' + TOK), 1000n);
  assert.equal(e.positionStatus('f1', 'L', TOK), 'orphaned'); assert.match(e.orphanReason('f1', 'L', TOK)!, /no auto-sell/);
  assert.equal(out.length, 2, 'no sell intent was emitted'); assert.equal(out.every(i => i.tokenOut === TOK), true);
  assert.deepEqual(e.recordReorg('sim-evm', '0xREORG'), []);                         // idempotent, no double reversal
  assert.equal(e.attributed('f1', 'L', TOK), 300n);
  e.onEvent(ev({ txHash: '0xREORG', logIndex: 9 })); assert.equal(out.length, 2, 'later events of the reorged tx are rejected');
});
test('onReorg also reverses already-filled positions; reversal clamps if part was already sold', () => {
  const c = cfg({ maxPerLeader: 10_000n }); const { e } = mk(c);
  e.recordFill(c, TOK, 'buy', 1000n, 1000n, 'sim-evm:0xX:0'); e.recordFill(c, TOK, 'sell', 700n, 700n);
  e.onReorg('sim-evm', '0xX'); assert.equal(e.attributed('f1', 'L', TOK), 0n); assert.ok((e.costBasis.get('f1|L|' + TOK) ?? 0n) >= 0n);
  assert.equal(e.positionStatus('f1', 'L', TOK), 'orphaned');
});
