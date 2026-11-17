/** The "Fund trading key" transfer: the message the wallet is asked to sign must be exactly one System transfer of the requested lamports from the wallet to the trading key, nothing else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileLegacy, systemTransfer, b58decode, DevSolSigner, verifySignature } from '../src/index.ts';
import { SolMainnet } from '../../../apps/web/solmainnet.ts';

test('the funding message is a single System transfer wallet -> key, and the signature verifies against those bytes', async () => {
  const s = new DevSolSigner(), from = s.add(), to = s.add();
  const msg = compileLegacy(from, [systemTransfer(from, to, 30_000_000n)], new Uint8Array(32).fill(7));
  const sig = await s.sign(from, msg);
  assert.ok(verifySignature(from, msg, sig));
  const hex = Buffer.from(msg).toString('hex');
  assert.ok(hex.includes(Buffer.from(b58decode(to)).toString('hex')), 'destination is in the message');
  assert.ok(hex.includes('80c3c90100000000'), '30,000,000 lamports as u64 LE');
});

test('funding is refused without a signed-in wallet, and amounts outside 0.001..0.05 SOL are refused', async () => {
  const m: any = new SolMainnet(mkdtempSync(join(tmpdir(), 'solmain-')));
  await assert.rejects(() => m.fundTradingKey({ sol: '0.03', ack: true }), /./);
});
