/** secp256k1 public-key RECOVERY (no dependencies): who signed an Ethereum transaction or a personal_sign message.
 *  Used to check that a signing service (Privy) signed with the wallet we asked for, and that a user who links a wallet controls it.
 *  Verification only: no private key is ever handled here. Plain BigInt arithmetic in Jacobian coordinates (a recovery takes a few milliseconds). */
import { keccak256, hexToBytes, bytesToHex } from './keccak.ts';

const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a: bigint, m = P) => { const r = a % m; return r < 0n ? r + m : r; };
function pow(b: bigint, e: bigint, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const inv = (a: bigint, m = P) => pow(a, m - 2n, m);   // both moduli are prime

type J = [bigint, bigint, bigint];   // Jacobian (X, Y, Z); Z = 0 is the point at infinity
const INF: J = [0n, 1n, 0n];
function dbl([x, y, z]: J): J {
  if (z === 0n || y === 0n) return INF;
  const s = mod(4n * x * y * y), m = mod(3n * x * x), x3 = mod(m * m - 2n * s);
  return [x3, mod(m * (s - x3) - 8n * y ** 4n), mod(2n * y * z)];
}
function add(a: J, b: J): J {
  if (a[2] === 0n) return b; if (b[2] === 0n) return a;
  const z1z1 = mod(a[2] * a[2]), z2z2 = mod(b[2] * b[2]);
  const u1 = mod(a[0] * z2z2), u2 = mod(b[0] * z1z1), s1 = mod(a[1] * b[2] * z2z2), s2 = mod(b[1] * a[2] * z1z1);
  if (u1 === u2) return s1 === s2 ? dbl(a) : INF;
  const h = mod(u2 - u1), r = mod(s2 - s1), hh = mod(h * h), hhh = mod(h * hh), v = mod(u1 * hh);
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), mod(h * a[2] * b[2])];
}
function mul(p: J, k: bigint): J { let r = INF, q = p; while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n; } return r; }
function affine([x, y, z]: J): [bigint, bigint] | undefined { if (z === 0n) return undefined; const zi = inv(z), zi2 = zi * zi % P; return [x * zi2 % P, y * zi2 % P * zi % P]; }
export const G: J = [GX, GY, 1n];
/** k·G in affine coordinates (tests use it to make keys). */
export function pointOf(k: bigint): [bigint, bigint] { const a = affine(mul(G, mod(k, N))); if (!a) throw new Error('bad scalar'); return a; }

const be32 = (n: bigint) => hexToBytes('0x' + n.toString(16).padStart(64, '0'));
/** Ethereum address (lowercase 0x...) of an uncompressed public key (x, y). */
export function addressOf([x, y]: [bigint, bigint]): string { return '0x' + bytesToHex(keccak256(new Uint8Array([...be32(x), ...be32(y)]))).slice(-40); }

/** The public key that made signature (r, s, yParity) over the 32-byte `hash`. Throws for a malformed signature. */
export function recoverPublicKey(hash: Uint8Array, r: bigint, s: bigint, yParity: number): [bigint, bigint] {
  if (hash.length !== 32) throw new Error('hash must be 32 bytes');
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature out of range');
  if (yParity !== 0 && yParity !== 1) throw new Error('bad recovery id');
  // R has x = r (r < p - n is so rare that x = r + n is never produced by real signers; it is not accepted here)
  const y2 = mod(r ** 3n + 7n), y = pow(y2, (P + 1n) / 4n); if (y * y % P !== y2) throw new Error('signature point is not on the curve');
  const R: J = [r, (y & 1n) === BigInt(yParity) ? y : P - y, 1n];
  const e = mod(BigInt(bytesToHex(hash)), N), ri = inv(r, N);
  const q = affine(add(mul(R, mod(s * ri, N)), mul(G, mod(-e * ri, N))));
  if (!q) throw new Error('signature does not recover a key');
  return q;
}
export function recoverAddress(hash: Uint8Array, r: bigint, s: bigint, yParity: number): string { return addressOf(recoverPublicKey(hash, r, s, yParity)); }

/** EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + byte length + message). */
export function personalHash(message: string | Uint8Array): Uint8Array {
  const m = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  return keccak256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
}
/** Who signed `message` with personal_sign. `signature` is 65 bytes hex (r ‖ s ‖ v, v = 27/28 or 0/1). */
export function personalSigner(message: string | Uint8Array, signature: string): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('signature must be 65 bytes of hex (0x + 130 hex digits)');
  const r = BigInt('0x' + signature.slice(2, 66)), s = BigInt('0x' + signature.slice(66, 130)), v = parseInt(signature.slice(130), 16);
  return recoverAddress(personalHash(message), r, s, v >= 27 ? v - 27 : v);
}
