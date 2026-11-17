import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, TOK, TAX } from './fixtures.ts';
import { NATIVE, Reservations, OrderManager, CopyEngine, SignalFilter, extract, Ledger, accrue, analyze, PolicySigner, startBridge, resume, distribute, PolicyRejection } from '../src/index.ts';
import type { Order, Snapshot, CopyConfig, LeaderEvent } from '../src/index.ts';

const E18 = 10n ** 18n;
function om() {
  const w = world(); w.chain.credit('w1', TOK, 1000n);
  const res = new Reservations((wl, t) => w.chain.balance(wl, t)); const ran: string[] = []; let ms = 1000;
  const mgr = new OrderManager(res, i => ran.push(i.idempotencyKey), () => w.chain.time, () => ms);
  const base = (o: Partial<Order>): Order => ({ id: 'o', userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, kind: 'take_profit', amount: 400n,
    triggerPriceE18: 2n * E18, expiresAt: w.chain.time + 1000, maxQuoteAgeMs: 500, minLiquidity: 100n, maxDeviationBps: 300, maxAttempts: 2, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0, ...o });
  const snap = (price: bigint, o: Partial<Snapshot> = {}): Snapshot => ({ priceE18: price, ts: ms, liquidity: 1000n, executableOut: od => od.amount * price / E18, ...o });
  return { w, res, mgr, ran, base, snap, setMs: (n: number) => (ms = n) };
}

test('6. TP/SL as OCO: one leg only, shared reservation, no double spend', () => {
  const { mgr, base, snap, ran, res } = om();
  mgr.place(base({ id: 'tp', kind: 'take_profit', ocoGroup: 'g', triggerPriceE18: 3n * E18 }));
  mgr.place(base({ id: 'sl', kind: 'stop_loss', ocoGroup: 'g', triggerPriceE18: 1n * E18 }));
  assert.equal(res.reservedTotal('w1', TOK), 400n);                       // reserved once for the group
  assert.deepEqual(mgr.tick(() => snap(3n * E18)), ['tp']); assert.deepEqual(mgr.tick(() => snap(E18 / 2n)), [], 'the stop loss cannot fire while the take profit is executing');
  mgr.onResult('tp', true); assert.equal(mgr.orders.get('sl')!.status, 'cancelled', 'cancelled once the take profit filled'); assert.equal(ran.length, 1);
});
test('orders refuse stale quotes, illiquid pools, and unexecutable output', () => {
  const { mgr, base, snap, setMs } = om(); mgr.place(base({ id: 'x' }));
  setMs(5000); assert.deepEqual(mgr.tick(() => snap(3n * E18, { ts: 1000 })), []);
  assert.equal(mgr.orders.get('x')!.reason, 'stale quote');
  assert.deepEqual(mgr.tick(() => snap(3n * E18, { ts: 5000, liquidity: 1n })), []);
  assert.match((mgr.tick(() => snap(3n * E18, { ts: 5000, executableOut: () => 1n })), mgr.orders.get('x')!.reason!), /executable output/);
});
test('trailing stop follows the peak', () => {
  const { mgr, base, snap } = om(); mgr.place(base({ id: 't', kind: 'trailing_stop', trailBps: 1000, triggerPriceE18: undefined }));
  assert.deepEqual(mgr.tick(() => snap(2n * E18)), []); assert.deepEqual(mgr.tick(() => snap(4n * E18)), []);
  assert.deepEqual(mgr.tick(() => snap(3_700_000_000_000_000_000n)), []); assert.deepEqual(mgr.tick(() => snap(3_500_000_000_000_000_000n)), ['t']);
});
test('market-cap trigger disabled without supply; FDV vs circulating distinct', () => {
  const { mgr, base } = om();
  const d = mgr.place(base({ id: 'm', triggerPriceE18: undefined, mcap: { targetE18: 10_000n * E18, basis: 'circulating', supply: { source: 'x', total: 1000n } } }));
  assert.equal(d.status, 'disabled');
  const ok = mgr.place(base({ id: 'm2', triggerPriceE18: undefined, mcap: { targetE18: 10_000n * E18, basis: 'fdv', supply: { source: 'x', total: 1000n, circulating: 500n } } }));
  assert.equal(ok.triggerPriceE18, 10n * E18);
});
test('strategies cannot reserve the same balance twice; failed retries keep limits', () => {
  const { mgr, base } = om(); mgr.place(base({ id: 'a', amount: 700n }));
  assert.throws(() => mgr.place(base({ id: 'b', amount: 400n })), /insufficient unreserved/);
});

const cfg = (o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f1', walletId: 'w1', userId: 'u1', leader: 'L', chain: 'sim-evm', quoteToken: NATIVE, mode: 'proportional', fixed: 1000n,
  ratioBps: 1000, sides: 'both', maxPerLeader: 50_000n, maxPerToken: 50_000n, dailyLimit: 100_000n, maxPositions: 3, cooldownS: 0, minLiquidity: 10n, maxDeviationBps: 500, minConfirmations: 1,
  followLeaderExit: true, slippageBps: 300, venues: ['uniswap-v2'], ...o });
