import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLoopback, LocalNode } from '../src/localnode.ts';

test('local-node harness refuses non-loopback URLs (real txs are never sent to public nodes)', () => {
  for (const u of ['https://eth-mainnet.g.alchemy.com/v2/x', 'http://10.0.0.5:8545', 'http://example.com'])
    assert.throws(() => new LocalNode(u), /non-loopback/);
  for (const u of ['http://127.0.0.1:8545', 'http://localhost:8547']) assert.doesNotThrow(() => assertLoopback(u));
});
