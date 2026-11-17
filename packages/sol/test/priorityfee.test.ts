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