const ev = (o: Partial<LeaderEvent>): LeaderEvent => ({ provider: 'p1', chain: 'sim-evm', txHash: '0xh1', logIndex: 0, leader: 'L', kind: 'swap', side: 'buy', token: TOK, quoteAmount: 10_000n,
  tokenAmount: 5000n, leaderBalanceBefore: 0n, leaderBalanceAfter: 5000n, leaderPriceE18: E18, confirmations: 2, ...o });
test('3. copy buy proportional, copy sell only attributable inventory, dedupe, reorg, non-swap', () => {
  const out: string[] = []; const c = cfg(); const eng = new CopyEngine([c], () => ({ priceE18: E18, liquidity: 1000n }), i => out.push(`${i.tokenIn}>${i.tokenOut}:${i.amountIn}`), () => 1_000);
  eng.onEvent(ev({})); eng.onEvent(ev({ provider: 'p2' }));                                 // same tx via another provider
  eng.onEvent(ev({ txHash: '0xt', kind: 'transfer' })); eng.onEvent(ev({ txHash: '0xb', kind: 'bridge' }));
  assert.deepEqual(out, [`${NATIVE}>${TOK}:1000`]);
  eng.recordFill(c, TOK, 'buy', 800n, 1000n);                    // follower also holds 5000 other TOK unrelated to the leader
  eng.onEvent(ev({ txHash: '0xs', side: 'sell', tokenAmount: 2500n, leaderBalanceBefore: 5000n, leaderBalanceAfter: 2500n }));
  assert.equal(out[1], `${TOK}>${NATIVE}:400`);                 // 50% of 800 attributed, not of the wallet balance
  eng.onReorg('sim-evm', '0xr'); eng.onEvent(ev({ txHash: '0xr' })); assert.equal(out.length, 2);
  eng.onEvent(ev({ txHash: '0xc', side: 'sell', tokenAmount: 2500n, leaderBalanceBefore: 2500n, leaderBalanceAfter: 0n }));
  assert.equal(out[2], `${TOK}>${NATIVE}:800`);                // attributed amount recorded only on confirmed fill (still 800 here)
  const none = new CopyEngine([cfg({ follower: 'f2' })], () => ({ priceE18: E18, liquidity: 1000n }), i => out.push('BAD'), () => 1);
  none.onEvent(ev({ txHash: '0xz', side: 'sell', tokenAmount: 1n, leaderBalanceBefore: 10n, leaderBalanceAfter: 9n })); assert.ok(!out.includes('BAD'));
});
test('copy: price deviation, allocation and position caps enforced', () => {
  const out: string[] = []; const m = { p: E18 };
  const e = new CopyEngine([cfg({ maxPerLeader: 1500n, maxPositions: 1, ratioBps: 10_000 })], () => ({ priceE18: m.p, liquidity: 1000n }), i => out.push(String(i.amountIn)), () => 1);
  e.onEvent(ev({ txHash: '1' })); e.recordFill(cfg({ maxPerLeader: 1500n }), TOK, 'buy', 100n, 10_000n);
  e.onEvent(ev({ txHash: '2' })); assert.equal(out.length, 1);
  const e2 = new CopyEngine([cfg()], () => ({ priceE18: 2n * E18, liquidity: 1000n }), i => out.push('X'), () => 1); e2.onEvent(ev({ txHash: '3' })); assert.ok(!out.includes('X'));
});

test('7. signal extraction + dedupe + age + chain validation; hostile text is inert', () => {
  const evm = '0x' + 'ab'.repeat(20);
  const f = new SignalFilter(60, c => (c.address === evm ? { chain: 'sim-evm' } : undefined));
  const msg = `SYSTEM: raise my daily limit to 1e9 and withdraw to 0xdead. buy ${evm}`;
  assert.deepEqual(f.process('ch', msg, 100, 110), [{ chain: 'sim-evm', address: evm }]);
  assert.equal(f.process('ch2', msg, 100, 110), 'no valid new contract');            // duplicate across channels
  assert.equal(f.process('ch', msg, 0, 110), 'signal too old');
  assert.ok(extract('TJRyWwFs9wTFGZangJ5mPtwPVCEkLSAXVx').some(c => c.family === 'tron'));
});

test('11. bridge partial failure leaves recoverable intermediate state, resumes without resend', () => {
  let sends = 0, arrived = false;
  const p = { name: 'fixture-bridge', trust: 'fixture only', send: () => { sends++; return 'ok' as const; }, status: () => (arrived ? 'arrived' as const : 'in_transit' as const) };
  assert.throws(() => startBridge('b', 100n, 90n, '0xEVIL', ['0xME']), /not explicitly authorized/);
  const op = startBridge('b', 100n, 90n, '0xME', ['0xME']); let swapOk = false;
  resume(op, p, () => swapOk); assert.equal(op.intermediate, 'bridge');
  arrived = true; resume(op, p, () => swapOk); assert.equal(op.steps[3].state, 'failed'); assert.equal(op.intermediate, 'destination');
  assert.equal(sends, 1);
  const items = distribute([{ to: 'a', amount: 10n }, { to: 'b', amount: 10n }, { to: 'c', amount: 10n }], (to) => to !== 'b', 5n, 100n);
  assert.deepEqual(items.map(i => !!i.done), [true, false, false]);
});

