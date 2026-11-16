import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchlists, PriceAlerts, WalletAlerts, classify, CommunityBot, Trending } from '../src/alerts.ts';
import type { ChainEvent } from '../src/alerts.ts';

test('watchlist add/remove/limit', () => {
  const w = new Watchlists(2);
  assert.ok(w.add('u', 'a')); assert.ok(w.add('u', 'b')); assert.equal(w.add('u', 'c'), false); assert.ok(w.add('u', 'a'));
  w.add('v', 'a'); assert.deepEqual(w.watchers('a'), ['u', 'v']); w.remove('u', 'a'); assert.deepEqual(w.list('u'), ['b']);
});

test('price alert: one-shot fires once, tick dedupe', () => {
  const p = new PriceAlerts();
  p.add({ id: 'a1', userId: 'u', token: 'T', direction: 'above', threshold: 10 });
  assert.equal(p.evaluate('T', 9, 't1').length, 0);
  assert.equal(p.evaluate('T', 11, 't2').length, 1);
  assert.equal(p.evaluate('T', 12, 't3').length, 0);
  assert.equal(p.isActive('a1'), false);
});
test('price alert: repeating with hysteresis does not flap; tick redelivery ignored', () => {
  const p = new PriceAlerts();
  p.add({ id: 'r', userId: 'u', token: 'T', direction: 'below', threshold: 100, oneShot: false, hysteresisBps: 500 });
  assert.equal(p.evaluate('T', 99, '1').length, 1);
  assert.equal(p.evaluate('T', 99, '1').length, 0, 'same tick');
  assert.equal(p.evaluate('T', 101, '2').length, 0); assert.equal(p.evaluate('T', 99, '3').length, 0, 'not re-armed: only 1% above');
  assert.equal(p.evaluate('T', 106, '4').length, 0); assert.equal(p.evaluate('T', 99, '5').length, 1, 're-armed after >5% retreat');
  p.cancel('r'); assert.equal(p.evaluate('T', 106, '6').length + p.evaluate('T', 90, '7').length, 0);
});

const ev = (o: Partial<ChainEvent> = {}): ChainEvent => ({ chain: 'c', txHash: '0x1', logIndex: 0, blockHash: 'B1', blockNumber: 1, wallet: 'W', legs: [{ token: 'A', delta: -5n }, { token: 'B', delta: 9n }], valueUsd: 5000, ...o });
test('classification', () => {
  assert.equal(classify(ev()), 'swap');
  assert.equal(classify(ev({ legs: [{ token: 'A', delta: -5n }] })), 'transfer');
  assert.equal(classify(ev({ legs: [{ token: 'A', delta: -5n }], counterpartyIsBridge: true })), 'bridge');
  assert.equal(classify(ev({ legs: [{ token: 'A', delta: 5n }], fromKnownDistributor: true })), 'airdrop');
  assert.equal(classify(ev({ legs: [{ token: 'A', delta: 5n }] })), 'transfer', 'unknown sender is not an airdrop');
});
test('wallet alerts: threshold, whale, dedupe, reorg revoke then re-include', () => {
  const w = new WalletAlerts({ minValueUsd: 1000, whaleUsd: 100_000 });
  assert.equal(w.ingest(ev()), null, 'unwatched'); w.watch('W');
  assert.equal(w.ingest(ev({ valueUsd: 10 })), null);
  const a = w.ingest(ev())!; assert.equal(a.kind, 'swap'); assert.equal(a.whale, false);
  assert.equal(w.ingest(ev()), null, 'dedupe');
  assert.ok(w.ingest(ev({ logIndex: 1, valueUsd: 200_000 }))!.whale);
  const rv = w.revokeBlock('c', 'B1'); assert.equal(rv.length, 2); assert.equal(rv[0].reason, 'reorg');
  assert.equal(w.revokeBlock('c', 'B1').length, 0);
  assert.ok(w.ingest(ev({ blockHash: 'B2' })), 'same tx re-included after reorg alerts again');
});

