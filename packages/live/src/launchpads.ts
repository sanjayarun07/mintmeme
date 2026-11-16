/** READ-ONLY launchpad readers: Pump.fun (Solana bonding curve) and Four.meme (BNB Smart Chain TokenManager). Nothing is signed or sent.
 *  Addresses, layouts and rules were read from official sources on 2026-11-14 (URLs below), never recalled. What the docs did NOT state is not guessed:
 *   - Pump.fun: the graduation threshold is not published, so we show "curve complete" and tokens left, never a progress percentage.
 *   - Raydium LaunchLab: the program id is official, but no byte offsets or exact pool seeds are published, so it is listed and NOT decoded.
 *   - Four.meme: progress is funds / maxFunds from the official Helper3 contract (percentage only; the docs give conflicting raise figures, so no BNB amount is claimed). */
import { createHash } from 'node:crypto';
import { findProgramAddress, pubkeyBytes, base58 } from '../../sol/src/tx.ts';
import { keccakHex } from '../../evm/src/keccak.ts';
import type { Rpc } from './rpc.ts';

export const PAD = {
  pump: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', pumpSwap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', source: 'https://github.com/pump-fun/pump-public-docs (docs/PUMP_PROGRAM_README.md, docs/PUMP_SWAP_README.md, idl/pump.json)' },
  launchLab: { program: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', source: 'https://docs.raydium.io/reference/program-addresses', decoded: false as const, why: 'byte offsets and pool seeds are not published; the docs say to consult the source, which is not public' },
  fourMeme: { tokenManager2: '0x5c952063c7fc8610FFDB798152D69F0B9550762b', tokenManager1: '0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC', helper3: '0xF251F83e40a78868FcfA3FA4599Dad6494E46034', source: 'https://github.com/four-meme-community/fourmeme-docs (docs/integration-guide.md, docs/trade-guide.md, abi/TokenManagerHelper3.lite.json)' },
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (h: string) => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (sig: string) => keccakHex(sig).replace(/^0x/, '').slice(0, 8);

/* ---------- Pump.fun ---------- */
/** Anchor account discriminator = first 8 bytes of sha256("account:BondingCurve"); computed here, not trusted from a doc summary. */
export const pumpDiscriminator = () => createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
export const bondingCurveAddress = (mint: string) => findProgramAddress([Buffer.from('bonding-curve'), pubkeyBytes(mint)], PAD.pump.program).address;   // seeds ["bonding-curve", mint] per the official README
export interface Curve { virtualToken: bigint; virtualQuote: bigint; realToken: bigint; realQuote: bigint; totalSupply: bigint; complete: boolean; creator?: string }
/** Borsh layout from idl/pump.json: five u64 then bool, right after the 8-byte discriminator. Later fields are not read. */
export function decodeCurve(d: Buffer): Curve | null {
  if (d.length < 49 || !d.subarray(0, 8).equals(pumpDiscriminator())) return null;
  // `creator` is the pubkey right after `complete` in the IDL field order (bytes 49..81); read when the account is long enough.
  return { virtualToken: d.readBigUInt64LE(8), virtualQuote: d.readBigUInt64LE(16), realToken: d.readBigUInt64LE(24), realQuote: d.readBigUInt64LE(32), totalSupply: d.readBigUInt64LE(40), complete: d[48] === 1, ...(d.length >= 81 ? { creator: base58(d.subarray(49, 81)) } : {}) };
}
export async function readPumpCurve(sol: Rpc, mint: string): Promise<Curve | null> {
  const a: any = await sol.call('getAccountInfo', [bondingCurveAddress(mint), { encoding: 'base64' }]); const v = a?.value;
  if (!v || v.owner !== PAD.pump.program) return null; return decodeCurve(Buffer.from(v.data[0], 'base64'));
}

/* ---------- Four.meme ---------- */
export interface FourInfo { version: number; tokenManager: string; quote: string; launchTime: number; offers: bigint; maxOffers: bigint; funds: bigint; maxFunds: bigint; liquidityAdded: boolean; pct: number | null }
const SEL_INFO = sel('getTokenInfo(address)');
export async function readFour(bsc: Rpc, token: string): Promise<FourInfo | null> {
  let r: string; try { r = await bsc.call<string>('eth_call', [{ to: PAD.fourMeme.helper3, data: '0x' + SEL_INFO + word(token) }, 'latest']); } catch { return null; }   // a token not made by Four.meme reverts or returns nothing
  const h = r.replace(/^0x/, ''); if (h.length < 64 * 12) return null; const w = (i: number) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
  const tm = '0x' + h.slice(64 + 24, 128); if (w(0) === 0n || /^0x0+$/.test(tm)) return null;
  const funds = w(9), maxFunds = w(10);
  return { version: Number(w(0)), tokenManager: tm, quote: '0x' + h.slice(128 + 24, 192), launchTime: Number(w(6)), offers: w(7), maxOffers: w(8), funds, maxFunds, liquidityAdded: w(11) === 1n, pct: maxFunds > 0n ? Math.min(100, Number(funds * 10000n / maxFunds) / 100) : null };
}
const TOPIC_CREATE = '0x' + keccakHex('TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)').replace(/^0x/, '');
export interface Created { token: string; name: string; symbol: string; block: number }
/** Newest Four.meme launches from TokenCreate events on TokenManager2 (needs a node that allows eth_getLogs). Token address is the second data word; name and symbol are ABI strings. */
export async function discoverFour(bsc: Rpc, limit = 12, blocks = 300, window = Number(process.env.BSC_LOGS_WINDOW) || 10): Promise<Created[]> {
  const head = Number(BigInt(await bsc.call<string>('eth_blockNumber'))); const all: any[] = [];
  // Alchemy's free tier allows eth_getLogs over at most ~10 blocks per call, so scan the recent past in small windows (BSC_LOGS_WINDOW raises it on a paid plan).
  for (let from = head - blocks + 1; from <= head; from += window) {
    const to = Math.min(from + window - 1, head);
    try { all.push(...await bsc.call<any[]>('eth_getLogs', [{ address: PAD.fourMeme.tokenManager2, topics: [TOPIC_CREATE], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])); }
    catch (e) { if (!all.length && from === head - blocks + 1) throw e; break; }   // first window failing means getLogs is unusable here; later failures keep what we have
  }
  const logs = all;
  const str = (h: string, off: number) => { const o = off * 2, len = Number(BigInt('0x' + h.slice(o, o + 64))); return Buffer.from(h.slice(o + 64, o + 64 + len * 2), 'hex').toString('utf8'); };
  return logs.slice(-limit).reverse().map(l => { const h = l.data.replace(/^0x/, ''); return { token: '0x' + h.slice(64 + 24, 128), name: str(h, Number(BigInt('0x' + h.slice(192, 256)))), symbol: str(h, Number(BigInt('0x' + h.slice(256, 320)))), block: Number(BigInt(l.blockNumber)) }; });
}
