import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, accrue, washFlag, washIndices } from '../src/ledger.ts';
import { defaultTierConfig, enforce, Subscriptions, FeeCollector, ReferralBook, reverseAccrual, effectiveCashbackBps, Competition, DAY_MS } from '../src/commerce.ts';
import type { FeeSchedule, CompTrade } from '../src/commerce.ts';

const trade = (id: string, user = 'u1', fee = 1000n) => ({ id, user, wallet: 'w', platformFee: fee, asset: 'ETH', confirmed: true, ownerOfWallets: () => user });
const zero = (l: Ledger, a: string) => assert.equal(l.total(a), 0n);

test('abuse: flagged trades get no rewards, go to abuse:flagged + audit; reversal restores', () => {
  const l = new Ledger(); const r = { referrer: 'r1', commissionBps: 2500 };
  assert.equal(accrue(l, trade('t1'), r, 500, { selfReferral: false, wash: true }), 'flagged');
  assert.equal(l.balance('rewards:r1', 'ETH'), 0n); assert.equal(l.balance('rewards:u1', 'ETH'), 0n);
  assert.equal(l.balance('abuse:flagged', 'ETH'), 1000n); assert.equal(l.audit[0].reasons[0], 'wash-trade'); assert.ok(l.isFlagged('t1'));
  assert.equal(accrue(l, trade('t2'), r, 500, { selfReferral: true }), 'flagged');
  assert.equal(accrue(l, trade('t3'), r, 500, { selfReferral: false, wash: false }), 'accrued');
  assert.equal(accrue(l, trade('t3'), r, 500, { selfReferral: false }), 'duplicate');
  assert.equal(l.audit.length, 2); zero(l, 'ETH');
  l.reverse('accrue:t1'); l.reverse('accrue:t2'); l.reverse('accrue:t3'); assert.equal(l.balance('abuse:flagged', 'ETH'), 0n); assert.equal(l.balance('revenue', 'ETH'), 0n); zero(l, 'ETH');
});
test('washFlag detects same-owner and cluster round trips, not unrelated or same-side', () => {
  const owners: Record<string, string> = { a: 'U', b: 'U', c: 'V', d: 'W' }; const cl: Record<string, string> = { c: 'K', d: 'K' };
  const o = { ownerOf: (w: string) => owners[w], clusterOf: (w: string) => cl[w] };
  const buy = (wallet: string, t: number) => ({ wallet, side: 'buy' as const, token: 'X', t }); const sell = (wallet: string, t: number) => ({ wallet, side: 'sell' as const, token: 'X', t });
  assert.equal(washFlag([buy('a', 0), sell('b', 10)], 60, o), true);          // same user
  assert.equal(washFlag([buy('c', 0), sell('d', 10)], 60, o), true);          // linked cluster
  assert.equal(washFlag([buy('a', 0), sell('c', 10)], 60, o), false);         // unrelated
  assert.equal(washFlag([buy('a', 0), sell('b', 500)], 60, o), false);        // outside window
  assert.equal(washFlag([buy('a', 0), buy('b', 10)], 60, o), false);          // same side
  assert.equal(washFlag([buy('a', 0), sell('a', 10)], 60, o), false);         // plain flip in one wallet
  assert.equal(washFlag([{ ...buy('x', 0), counterparty: 'y' }, sell('y', 5)]), true); // legacy counterparty form
  assert.deepEqual([...washIndices([buy('a', 0), sell('b', 10), buy('c', 11)], 60, o)].sort(), [0, 1]);
});
test('tiers: enforce limits, config driven', () => {
  const cfg = defaultTierConfig();
  assert.deepEqual(enforce(cfg, 'free', 'snipes', 0), { allow: true });
  const d = enforce(cfg, 'free', 'snipes', cfg.tiers.free.limits.snipes); assert.equal(d.allow, false); assert.match(d.reason!, /snipes/);
  cfg.tiers.premium.limits.monitors = 2; assert.equal(enforce(cfg, 'premium', 'monitors', 2).allow, false); assert.equal(enforce(cfg, 'premium', 'monitors', 1).allow, true);
  assert.equal(enforce(cfg, 'nope', 'monitors', 0).allow, false); assert.equal(enforce(cfg, 'free', 'monitors', -1).allow, false);
});
test('subscriptions: purchase, expiry, idempotent renewal, stacking, refund reversal', () => {
  const l = new Ledger(); const s = new Subscriptions(l, defaultTierConfig()); const P = s.cfg.periodMs;
  assert.equal(s.tierOf('u', 0), 'free');
  assert.equal(s.purchase('p1', 'u', 'premium', 1000), true); assert.equal(s.purchase('p1', 'u', 'premium', 1000), false);
  assert.equal(s.tierOf('u', 1000 + P - 1), 'premium'); assert.equal(s.tierOf('u', 1000 + P), 'free');
  assert.equal(s.enforce('u', 'snipes', 5, 2000).allow, true); assert.equal(s.enforce('u', 'snipes', 5, 1000 + P).allow, false);
  assert.equal(l.balance('revenue:subscriptions', 'USD'), 1_000_000n);
  s.purchase('p2', 'u', 'premium', 1000 + 10 * DAY_MS);                      // early renewal extends from expiry
  assert.equal(s.expiresAt('u'), 1000 + 2 * P);
  assert.equal(s.refund('p2'), true); assert.equal(s.refund('p2'), false);
  assert.equal(s.expiresAt('u'), 1000 + P); assert.equal(l.balance('revenue:subscriptions', 'USD'), 1_000_000n);
  s.refund('p1'); assert.equal(s.tierOf('u', 2000), 'free'); assert.equal(l.balance('revenue:subscriptions', 'USD'), 0n); assert.equal(l.balance('cash:u', 'USD'), 0n); zero(l, 'USD');
  assert.throws(() => s.purchase('p3', 'u', 'free', 0));
});
const sched: FeeSchedule = { chains: {
  evm: { mode: 'in-tx', sweepMin: 0n, bps: { default: 100, premium: 50 } },
  sol: { mode: 'accrued-then-swept', sweepMin: 500n, bps: { default: 100 } } } };
