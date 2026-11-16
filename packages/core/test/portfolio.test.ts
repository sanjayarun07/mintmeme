import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE } from '../src/types.ts';
import type { Fill } from '../src/types.ts';
import { Portfolio } from '../src/portfolio.ts';
import { world, TOK } from './fixtures.ts';

const fill = (o: Partial<Fill> = {}): Fill => ({ spent: 0n, received: 0n, platformFee: 0n, venueFee: 0n, networkFee: 0n, quotedOut: 0n, shortfall: 0n, ...o });
const buy = (id: string, spent: bigint, received: bigint, extra: Partial<Fill> = {}, venue = 'curve') => ({ id, userId: 'u1', chain: 'c', tokenIn: NATIVE, tokenOut: TOK, venue, state: 'finalized' as const, ts: 1, fill: fill({ spent, received, ...extra }) });
const sell = (id: string, spent: bigint, received: bigint, extra: Partial<Fill> = {}, venue = 'curve') => ({ id, userId: 'u1', chain: 'c', tokenIn: TOK, tokenOut: NATIVE, venue, state: 'confirmed' as const, ts: 2, fill: fill({ spent, received, ...extra }) });
const px = (num: bigint, den = 1n) => new Map([[`c|${TOK}`, { num, den }]]);

test('only confirmed fills count; duplicates and revokes', () => {
  const p = new Portfolio();
  assert.equal(p.recordTrade({ ...buy('a', 100n, 1000n), state: 'submitted' }).accepted, false);
  assert.equal(p.recordTrade({ ...buy('a', 100n, 1000n), state: 'unresolved' }).accepted, false);
  assert.equal(p.positions('u1').length, 0);
  assert.equal(p.recordTrade(buy('a', 100n, 1000n)).accepted, true);
  assert.equal(p.recordTrade(buy('a', 100n, 1000n)).reason, 'duplicate');
  assert.equal(p.position('u1', 'c', TOK)!.balance, 1000n);
  assert.equal(p.revokeTrade('a'), true);   // reorg
  assert.equal(p.positions('u1').length, 0);
});

test('average cost, realized and unrealized P&L', () => {
  const p = new Portfolio();
  p.recordTrade(buy('b1', 100n, 1000n)); p.recordTrade(buy('b2', 300n, 1000n));   // cost 400 for 2000
  let pos = p.position('u1', 'c', TOK, px(1n, 4n))!;                               // price 0.25
  assert.deepEqual(pos.avgCost, { num: 400n, den: 2000n });
  assert.equal(pos.unrealizedPnl, 100n);
  p.recordTrade(sell('s1', 1000n, 300n));                                         // cost part 200, proceeds 300
  pos = p.position('u1', 'c', TOK, px(1n, 4n))!;
  assert.equal(pos.realizedPnl, 100n); assert.equal(pos.balance, 1000n); assert.equal(pos.knownCost, 200n);
  assert.equal(pos.unrealizedPnl, 50n);
  assert.equal(p.position('u1', 'c', TOK)!.unrealizedPnl, null, 'no price => null');
});

test('transfers/airdrops keep UNKNOWN basis; user-supplied basis carries provenance', () => {
  const p = new Portfolio();
  p.recordTransferIn({ id: 't1', userId: 'u1', chain: 'c', token: TOK, qty: 500n, ts: 1 });
  let pos = p.position('u1', 'c', TOK, px(1n))!;
  assert.equal(pos.unknownQty, 500n); assert.equal(pos.avgCost, null); assert.equal(pos.unrealizedPnl, null);
  assert.deepEqual(pos.basisSources, ['unknown_transfer']);
  p.recordTrade(buy('b', 100n, 500n));
  pos = p.position('u1', 'c', TOK, px(1n))!;
  assert.equal(pos.unrealizedPnl, null, 'mixed known/unknown => total unknown'); assert.equal(pos.unrealizedKnownPortion, 400n);
  p.recordTrade(sell('s', 500n, 400n));   // sell half pro-rata: realized only on known half
  pos = p.position('u1', 'c', TOK)!;
  assert.equal(pos.realizedPnl, 200n - 50n); assert.equal(pos.realizedUnknownProceeds, 200n);
  const q = new Portfolio();
  q.recordTransferIn({ id: 't', userId: 'u1', chain: 'c', token: TOK, qty: 100n, ts: 1, basis: { cost: 50n, costToken: NATIVE, provenance: 'user_supplied' } });
  const qp = q.position('u1', 'c', TOK, px(1n))!;
  assert.deepEqual(qp.basisSources, ['user_supplied']); assert.equal(qp.unrealizedPnl, 50n);
});

test('fees split platform/venue/network; volume kept separate from venue volume', () => {
  const p = new Portfolio();
  p.recordTrade(buy('b', 1000n, 5000n, { platformFee: 10n, venueFee: 3n, networkFee: 7n }));
  p.recordTrade(sell('s', 1000n, 400n, { platformFee: 10n, venueFee: 2n, networkFee: 7n }));
  const f = p.fees('u1');
  assert.deepEqual(f.platform, { [NATIVE]: 10n, [TOK]: 10n }); assert.deepEqual(f.venue, { [NATIVE]: 3n, [TOK]: 2n }); assert.deepEqual(f.network, { [NATIVE]: 14n });
  p.recordVenueVolume('curve', TOK, 9_999_999n);
  assert.deepEqual(p.platformVolume('u1'), { [NATIVE]: 1400n });
  assert.equal(p.venueVolume('curve', TOK), 9_999_999n);
  assert.equal(p.history('u1').length, 2); assert.equal(p.history('u1')[1].side, 'sell');
});

test('migration continuity: venue change keeps position and history', () => {
  const p = new Portfolio();
  p.recordTrade(buy('b1', 100n, 1000n, {}, 'curve'));
  p.recordMigration('c', TOK, 'curve', 'curve-pool', 5);
  p.recordTrade(sell('s1', 400n, 90n, {}, 'curve-pool'));
  const pos = p.position('u1', 'c', TOK)!;
  assert.equal(p.positions('u1').length, 1);
  assert.deepEqual(pos.venues.sort(), ['curve', 'curve-pool']); assert.equal(pos.balance, 600n); assert.equal(pos.realizedPnl, 90n - 40n);
  assert.equal(p.migrationsOf('c', TOK).length, 1); assert.equal(p.history('u1', TOK).length, 2);
});

test('integrates with real engine fill', async () => {
  const w = world();
  await w.engine.submit(w.intent({ idempotencyKey: 'x' })); w.chain.mine(4);
  const r = await w.engine.advance('x');
  const p = new Portfolio();
  assert.equal(p.recordTrade({ id: r.key, userId: 'u1', chain: 'sim-evm', tokenIn: NATIVE, tokenOut: TOK, venue: r.quote!.venue, state: r.state, fill: r.fill!, ts: 1 }).accepted, true);
  const pos = p.position('u1', 'sim-evm', TOK)!;
  assert.equal(pos.balance, w.chain.balance('w1', TOK)); assert.equal(pos.knownCost, 10_000n); assert.equal(pos.fees.platform[NATIVE], 100n);
});

test('oversold flagged, never negative', () => {
  const p = new Portfolio(); p.recordTrade(buy('b', 100n, 100n)); p.recordTrade(sell('s', 150n, 50n));
  const pos = p.position('u1', 'c', TOK)!; assert.equal(pos.balance, 0n); assert.equal(pos.oversold, true);
});
