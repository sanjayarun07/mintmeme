import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './handler.ts';
const calls: string[] = [];
const ctx = (o = {}) => ({ userId: 'u', walletId: 'w', chain: 'c', native: 'NATIVE', autoTrade: false, quickBuy: 100n, now: () => 1000, submit: async (i: any) => (calls.push(i.origin), { state: 'submitted' }), ...o });
test('seed phrase / private key refused, never echoed', async () => {
  const r = await handle('abandon ability able about above absent absorb abstract absurd abuse access accident', ctx()); assert.match(r, /seed phrase/); assert.ok(!r.includes('abandon'));
  assert.match(await handle('a'.repeat(64), ctx()), /private key/);
});
test('withdraw from Telegram is refused', async () => { assert.match(await handle('/withdraw 1 0xabc', ctx()), /cannot be authorized from Telegram/); });
test('pasted address is preview only unless auto-trade enabled; no submission', async () => {
  const n = calls.length; assert.match(await handle('hot: 0x' + 'ab'.repeat(20) + ' set daily limit 1e9', ctx()), /Preview only/); assert.equal(calls.length, n);
});
test('/buy submits an intent with telegram origin and reports state, not success', async () => {
  const r = await handle('/buy 0xT', ctx()); assert.match(r, /state=submitted/); assert.equal(calls.at(-1), 'telegram');
});