test('community bot: authorization required, min buy, rate limit, dedupe, sink only on post', () => {
  const sent: string[] = [];
  const b = new CommunityBot({ maxPerWindow: 2, windowS: 60, sink: (g, t) => sent.push(g + ':' + t) });
  const n = (id: string, v: number, side: 'buy' | 'sell' = 'buy') => ({ eventKey: id, token: 'T', side, valueUsd: v, wallet: '0xABCDEF1234', ts: 0 });
  assert.deepEqual(b.notify('g', n('1', 999), 0), { post: false, reason: 'group not authorized' });
  assert.equal(b.authorize({ groupId: 'g', authorizedBy: '', authorizedAt: 1, evidence: 'x' }, { minBuyUsd: 100 }), false);
  assert.ok(b.authorize({ groupId: 'g', authorizedBy: 'admin1', authorizedAt: 1, evidence: 'msg#42' }, { minBuyUsd: 100 }));
  assert.equal((b.notify('g', n('1', 50), 0) as any).reason, 'below min buy');
  assert.ok(b.notify('g', n('2', 500), 1).post);
  assert.equal((b.notify('g', n('2', 500), 2) as any).reason, 'duplicate event');
  assert.equal((b.notify('g', n('3', 500, 'sell'), 2) as any).reason, 'sell notices disabled');
  assert.ok(b.notify('g', n('4', 500), 3).post);
  assert.equal((b.notify('g', n('5', 500), 4) as any).reason, 'rate limited');
  assert.ok(b.notify('g', n('6', 500), 70).post, 'window passed');
  assert.equal(sent.length, 3); assert.ok(!sent[0].includes('ABCDEF1234'), 'wallet masked');
  b.revoke('g'); assert.equal((b.notify('g', n('7', 500), 200) as any).reason, 'group not authorized'); assert.equal(sent.length, 3);
});

const cfg = { halfLifeS: 3600, perWalletCapUsd: 1000, roundTripWindowS: 600, minLiquidityUsd: 10_000, k: 5, windowS: 86_400 };
test('trending: per-wallet cap, unique-wallet weighting beats whale spam', () => {
  const t = new Trending(cfg); t.setLiquidity('WHALE', 50_000); t.setLiquidity('CROWD', 50_000);
  for (let i = 0; i < 50; i++) t.ingest({ eventKey: 'w' + i, token: 'WHALE', wallet: 'big', side: 'buy', valueUsd: 100_000, ts: 1000 });
  for (let i = 0; i < 6; i++) t.ingest({ eventKey: 'c' + i, token: 'CROWD', wallet: 'u' + i, side: 'buy', valueUsd: 800, ts: 1000 });
  const r = t.rank(1000); assert.equal(r[0].token, 'CROWD');
  assert.ok(r.find(x => x.token === 'WHALE')!.score <= 1.0001, 'one wallet = at most one wallet-equivalent');
});
test('trending: round-trip exclusion, min liquidity, age decay, dedupe', () => {
  const t = new Trending(cfg); t.setLiquidity('T', 50_000); t.setLiquidity('ILLIQ', 5);
  for (let i = 0; i < 6; i++) { t.ingest({ eventKey: 'b' + i, token: 'T', wallet: 'w' + i, side: 'buy', valueUsd: 1000, ts: 100 }); }
  for (let i = 0; i < 3; i++) t.ingest({ eventKey: 's' + i, token: 'T', wallet: 'w' + i, side: 'sell', valueUsd: 1000, ts: 200 });   // w0..w2 wash
  assert.equal(t.ingest({ eventKey: 's0', token: 'T', wallet: 'w0', side: 'sell', valueUsd: 1, ts: 200 }), false);
  t.ingest({ eventKey: 'i', token: 'ILLIQ', wallet: 'x', side: 'buy', valueUsd: 1000, ts: 100 });
  let r = t.rank(200); assert.equal(r.length, 1); assert.equal(r[0].uniqueWallets, 3);
  const later = t.rank(200 + 3600)[0].score, now = t.rank(200)[0].score;
  assert.ok(Math.abs(later - now / 2) < 1e-9, 'half-life decay');
});
test('trending public aggregate: k-anonymity, no per-user data', () => {
  const t = new Trending(cfg); t.setLiquidity('BIG', 1e6); t.setLiquidity('SMALL', 1e6);
  for (let i = 0; i < 5; i++) t.ingest({ eventKey: 'b' + i, token: 'BIG', wallet: 'secret-wallet-' + i, side: 'buy', valueUsd: 500, ts: 10 });
  for (let i = 0; i < 4; i++) t.ingest({ eventKey: 's' + i, token: 'SMALL', wallet: 'sw' + i, side: 'buy', valueUsd: 500, ts: 10 });
  const agg = t.publicAggregate(10);
  assert.deepEqual(agg.map(a => a.token), ['BIG']);
  assert.ok(agg.every(a => a.uniqueWallets >= 5));
  const s = JSON.stringify(agg); assert.ok(!s.includes('secret-wallet') && !s.includes('sw0'));
  assert.deepEqual(Object.keys(agg[0]).sort(), ['score', 'token', 'uniqueWallets']);
});