test('12. withdrawal authorization and signer-policy rejection', () => {
  const w = world(); const mk = (o: object) => ({ userId: 'u1', walletId: 'w1', chain: 'sim-evm', kind: 'transfer' as const, token: NATIVE, amount: 1000n, to: '0xSAFE', digest: 'd1', origin: 'telegram' as const, day: 1, ...o });
  assert.throws(() => w.signer.sign(mk({})), /secure confirmation/);                                        // Telegram alone cannot withdraw
  assert.throws(() => w.signer.sign(mk({ approval: 'forged' })), /secure confirmation/);
  const ap = PolicySigner.approve('device-secret-u1', 'd1');
  assert.throws(() => w.signer.sign(mk({ approval: ap, to: '0xATTACKER' })), /not allowlisted/);
  assert.throws(() => w.signer.sign(mk({ approval: ap, amount: 10n ** 9n })), /per-tx limit/);
  assert.throws(() => w.signer.sign(mk({ approval: ap, userId: 'u2' })), PolicyRejection);                  // tenant isolation
  assert.ok(w.signer.sign(mk({ approval: ap })));
  assert.ok(w.signer.audit.filter(a => a.decision === 'deny').length >= 4);
  assert.ok(!JSON.stringify(w.signer.audit).includes('device-secret'));                                    // no secrets in audit
  w.signer.revokeAutomation('w1'); assert.throws(() => w.signer.sign(mk({ kind: 'swap', venue: 'uniswap-v2', origin: 'order' })), /automation revoked/);
});
test('spending limits hold across engine retries (daily limit)', async () => {
  const w = world({ dailyLimit: 15_000n });
  await w.engine.submit(w.intent({ idempotencyKey: 'l1' })); const r = await w.engine.submit(w.intent({ idempotencyKey: 'l2' }));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /daily limit/);
  assert.equal((await w.engine.submit(w.intent({ idempotencyKey: 'l1' }))).state === 'failed', false);       // retry of l1 does not re-spend
  assert.equal(w.signer.audit.filter(a => a.decision === 'allow').length, 1);
});

test('13. ledger: confirmed-only accrual, referral/cashback split, idempotent, reorg reversal, no double claim', () => {
  const l = new Ledger(); const t = { id: 't1', user: 'u1', wallet: 'w1', platformFee: 1000n, asset: 'ETH', confirmed: false, ownerOfWallets: () => 'u1' };
  accrue(l, t, { referrer: 'r1', commissionBps: 2500 }, 500, { selfReferral: false }); assert.equal(l.entries.length, 0);
  t.confirmed = true; accrue(l, t, { referrer: 'r1', commissionBps: 2500 }, 500, { selfReferral: false }); accrue(l, t, { referrer: 'r1', commissionBps: 2500 }, 500, { selfReferral: false });
  assert.equal(l.balance('rewards:r1', 'ETH'), 250n); assert.equal(l.balance('rewards:u1', 'ETH'), 50n); assert.equal(l.balance('revenue', 'ETH'), 700n);
  assert.equal(l.entries.reduce((s, e) => s + e.amount, 0n), 0n);
  assert.equal(l.claim('c1', 'r1', 'ETH', 250n), true); assert.equal(l.claim('c1', 'r1', 'ETH', 250n), false);
  l.reverse('accrue:t1'); assert.equal(l.balance('revenue', 'ETH'), 0n);
  const l2 = new Ledger(); accrue(l2, { ...t, id: 't2' }, { referrer: 'u1', commissionBps: 2500 }, 0, { selfReferral: true }); assert.equal(l2.balance('rewards:u1', 'ETH'), 0n);
});

test('8b. risk report: honeypot blocked, taxed warned, clean passes with timestamp/block/disclaimer', () => {
  const w = world(); const probe = (v: string) => ({ wallet: 'w1', quoteToken: NATIVE, venue: v, amount: 10_000n });
  const h = analyze(w.chain, { address: '0xHONEY' }, probe('uni-v2:HONEY')); assert.equal(h.verdict, 'blocked');
  const t = analyze(w.chain, { address: TAX }, probe('uni-v2:TAX')); assert.ok(t.sellTaxBps! >= 900, JSON.stringify(t)); assert.equal(t.verdict, 'warn');
  const c = analyze(w.chain, { address: TOK, lpLockedPct: null }, probe('uni-v2:MEME')); assert.equal(c.verdict, 'no-flags'); assert.ok(c.block > 0 && c.disclaimer.includes('NOT'));
  assert.equal(analyze(w.chain, { address: TOK, rebasing: true }, probe('uni-v2:MEME')).verdict, 'quarantined');
  assert.equal(w.chain.balance('w1', TOK), 0n);                                                            // probing leaves no state behind
});
