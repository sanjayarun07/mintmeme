import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardedRpc, READ_ONLY } from '../../../packages/live/src/solreadonly.ts';
import { solSearch, solToken, solSimulate } from '../solroutes.ts';

test('the guarded RPC refuses every state-changing method before any network call', async () => {
  const g = new GuardedRpc('http://127.0.0.1:1');
  for (const m of ['sendTransaction', 'requestAirdrop', 'sendBundle', 'simulateBundle']) await assert.rejects(g.call(m, []), /refused/);
  assert.ok(!READ_ONLY.has('sendTransaction') && READ_ONLY.has('simulateTransaction'));
});

test('Solana routes reject bad input with a 400 and never need a network', async () => {
  const had = process.env.ALCHEMY_API_KEY; process.env.ALCHEMY_API_KEY = 'test-key';
  try {
    await assert.rejects(solSearch({ q: '' }), (e: any) => e.status === 400);
    await assert.rejects(solToken({ mint: 'nope' }), (e: any) => e.status === 400);
    await assert.rejects(solSimulate({ mint: 'nope', wallet: 'x' }), (e: any) => e.status === 400);
  } finally { if (had === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = had; }
});
