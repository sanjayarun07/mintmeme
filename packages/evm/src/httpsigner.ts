import type { Eip1559Request, RawSigner } from './rpcchain.ts';
import { keccak256 } from './keccak.ts';
import { recoverAddress } from './secp256k1.ts';

/** Minimal RLP decoder, just enough to read an EIP-1559 transaction. */
export type Rlp = Uint8Array | Rlp[];
const hexOf = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
function rlpAt(b: Uint8Array, i: number): [Rlp, number] {
  const t = b[i]; if (t === undefined) throw new Error('rlp: truncated');
  const len = (o: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + (b[o + k] ?? (() => { throw new Error('rlp: truncated'); })()); return v; };
  if (t < 0x80) return [b.slice(i, i + 1), i + 1];
  if (t < 0xb8) { const n = t - 0x80; if (i + 1 + n > b.length) throw new Error('rlp: truncated'); return [b.slice(i + 1, i + 1 + n), i + 1 + n]; }
  if (t < 0xc0) { const ln = t - 0xb7, n = len(i + 1, ln), s = i + 1 + ln; if (s + n > b.length) throw new Error('rlp: truncated'); return [b.slice(s, s + n), s + n]; }
  let n: number, s: number; if (t < 0xf8) { n = t - 0xc0; s = i + 1; } else { const ln = t - 0xf7; n = len(i + 1, ln); s = i + 1 + ln; }
  if (s + n > b.length) throw new Error('rlp: truncated');
  const out: Rlp[] = []; let p = s; while (p < s + n) { const [v, np] = rlpAt(b, p); out.push(v); p = np; }
  return [out, s + n];
}
const num = (x: Rlp): bigint => { if (!(x instanceof Uint8Array)) throw new Error('rlp: expected bytes'); return x.length ? BigInt(hexOf(x)) : 0n; };

/** Reads the signed fields of a type-2 transaction. Throws if it is not a well-formed, signed EIP-1559 transaction. */
export function decodeEip1559(raw: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length % 2) throw new Error('raw transaction is not hex');
  const b = Uint8Array.from(Buffer.from(raw.slice(2), 'hex')); if (b[0] !== 0x02) throw new Error('raw transaction is not an EIP-1559 (type 2) transaction');
  const [f, end] = rlpAt(b, 1); if (end !== b.length) throw new Error('raw transaction has trailing bytes');
  if (!Array.isArray(f) || f.length !== 12) throw new Error('raw transaction does not have the 12 fields of a signed EIP-1559 transaction');
  const bytes = (x: Rlp) => { if (!(x instanceof Uint8Array)) throw new Error('rlp: expected bytes'); return x; };
  const r = num(f[10]), s = num(f[11]), yp = num(f[9]);
  if (yp > 1n || r === 0n || s === 0n) throw new Error('raw transaction is not signed');
  return { chainId: num(f[0]), nonce: num(f[1]), maxPriorityFeePerGas: num(f[2]), maxFeePerGas: num(f[3]), gasLimit: num(f[4]), to: hexOf(bytes(f[5])), value: num(f[6]), data: hexOf(bytes(f[7])) };
}

/** RLP encoding of bytes and nested lists (canonical). */
export function rlpEncode(x: Rlp): Uint8Array {
  const head = (n: number, short: number) => { if (n < 56) return [short + n]; const l: number[] = []; for (let v = n; v > 0; v = Math.floor(v / 256)) l.unshift(v % 256); return [short + 55 + l.length, ...l]; };
  if (x instanceof Uint8Array) return x.length === 1 && x[0] < 0x80 ? x : new Uint8Array([...head(x.length, 0x80), ...x]);
  const body = x.map(rlpEncode), n = body.reduce((s, b) => s + b.length, 0), out = new Uint8Array(head(n, 0xc0).length + n); out.set(head(n, 0xc0)); let p = out.length - n; for (const b of body) { out.set(b, p); p += b.length; }
  return out;
}
/** The address that signed a type-2 transaction: recovered from its signature over keccak256(0x02 ‖ rlp(the nine unsigned fields)). */
export function signerOf(raw: string): string {
  decodeEip1559(raw);   // well-formed and signed, or it throws
  const b = Uint8Array.from(Buffer.from(raw.slice(2), 'hex')), [f] = rlpAt(b, 1) as [Rlp[], number];
  const hash = keccak256(new Uint8Array([0x02, ...rlpEncode(f.slice(0, 9))]));
  return recoverAddress(hash, num(f[10]), num(f[11]), Number(num(f[9])));
}