test('fees: per chain/tier bps, in-tx vs accrued, sweep once per id with minimum', () => {
  const l = new Ledger(); const f = new FeeCollector(l, sched);
  assert.equal(f.charge('a', 'evm', 'u', 'free', 100_000n, 'ETH'), 1000n); assert.equal(f.charge('b', 'evm', 'u', 'premium', 100_000n, 'ETH'), 500n);
  assert.equal(l.balance('revenue', 'ETH'), 1500n);
  f.charge('c', 'sol', 'u', 'free', 20_000n, 'SOL'); assert.equal(l.balance('fees:accrued:sol', 'SOL'), 200n);
  assert.deepEqual(f.sweep('s1', 'sol', 'SOL'), { swept: 0n, reason: 'below sweep minimum' });
  f.charge('d', 'sol', 'u', 'free', 40_000n, 'SOL');
  assert.equal(f.sweep('s1', 'sol', 'SOL').swept, 600n); assert.equal(f.sweep('s1', 'sol', 'SOL').swept, 0n);
  f.charge('e', 'sol', 'u', 'free', 50_000n, 'SOL'); assert.equal(f.sweep('s1', 'sol', 'SOL').swept, 0n);   // same id never debits again
  assert.equal(f.sweep('s2', 'sol', 'SOL').swept, 500n); assert.equal(l.balance('revenue', 'SOL'), 1100n);
  assert.equal(f.sweep('x', 'evm', 'ETH').swept, 0n); zero(l, 'ETH'); zero(l, 'SOL');
});
test('referral: sticky first wins, immutable, no self/cycle, token split, confirmed-only, reorg, single claim', () => {
  const book = new ReferralBook({ commissionBps: 2000, tokenSplitBps: 5000 }); const l = new Ledger();
  assert.equal(book.attribute('u', 'u'), 'ignored'); assert.equal(book.attribute('u', 'r1'), 'sticky');
  assert.equal(book.attribute('u', 'r2'), 'ignored'); assert.equal(book.referrerOf('u'), 'r1');
  assert.equal(book.attribute('r1', 'u'), 'ignored');                         // cycle
  assert.equal(book.attribute('u', 'r2', 'TOK'), 'token-split');
  assert.equal(book.attribute('u', 'r3', 'TOK'), 'ignored');                  // first token link immutable
  const unconfirmed = { ...trade('t0'), confirmed: false };
  assert.equal(accrue(l, unconfirmed, book.referralsFor('u', 'TOK'), 0, { selfReferral: false }), 'unconfirmed'); assert.equal(l.entries.length, 0);
  accrue(l, trade('t1'), book.referralsFor('u', 'TOK'), 0, { selfReferral: false });   // 20% of 1000 split 50/50
  assert.equal(l.balance('rewards:r1', 'ETH'), 100n); assert.equal(l.balance('rewards:r2', 'ETH'), 100n);
  accrue(l, trade('t2'), book.referralsFor('u', 'OTHER'), 0, { selfReferral: false });  // no split for other tokens
  assert.equal(l.balance('rewards:r1', 'ETH'), 300n); assert.equal(l.balance('rewards:r2', 'ETH'), 100n);
  assert.equal(l.claim('c1', 'r1', 'ETH', 300n), true); assert.equal(l.claim('c1', 'r1', 'ETH', 300n), false);
  assert.equal(l.balance('payout:r1', 'ETH'), 300n); assert.throws(() => l.claim('c2', 'r1', 'ETH', 1n));
  assert.throws(() => accrue(l, trade('t9'), [{ referrer: 'x', commissionBps: 9000 }], 2000, { selfReferral: false }));
  // reorg of an unclaimed trade restores balances
  assert.equal(reverseAccrual(l, 't1'), true); assert.equal(reverseAccrual(l, 't1'), false);
  assert.equal(l.balance('rewards:r2', 'ETH'), 0n); zero(l, 'ETH');
  assert.equal(l.balance('revenue', 'ETH'), 800n);
});
test('campaign boosts cashback only inside window, max not stacked, capped', () => {
  const cs = [{ id: 'a', boostBps: 300, start: 100, end: 200 }, { id: 'b', boostBps: 500, start: 150, end: 300, tokens: ['T'] }];
  assert.equal(effectiveCashbackBps(100, cs, 50, 'T'), 100); assert.equal(effectiveCashbackBps(100, cs, 120, 'T'), 400);
  assert.equal(effectiveCashbackBps(100, cs, 160, 'T'), 600); assert.equal(effectiveCashbackBps(100, cs, 160, 'Z'), 400);
  assert.equal(effectiveCashbackBps(100, cs, 200, 'Z'), 100); assert.equal(effectiveCashbackBps(9900, cs, 160, 'T'), 10_000);
  const l = new Ledger(); accrue(l, trade('t'), undefined, effectiveCashbackBps(100, cs, 120, 'T'), { selfReferral: false });
  assert.equal(l.balance('rewards:u1', 'ETH'), 40n); zero(l, 'ETH');
});
const ct = (o: Partial<CompTrade> & { id: string; user: string }): CompTrade => ({ token: 'T', notional: 1000n, t: 50, confirmed: true, flagged: false, source: 'platform', ...o });
test('competition: platform-only confirmed unflagged volume, min size, cap, reorg, ties, idempotent prizes', () => {
  const l = new Ledger(); l.post('fund', 'fund', 'USD', [['marketing', -1000n], ['prize:pool', 1000n]]);
  const c = new Competition(l, { id: 'c1', start: 0, end: 100, asset: 'USD', minTradeNotional: 100n, perUserTokenCap: 1500n, prizes: [600n, 300n, 100n] });
  assert.equal(c.record(ct({ id: '1', user: 'a', source: 'venue' })).reason, 'not platform volume');
  assert.equal(c.record(ct({ id: '2', user: 'a', confirmed: false })).reason, 'unconfirmed');
  assert.equal(c.record(ct({ id: '3', user: 'a', flagged: true })).reason, 'flagged');
  assert.equal(c.record(ct({ id: '4', user: 'a', notional: 99n })).reason, 'below min trade size');
  assert.equal(c.record(ct({ id: '5', user: 'a', t: 100 })).reason, 'outside window');
  accrue(l, trade('wash', 'a'), undefined, 0, { selfReferral: false, wash: true });       // abuse audit also blocks
  assert.equal(c.record(ct({ id: 'wash', user: 'a' })).reason, 'flagged');
  assert.equal(c.record(ct({ id: '6', user: 'a' })).counted, 1000n); assert.equal(c.record(ct({ id: '6', user: 'a' })).reason, 'duplicate');
  assert.equal(c.record(ct({ id: '7', user: 'a' })).counted, 500n);                         // capped at 1500 per token
  assert.equal(c.record(ct({ id: '8', user: 'a' })).reason, 'per-token cap reached');
  assert.equal(c.record(ct({ id: '9', user: 'a', token: 'U', notional: 200n })).counted, 200n);
  c.record(ct({ id: '10', user: 'b', notional: 1000n })); c.record(ct({ id: '11', user: 'b', notional: 700n }));   // b = 1700
  c.record(ct({ id: '12', user: 'z', notional: 1700n })); c.record(ct({ id: '13', user: 'c', notional: 1700n }));  // ties at 1700
  assert.deepEqual(c.leaderboard().map(r => r.user + r.volume), ['a1700', 'b1500', 'c1500', 'z1500']);   // a spans two tokens; b,c,z capped at 1500 on T; ties by user id
  assert.equal(c.reverse('13'), true); assert.equal(c.reverse('13'), false);
  assert.deepEqual(c.leaderboard().map(r => r.user), ['a', 'b', 'z']);
  assert.throws(() => c.payPrizes(50));
  assert.equal(c.payPrizes(100), 3); assert.equal(c.payPrizes(100), 0);
  assert.equal(l.balance('rewards:a', 'USD'), 600n); assert.equal(l.balance('rewards:b', 'USD'), 300n); assert.equal(l.balance('rewards:z', 'USD'), 100n);
  assert.equal(l.balance('prize:pool', 'USD'), 0n); zero(l, 'USD');
  assert.equal(c.reverse('12'), false); assert.equal(c.record(ct({ id: '99', user: 'q' })).reason, 'finalized');
  assert.equal(l.claim('pc1', 'a', 'USD', 600n), true); assert.equal(l.claim('pc1', 'a', 'USD', 600n), false);
});
