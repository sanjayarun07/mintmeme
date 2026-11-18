/** TEST-ONLY secp256k1 signing with throwaway keys (random nonce, low-s), so tests can make signed transactions and personal_sign signatures without Foundry. */
import { randomBytes } from 'node:crypto';
import { N, pointOf, addressOf, personalHash } from '../src/secp256k1.ts';
import { keccak256, hexToBytes, bytesToHex } from '../src/keccak.ts';
import { rlpEncode } from '../src/httpsigner.ts';

const modN = (a: bigint) => ((a % N) + N) % N;
function invN(a: bigint) { let r = 1n, b = modN(a), e = N - 2n; while (e > 0n) { if (e & 1n) r = r * b % N; b = b * b % N; e >>= 1n; } return r; }
export interface TestKey { priv: bigint; address: string }
export function testKey(): TestKey { const priv = modN(BigInt('0x' + randomBytes(32).toString('hex'))) || 1n; return { priv, address: addressOf(pointOf(priv)) }; }
export function signDigest(k: TestKey, hash: Uint8Array): { r: bigint; s: bigint; yParity: number } {
  for (;;) {
    const nonce = modN(BigInt('0x' + randomBytes(32).toString('hex'))); if (!nonce) continue;
    const [rx, ry] = pointOf(nonce), r = modN(rx); if (!r) continue;
    let s = modN(invN(nonce) * (BigInt(bytesToHex(hash)) + r * k.priv)); if (!s) continue;
    let yParity = Number(ry & 1n); if (s > N / 2n) { s = N - s; yParity ^= 1; }
    return { r, s, yParity };
  }
}
export function personalSign(k: TestKey, message: string): string {
  const { r, s, yParity } = signDigest(k, personalHash(message));
  return '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + (27 + yParity).toString(16);
}
const q = (n: bigint | number) => { const v = BigInt(n); return v === 0n ? new Uint8Array() : hexToBytes('0x' + (v.toString(16).length % 2 ? '0' : '') + v.toString(16)); };
export interface Tx1559 { chainId: number; nonce: number; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gasLimit: bigint; to: string; value: bigint; data: string }
/** A signed type-2 transaction (raw hex) for `t`, signed by `k`. */
export function signTx(k: TestKey, t: Tx1559): string {
  const fields = [q(t.chainId), q(t.nonce), q(t.maxPriorityFeePerGas), q(t.maxFeePerGas), q(t.gasLimit), hexToBytes(t.to), q(t.value), t.data === '0x' ? new Uint8Array() : hexToBytes(t.data), []];
  const { r, s, yParity } = signDigest(k, keccak256(new Uint8Array([0x02, ...rlpEncode(fields)])));
  return bytesToHex(new Uint8Array([0x02, ...rlpEncode([...fields, q(yParity), q(r), q(s)])]));
}
