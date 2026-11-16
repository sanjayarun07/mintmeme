/** Solana primitives with no dependencies: base58, ed25519 point test, program-derived addresses, legacy message and transaction encoding,
 *  and the instructions the engine needs (system transfer, SPL token sync/close, associated token account, compute budget, Raydium AMM v4 swapBaseIn).
 *  Instruction layouts: raydium-io/raydium-sdk-V2 (liquidity/instruction.ts), SPL token and associated-token programs, compute-budget program. */
import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(buf: Uint8Array): string {
  let n = 0n; for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; } return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`invalid base58 character '${c}'`); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  let z = 0; for (const c of s) { if (c === '1') z++; else break; }
  return Uint8Array.from([...new Array(z).fill(0), ...out]);
}
export function pubkeyBytes(a: string): Uint8Array { const b = b58decode(a); if (b.length !== 32) throw new Error(`address ${a} decodes to ${b.length} bytes, expected 32`); return b; }

// ---- ed25519 point test (needed to tell a program-derived address from a keypair address)
const P = 2n ** 255n - 19n, D = ((-121665n % P + P) % P) * modpow(121666n, P - 2n, P) % P;
function modpow(b: bigint, e: bigint, m: bigint) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
export function isOnCurve(pk: Uint8Array): boolean {
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? pk[i] & 0x7f : pk[i]);
  y %= P; const y2 = y * y % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const x2 = u * modpow(v, P - 2n, P) % P;
  return x2 === 0n || modpow(x2, (P - 1n) / 2n, P) === 1n;
}
export const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export function createProgramAddress(seeds: Uint8Array[], program: string): string {
  for (const s of seeds) if (s.length > 32) throw new Error('seed too long');
  const h = createHash('sha256').update(cat(...seeds, pubkeyBytes(program), new TextEncoder().encode('ProgramDerivedAddress'))).digest();
  if (isOnCurve(h)) throw new Error('on curve: not a valid program address');
  return base58(h);
}
export function findProgramAddress(seeds: Uint8Array[], program: string): { address: string; bump: number } {
  for (let bump = 255; bump >= 0; bump--) { try { return { address: createProgramAddress([...seeds, Uint8Array.of(bump)], program), bump }; } catch { /* on curve: next bump */ } }
  throw new Error('no viable bump');
}

// ---- instruction + message encoding
export interface Meta { pubkey: string; signer?: boolean; writable?: boolean }
export interface Ix { program: string; keys: Meta[]; data: Uint8Array }
export const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return new Uint8Array(b); };
export const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return new Uint8Array(b); };
export const shortvec = (n: number) => { const o: number[] = []; let v = n; for (;;) { const b = v & 0x7f; v >>= 7; if (v === 0) { o.push(b); break; } o.push(b | 0x80); } return Uint8Array.from(o); };

/** Legacy message. Fee payer is keys[0] of the first instruction's signer set (we pass it explicitly). */
export function compileLegacy(payer: string, ixs: Ix[], blockhash32: Uint8Array = new Uint8Array(32)): Uint8Array {
  const m = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (k: string, s: boolean, w: boolean) => { const e = m.get(k); m.set(k, { signer: (e?.signer ?? false) || s, writable: (e?.writable ?? false) || w }); };
  touch(payer, true, true);
  for (const ix of ixs) { for (const k of ix.keys) touch(k.pubkey, !!k.signer, !!k.writable); touch(ix.program, false, false); }
  const rank = (e: { signer: boolean; writable: boolean }) => e.signer ? (e.writable ? 0 : 1) : (e.writable ? 2 : 3);
  const order = [...m.entries()].sort((a, b) => a[0] === payer ? -1 : b[0] === payer ? 1 : rank(a[1]) - rank(b[1]));   // stable: keeps first-seen order inside a class
  const keys = order.map(([k]) => k), idx = (k: string) => keys.indexOf(k);
  const nSig = order.filter(([, e]) => e.signer).length, roSig = order.filter(([, e]) => e.signer && !e.writable).length, roUns = order.filter(([, e]) => !e.signer && !e.writable).length;
  const parts: Uint8Array[] = [Uint8Array.of(nSig, roSig, roUns), shortvec(keys.length), ...keys.map(pubkeyBytes), blockhash32, shortvec(ixs.length)];
  for (const ix of ixs) parts.push(Uint8Array.of(idx(ix.program)), shortvec(ix.keys.length), Uint8Array.from(ix.keys.map(k => idx(k.pubkey))), shortvec(ix.data.length), ix.data);
  return cat(...parts);
}
/** Unsigned transaction wire bytes: one all-zero signature slot per required signer. */
export function unsignedTx(message: Uint8Array): Uint8Array { const n = message[0]; return cat(shortvec(n), new Uint8Array(64 * n), message); }

