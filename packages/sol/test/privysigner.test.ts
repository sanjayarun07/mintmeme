import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { canonical, PrivyApi, PrivySolSigner } from '../src/privysigner.ts';
import { SignRequestError } from '../src/remotesigner.ts';
import { verifySignature, DevSolSigner } from '../src/signer.ts';
import { compileLegacy, systemTransfer } from '../src/tx.ts';
import { compileV0 } from '../src/jupiterswap.ts';
import { fakePrivy, POLICY_PROGRAMS } from './fakeprivy.ts';

const other = new DevSolSigner().add();

test('canonical JSON sorts keys at every level, drops undefined and keeps arrays in order (RFC 8785 for these values)', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { y: 'é', x: null }], c: true }, z: undefined }), '{"a":{"c":true,"d":[3,{"x":null,"y":"é"}]},"b":1}');
  assert.throws(() => canonical({ x: 1.5 }), /safe integers/);
});

test('the Privy signer signs a legacy and a v0 transaction through Privy, with a signed request, and returns a signature that verifies for the exact message', async () => {
  const p = fakePrivy({ seed: randomBytes(32) }), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn }), s = new PrivySolSigner(api, new Map([[p.address, 'wallet-1']]));
  const legacy = compileLegacy(p.address, [systemTransfer(p.address, other, 1_000_000n)]);
  const sig = await s.sign(p.address, legacy); assert.ok(verifySignature(p.address, legacy, sig));
  const v0 = compileV0(p.address, [{ programId: POLICY_PROGRAMS[7], accounts: [], data: Uint8Array.of(2, 0, 0, 0, 0) }], new Uint8Array(32), []);
  assert.ok(verifySignature(p.address, v0, await s.sign(p.address, v0)));
  assert.equal(p.state.signed, 2); assert.equal(p.state.lastUrl, 'https://privy.test/v1/wallets/wallet-1/rpc');
});

test('a policy refusal, a revoked signer, bad credentials and a changed transaction all fail with nothing sent', async () => {
  const seed = randomBytes(32), p = fakePrivy({ seed }), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn }), s = new PrivySolSigner(api, new Map([[p.address, 'wallet-1']]));
  const big = compileLegacy(p.address, [systemTransfer(p.address, other, 60_000_000n)]);
  await assert.rejects(s.sign(p.address, big), (e: any) => e instanceof SignRequestError && /Policy violation: SOL transfer above the cap.*nothing was sent/.test(e.message));
  const stranger = compileLegacy(p.address, [{ program: other, data: Uint8Array.of(1), keys: [] }]);
  await assert.rejects(s.sign(p.address, stranger), /is not allowed.*nothing was sent/);
  p.state.delegated = false; await assert.rejects(s.sign(p.address, compileLegacy(p.address, [systemTransfer(p.address, other, 1n)])), /No valid authorization.*nothing was sent/); p.state.delegated = true;
  const wrong = new PrivySolSigner(new PrivyApi({ ...p.cfg, appSecret: 'wrong-secret-0123456789abcdef0123456789abcdef', fetchFn: p.fetchFn }), new Map([[p.address, 'wallet-1']]));
  await assert.rejects(wrong.sign(p.address, compileLegacy(p.address, [systemTransfer(p.address, other, 1n)])), /Invalid app credentials/);
  // a different request-signing key: Privy refuses the request
  const forged = new PrivySolSigner(new PrivyApi({ ...p.cfg, authKey: fakePrivy({ seed }).cfg.authKey, fetchFn: p.fetchFn }), new Map([[p.address, 'wallet-1']]));
  await assert.rejects(forged.sign(p.address, compileLegacy(p.address, [systemTransfer(p.address, other, 1n)])), /Invalid authorization signature/);
  // Privy (or anything in between) changes the transaction: the returned signature does not match the engine's message and is refused
  const msg = compileLegacy(p.address, [systemTransfer(p.address, other, 1n)]);
  const t = new PrivySolSigner({ signTransaction: async (id: string, tx: string) => { const raw = Buffer.from(tx, "base64"); raw[1 + 64 + 3 + 1 + 96 + 5] ^= 1;   // a byte of the blockhash: still within the policy, but not the engine's message
  return api.signTransaction(id, raw.toString('base64')); } } as any, new Map([[p.address, 'wallet-1']]));
  await assert.rejects(t.sign(p.address, msg), /does not match this transaction/);
  assert.equal(p.state.signed, 1, 'only the tampered one was signed by Privy, and the engine refused it');
  await assert.rejects(s.sign(other, msg), /no Privy wallet is set up/);
});

test('delegation is confirmed with Privy: the wallet must exist, carry this app\'s signer, and that signer must carry this app\'s policy', async () => {
  const p = fakePrivy({ seed: randomBytes(32) }), api = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn });
  assert.deepEqual(await api.delegation(p.address), { ok: true, walletId: 'wallet-1' });
  assert.match(((await api.delegation(other)) as any).why, /not a Privy wallet/);
  p.state.delegated = false; assert.match(((await api.delegation(p.address)) as any).why, /not allowed automatic trading/);
  p.state.delegated = 'other-policy'; assert.match(((await api.delegation(p.address)) as any).why, /not limited by this app's trading policy/);
  // seen on mainnet 2026-11-17: the policy's rules were for signAndSendTransaction, so Privy denied every signTransaction. Caught before switching, with the fix named.
  p.state.delegated = true; p.state.policyMethod = 'signAndSendTransaction';
  assert.match(((await api.delegation(p.address)) as any).why, /no ALLOW rule for the method signTransaction/);
  await assert.rejects(new PrivySolSigner(api, new Map([[p.address, 'wallet-1']])).sign(p.address, compileLegacy(p.address, [systemTransfer(p.address, other, 1n)])), /policy violation.*nothing was sent/);
});
