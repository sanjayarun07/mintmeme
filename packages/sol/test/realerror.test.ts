/** Errors on the real-funds routes must never say "simulation" or show raw lamports, and must say whether anything was sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realError } from '../../../apps/web/realerror.ts';
import { SolMainnet } from '../../../apps/web/solmainnet.ts';

test('a refusal (4xx) says nothing was sent, in SOL, with no mention of a simulation', () => {
  const e = realError(400, 'priority fee 20000000 lamports is above the cap');
  assert.equal(e.title, 'Not done');
  assert.equal(e.why, 'Priority fee 0.02 SOL is above the cap.');
  assert.match(e.fix, /Nothing was signed or sent/);
  assert.doesNotMatch(JSON.stringify(e), /simulation|lamports|Something went wrong/);
});

test('a policy refusal reads as a safety limit, a 401 as signed out, a 5xx points at the history', () => {
  assert.equal(realError(400, 'signer policy: exceeds per-tx limit').why, 'Safety limit: exceeds per-tx limit.');
  assert.equal(realError(401, 'sign in again').title, 'Signed out');
  const s = realError(502, 'The network refused the transfer'); assert.equal(s.title, 'Terminal error'); assert.match(s.fix, /Transaction history/);
});

test('returning the key\'s SOL is refused when the trading key is not the connected signer', async () => {
  const m: any = new SolMainnet(mkdtempSync(join(tmpdir(), 'solmain-')));
  await assert.rejects(() => m.tradingKeyReturn({ to: 'x', ack: true }), /./);
});