// ---- instructions
export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
};
export const ataAddress = (owner: string, mint: string) => findProgramAddress([pubkeyBytes(owner), pubkeyBytes(PROGRAMS.token), pubkeyBytes(mint)], PROGRAMS.ata).address;
export const createAtaIdempotent = (payer: string, owner: string, mint: string): Ix => ({ program: PROGRAMS.ata, data: Uint8Array.of(1),
  keys: [{ pubkey: payer, signer: true, writable: true }, { pubkey: ataAddress(owner, mint), writable: true }, { pubkey: owner }, { pubkey: mint }, { pubkey: PROGRAMS.system }, { pubkey: PROGRAMS.token }] });
export const systemTransfer = (from: string, to: string, lamports: bigint): Ix => ({ program: PROGRAMS.system, data: cat(u32le(2), u64le(lamports)), keys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, writable: true }] });
export const syncNative = (account: string): Ix => ({ program: PROGRAMS.token, data: Uint8Array.of(17), keys: [{ pubkey: account, writable: true }] });

export interface PoolKeys { programId: string; id: string; authority: string; openOrders: string; targetOrders: string; baseVault: string; quoteVault: string;
  marketProgram: string; market: string; bids: string; asks: string; eventQueue: string; marketBaseVault: string; marketQuoteVault: string; marketAuthority: string }
export function raydiumSwapBaseIn(k: PoolKeys, userIn: string, userOut: string, owner: string, amountIn: bigint, minOut: bigint): Ix {
  const w = (pubkey: string): Meta => ({ pubkey, writable: true }), r = (pubkey: string): Meta => ({ pubkey });
  return { program: k.programId, data: cat(Uint8Array.of(9), u64le(amountIn), u64le(minOut)),
    keys: [r(PROGRAMS.token), w(k.id), r(k.authority), w(k.openOrders), w(k.targetOrders), w(k.baseVault), w(k.quoteVault), r(k.marketProgram), w(k.market), w(k.bids), w(k.asks), w(k.eventQueue),
      w(k.marketBaseVault), w(k.marketQuoteVault), r(k.marketAuthority), w(userIn), w(userOut), { pubkey: owner, signer: true }] };
}

// ---- more instructions
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const setComputeUnitLimit = (units: number): Ix => ({ program: COMPUTE_BUDGET, keys: [], data: cat(Uint8Array.of(2), u32le(units)) });
export const setComputeUnitPrice = (microLamports: bigint): Ix => ({ program: COMPUTE_BUDGET, keys: [], data: cat(Uint8Array.of(3), u64le(microLamports)) });
/** SPL token CloseAccount: the remaining lamports (including a wrapped-SOL balance) go to `destination`. */
export const closeAccount = (account: string, destination: string, owner: string): Ix => ({ program: PROGRAMS.token, data: Uint8Array.of(9),
  keys: [{ pubkey: account, writable: true }, { pubkey: destination, writable: true }, { pubkey: owner, signer: true }] });
/** Wire transaction from a compiled message and its signatures (one per required signer, in the message's signer order). */
export function wireTx(message: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  if (signatures.length !== message[0]) throw new Error(`message needs ${message[0]} signature(s), got ${signatures.length}`);
  for (const s of signatures) if (s.length !== 64) throw new Error('signature must be 64 bytes');
  return cat(shortvec(signatures.length), ...signatures, message);
}
