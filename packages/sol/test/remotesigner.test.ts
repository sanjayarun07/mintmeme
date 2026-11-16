import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSolSigner, SignRequestError } from '../src/remotesigner.ts';
import { DevSolSigner } from '../src/signer.ts';

const wallet = new DevSolSigner(), addr = wallet.add(), other = new DevSolSigner(), otherAddr = other.add();
const msg = new TextEncoder().encode('a transaction message');

test('the remote signer parks a request, accepts only a signature that verifies for that wallet and message, and resolves the engine\'s wait', async () => {
  const r = new RemoteSolSigner({ timeoutMs: 5000 }); const p = r.sign(addr, msg); const [req] = r.pending(addr); assert.ok(req); assert.equal(r.pending(otherAddr).length, 0);
  assert.throws(() => r.submit(req.id, other.sign(otherAddr, msg)), SignRequestError);                       // someone else's key
  assert.throws(() => r.submit(req.id, wallet.sign(addr, new Uint8Array([...msg, 1]))), SignRequestError);   // a changed message
  assert.throws(() => r.submit(req.id, new Uint8Array(10)), SignRequestError);                              // not a signature
  assert.equal(r.pending(addr).length, 1, 'bad signatures leave the request open');
  const good = wallet.sign(addr, msg); r.submit(req.id, good); assert.deepEqual(await p, good); assert.equal(r.pending(addr).length, 0);
  assert.throws(() => r.submit(req.id, good), /unknown or expired/);
});

test('declining, disconnecting and a timeout all fail the signing with nothing sent', async () => {
  const r = new RemoteSolSigner({ timeoutMs: 30 });
  const a = r.sign(addr, msg); r.reject(r.pending()[0].id); await assert.rejects(a, /declined/);
  const b = r.sign(addr, msg); r.cancelAll(); await assert.rejects(b, /disconnected/);
  await assert.rejects(r.sign(addr, msg), /did not sign in time/);
  assert.equal(r.pending().length, 0);
});