/** Compares what the signing service returned with what we asked it to sign. Returns the first difference, or undefined when they agree. */
export function mismatch(raw: string, q: Eip1559Request): string | undefined {
  let d: ReturnType<typeof decodeEip1559>; try { d = decodeEip1559(raw); } catch (e) { return (e as Error).message; }
  const lc = (x: string) => x.toLowerCase(), data = q.data === '0x' ? '0x' : lc(q.data);
  if (d.chainId !== BigInt(q.chainId)) return `chain id ${d.chainId} is not ${q.chainId}`;
  if (d.nonce !== BigInt(q.nonce)) return `nonce ${d.nonce} is not ${q.nonce}`;
  if (lc(d.to) !== lc(q.to)) return `destination ${d.to} is not ${q.to}`;
  if (d.value !== q.value) return `value ${d.value} is not ${q.value}`;
  if (d.data !== data) return 'call data differs from what was requested';
  if (d.gasLimit !== q.gasLimit) return `gas limit ${d.gasLimit} is not ${q.gasLimit}`;
  if (d.maxFeePerGas !== q.maxFeePerGas) return `max fee ${d.maxFeePerGas} is not ${q.maxFeePerGas}`;
  if (d.maxPriorityFeePerGas !== q.maxPriorityFeePerGas) return `priority fee ${d.maxPriorityFeePerGas} is not ${q.maxPriorityFeePerGas}`;
  return undefined;
}

export interface HttpSignerOpts { url: string; token?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
/**
 * Signs through an external custody service (HSM gateway, MPC cluster, KMS wrapper): `POST <url>` with
 *   { wallet, to, data, value, nonce, chainId, gasLimit, maxFeePerGas, maxPriorityFeePerGas }  (numbers that can exceed 2^53 are decimal strings)
 * and expects { raw: "0x02..." } back. Before the transaction is used it is decoded and every field is compared with the request, so a faulty or
 * compromised service cannot change the destination, value, data, nonce or fees. It cannot be checked here WHO signed it (no signature recovery in this
 * package); the node rejects a bad signature, and a signature from the wrong key would spend from a different address.
 * The service decides whether to sign: our PolicySigner has already approved the intent, but the service should enforce its own limits too.
 */
export class HttpSigner implements RawSigner {
  constructor(private o: HttpSignerOpts) { if (!/^https?:\/\//.test(o.url)) throw new Error('HttpSigner url must start with http:// or https://'); }
  async sign(q: Eip1559Request): Promise<string> {
    const f = this.o.fetchImpl ?? fetch, ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await f(this.o.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
        body: JSON.stringify({ wallet: q.wallet, to: q.to, data: q.data, value: q.value.toString(), nonce: q.nonce, chainId: q.chainId, gasLimit: q.gasLimit.toString(), maxFeePerGas: q.maxFeePerGas.toString(), maxPriorityFeePerGas: q.maxPriorityFeePerGas.toString() }) });
    } catch (e) { throw new Error(`signing service unreachable: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`); } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`signing service refused (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body: any = await res.json().catch(() => undefined), raw = body?.raw;
    if (typeof raw !== 'string') throw new Error('signing service answered without a "raw" transaction');
    const bad = mismatch(raw, q); if (bad) throw new Error(`signing service returned a different transaction: ${bad}`);
    return raw;
  }
}
