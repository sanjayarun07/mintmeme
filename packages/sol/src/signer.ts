/** Dev-only ed25519 signer for throwaway local keys, using node:crypto. Custody (HSM, MPC, enclave) is out of scope: the chain takes any `SolSigner`. */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { base58, b58decode } from './tx.ts';

export interface SolSigner { sign(wallet: string, message: Uint8Array): Uint8Array }
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex'), SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export class DevSolSigner implements SolSigner {
  private keys = new Map<string, ReturnType<typeof createPrivateKey>>();
  /** Create (or import from a 32-byte seed) a wallet; returns its base58 address. */
  add(seed: Uint8Array = randomBytes(32)): string {
    if (seed.length !== 32) throw new Error('seed must be 32 bytes');
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
    const address = base58(createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32));
    this.keys.set(address, priv); return address;
  }
  sign(wallet: string, message: Uint8Array): Uint8Array {
    const k = this.keys.get(wallet); if (!k) throw new Error(`no key for wallet ${wallet}`);
    return new Uint8Array(sign(null, message, k));
  }
  has(wallet: string) { return this.keys.has(wallet); }
}
export function verifySignature(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  return verify(null, message, createPublicKey({ key: Buffer.concat([SPKI, b58decode(address)]), format: 'der', type: 'spki' }), signature);
}
