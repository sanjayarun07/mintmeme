import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityFees, percentile, limitFromSimulation, clampPrice } from '../src/priorityfee.ts';

test('percentile, limit from simulation and the cap', () => {
  assert.equal(percentile([], 75), 0n);
  assert.equal(percentile([5n, 1n, 9n, 3n], 50), 3n); assert.equal(percentile([5n, 1n, 9n, 3n], 75), 5n); assert.equal(percentile([5n, 1n, 9n, 3n], 100), 9n);
  assert.equal(limitFromSimulation(100_000), 120_000); assert.equal(limitFromSimulation(1_300_000), 1_400_000); assert.equal(limitFromSimulation(0), 1_000);
  assert.equal(clampPrice(1_000_000n, 200_000, 100_000n), 500_000n, '200k units at most 0.0001 SOL -> 500,000 micro-lamports per unit'); assert.equal(clampPrice(10n, 200_000, 100_000n), 10n);
});

test('the estimate reads recent fees for the trade\'s accounts, takes the percentile, applies the floor and cap, and is cached briefly', async () => {
  const calls: unknown[] = []; let now = 0, rows = [0, 0, 1_000, 50_000, 80_000, 2_000_000].map((f, i) => ({ slot: i, prioritizationFee: f }));
  const rpc = { call: async (m: string, p?: unknown[]) => { calls.push([m, p]); return rows; } };
  const f = new PriorityFees(rpc, { percentile: 75, minMicroLamports: 10_000n, maxLamports: 100_000n, cacheMs: 1000 }, () => now);
  assert.equal(await f.price(['A', 'B', 'A'], 150_000), 80_000n);
  assert.deepEqual(calls[0], ['getRecentPrioritizationFees', [['A', 'B']]], 'unique accounts');
  rows = [{ slot: 1, prioritizationFee: 9_000_000 }]; assert.equal(await f.price(['A', 'B'], 150_000), 80_000n, 'cached'); assert.equal(calls.length, 1);
  now = 2000; assert.equal(await f.price(['A', 'B'], 150_000), 666_666n, 'a spike is capped: 0.0001 SOL over 150,000 units');
  rows = []; now = 4000; assert.equal(await f.price(['C'], 150_000), 10_000n, 'quiet: the floor');
});

test('fee sharing: a buy pays from the SOL it spends, a sell from its guaranteed SOL out, split by each recipient\'s bps with the remainder to the last', async () => {
  const { feeTransfers } = await import('../src/priorityfee.ts');
  assert.deepEqual(feeTransfers('buy', 10_000_000n, 123n, 0, []), { net: 10_000_000n, total: 0n, each: [] }, 'no fee: nothing changes');
  const b = feeTransfers('buy', 10_000_000n, 0n, 100, [{ address: 'APP', bps: 70 }, { address: 'US', bps: 30 }]);
  assert.deepEqual(b, { net: 9_900_000n, total: 100_000n, each: [{ to: 'APP', lamports: 70_000n }, { to: 'US', lamports: 30_000n }] }, '1% of 0.01 SOL, 70/30');
  const s = feeTransfers('sell', 5_000n, 2_000_001n, 50, [{ address: 'US', bps: 50 }]);
  assert.deepEqual(s, { net: 5_000n, total: 10_000n, each: [{ to: 'US', lamports: 10_000n }] }, 'a sell sells everything; the fee is 0.5% of the minimum SOL out');
  const r = feeTransfers('buy', 1_000n, 0n, 100, [{ address: 'A', bps: 1 }, { address: 'B', bps: 1 }, { address: 'C', bps: 1 }]);
  assert.equal(r.each.reduce((x, e) => x + e.lamports, 0n), r.total, 'shares always add up to the total');
  assert.throws(() => feeTransfers('buy', 1_000n, 0n, 100, []), /no fee wallet/);
});
