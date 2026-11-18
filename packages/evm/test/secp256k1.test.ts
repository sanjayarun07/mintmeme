import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalSigner, signerOf, decodeEip1559, recoverAddress, personalHash } from '../src/index.ts';
import { testKey, personalSign, signTx, signDigest } from './ecdsa.ts';

// made with Foundry's cast and anvil's public test key #1 (0x70997970...): `cast wallet sign "memedesk link test"` and `cast mktx ... --chain 8453 --nonce 7`
const ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SIG = '0x7dceb08d3cc079b252d920b493e050eedb73e3f1df56dfd5e260e659d13fb6c42fac7a5b3851ddf0708d287c93eaafb1f5040be81bbdc5dac563881a016689a21b';
const RAW = '0x02f872822105078405f5e100847735940083030d40944752ba5dbc23f44d87826276bf6fd6b1c372ad248203e883abcdefc080a0c6521a7e15754d2670a7adfff8053fcb832e77cd983abd4f5e3a916fe743f1f3a016765e59af6d2d067570a60f1809bf03a5d1efab55d9aa5e0b41ded54512e0ce';

test('recovers the signer of a personal_sign message and of a Base transaction made by Foundry', () => {
  assert.equal(personalSigner('memedesk link test', SIG), ADDR);
  assert.notEqual(personalSigner('memedesk link test!', SIG), ADDR, 'another message recovers another address');
  assert.equal(signerOf(RAW), ADDR); assert.equal(decodeEip1559(RAW).chainId, 8453n);
});

test('round trip with throwaway keys: what we sign recovers to the key, and anything changed does not', () => {
  const k = testKey();
  assert.equal(personalSigner('hello', personalSign(k, 'hello')), k.address);
  const raw = signTx(k, { chainId: 8453, nonce: 3, maxPriorityFeePerGas: 1000n, maxFeePerGas: 5_000_000n, gasLimit: 150_000n, to: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', value: 10n ** 15n, data: '0x7ff36ab5' });
  assert.equal(signerOf(raw), k.address);
  const flipped = raw.slice(0, 30) + (raw[30] === '0' ? '1' : '0') + raw.slice(31);   // one changed field byte: still decodes, recovers someone else (or fails)
  assert.ok((() => { try { return signerOf(flipped) !== k.address; } catch { return true; } })());
  const { r, s, yParity } = signDigest(k, personalHash('x')); assert.equal(recoverAddress(personalHash('x'), r, s, yParity), k.address);
});

test('malformed signatures are refused', () => {
  assert.throws(() => personalSigner('m', '0x1234'), /65 bytes/);
  assert.throws(() => recoverAddress(personalHash('m'), 0n, 1n, 0), /out of range/);
  assert.throws(() => recoverAddress(personalHash('m'), 1n, 1n, 2), /recovery id/);
});
