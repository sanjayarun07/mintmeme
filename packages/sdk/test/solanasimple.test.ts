import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleBody, toUnits } from '../src/solana.ts';

const W = 'To11111111111111111111111111111111111111112', o = { address: W, decimals: async () => 6, balance: async () => 1_000_000n };
test('plain units become the raw fields the Trader takes; raw fields still win; the linked wallet is the default', async () => {
  assert.deepEqual(await simpleBody('/v1/trades/buy', { mint: 'M', sol: '0.01', slippagePct: 3 }, o), { token: 'M', walletId: W, slippageBps: 300, amount: '10000000' });
  assert.deepEqual(await simpleBody('/v1/trades/sell', { mint: 'M', pct: 50 }, o), { token: 'M', walletId: W, pctBps: 5000 });
  assert.equal((await simpleBody('/v1/orders/limit-sell', { mint: 'M', pct: 25, priceUsd: 0.0000025 }, o)).amount, '250000', 'pct of the balance now');
  assert.equal((await simpleBody('/v1/orders/limit-buy', { mint: 'M', sol: '0.005', price: '0.00000003' }, o)).priceE18, '30000000000000', '3e-8 SOL per token, 6 decimals');
  const br = await simpleBody('/v1/orders/bracket', { mint: 'M', tokens: '1.5', tpUsd: '0.00001', slUsd: '0.000001', trailPct: 10 }, o);
  assert.deepEqual([br.amount, br.takeProfitUsd, br.stopLossUsd, br.trailBps], ['1500000', '0.00001', '0.000001', 1000]);
  assert.equal((await simpleBody('/v1/twap', { mint: 'M', side: 'buy', sol: '0.1', slices: 4, intervalS: 60 }, o)).total, '100000000');
  assert.equal((await simpleBody('/v1/quote', { mint: 'M', side: 'buy', sol: 1 }, o)).walletId, undefined, 'a quote names no wallet');
  assert.deepEqual(await simpleBody('/v1/trades/buy', { walletId: 'X', token: 'T', amount: '5', sol: '9' }, o), { walletId: 'X', token: 'T', amount: '5' }, 'raw fields win');
});
test('bad plain amounts are refused with a reason', async () => {
  assert.throws(() => toUnits('1e-3', 9, 'sol'), /plain positive decimal/); assert.throws(() => toUnits('0.0000000001', 9, 'sol'), /more than 9 decimals/); assert.throws(() => toUnits('0', 9, 'sol'), /above zero/);
  await assert.rejects(simpleBody('/v1/trades/sell', { mint: 'M', pct: 150 }, o), /between 0.01 and 100/);
  await assert.rejects(simpleBody('/v1/orders/limit-sell', { mint: 'M', pct: 10, priceUsd: '1' }, { ...o, balance: async () => 0n }), /holds none/);
});
