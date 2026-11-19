/** JupiterZ (Jupiter's RFQ router) for large Solana orders. Market makers quote a fixed price; the fill settles through Jupiter's Order Engine program with the maker as
 *  co-signer and fee payer. Research, sources and the live comparison: docs/JUPITERZ.md.
 *  What this module does NOT do: build the transaction (Jupiter does, and it cannot be modified) or send it (only Jupiter's `/execute` can, because the maker signs there).
 *  So everything here is CHECKING: `gateRfq` refuses any transaction that is not exactly one Order Engine fill for our wallet, our amounts and our accounts, BEFORE the
 *  user's wallet signs. Sources (read 2026-11-18):
 *   - `/order` + `/execute`, response fields, error codes: https://developers.jup.ag/docs/swap/order-and-execute.md, https://developers.jup.ag/docs/api-reference/swap/execute.md
 *   - maker = fee payer (`signatureFeePayer`): https://developers.jup.ag/docs/swap/advanced/gasless.md
 *   - Order Engine program, `fill` accounts/args and what it transfers: https://github.com/jup-ag/rfq-webhook-toolkit (idls/order_engine.json, programs/order-engine/src/instructions/fill.rs)
 *   - fill data trailer (5 bytes: fee_bps u16, flags u8, integrator_fee_bps u16): https://developers.jup.ag/docs/swap/routing/rfq/v1/quoting.md */
import { b58decode, pubkeyBytes, ataAddress, findProgramAddress, PROGRAMS, COMPUTE_BUDGET, shortvec, cat } from './tx.ts';
import { parseMessage, resolveMessage, JupiterRefused } from './jupiterswap.ts';
import type { JIx } from './jupiterswap.ts';

export const JUPITERZ = {
  orderUrl: 'https://api.jup.ag/swap/v2/order', executeUrl: 'https://api.jup.ag/swap/v2/execute',
  orderEngine: '61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH',
  /** Anchor discriminator of `fill` (idls/order_engine.json). */
  fillDiscriminator: Uint8Array.of(168, 96, 183, 163, 92, 10, 40, 160),
  tempWsolSeed: 'temporary-wsol-token-account',
  /** Routers other than JupiterZ, excluded so `/order` answers with an RFQ quote or none. */
  others: 'metis,dflow,okx',
};
export interface RfqCfg { orderUrl?: string; executeUrl?: string; apiKey?: string; fetchFn?: typeof fetch; timeoutMs?: number }
export interface RfqOrder { requestId: string; maker: string; expireAt: number; inAmount: bigint; outAmount: bigint; feeBps: number; /** The unsigned wire transaction exactly as Jupiter sent it. */ tx: Uint8Array; message: Uint8Array }
/** No RFQ quote for this request, with Jupiter's reason. Not an error: the normal route is used. */
export interface RfqNone { none: string }

const big = (v: unknown, n: string) => { if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new JupiterRefused(`JupiterZ field ${n} is not an integer string`); return BigInt(v); };
const headers = (c: RfqCfg, json = false): Record<string, string> => ({ ...(c.apiKey ? { 'x-api-key': c.apiKey } : {}), ...(json ? { 'content-type': 'application/json' } : {}) });

/** Splits a wire transaction into its signature slots and message. */
export function splitWire(tx: Uint8Array): { sigs: Uint8Array[]; message: Uint8Array } {
  let p = 0, n = 0, sh = 0; for (;;) { const b = tx[p++]; n |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; if (sh > 14) throw new JupiterRefused('bad signature count'); }
  if (tx.length < p + 64 * n) throw new JupiterRefused('transaction truncated');
  return { sigs: Array.from({ length: n }, (_, i) => tx.subarray(p + 64 * i, p + 64 * (i + 1))), message: tx.subarray(p + 64 * n) };
}

/** A JupiterZ-only `/order` for this taker and amount. Returns { none } when JupiterZ gives no buildable quote. */
export async function fetchRfqOrder(o: { inputMint: string; outputMint: string; amount: bigint; taker: string } & RfqCfg): Promise<RfqOrder | RfqNone> {
  if (!(o.amount > 0n)) throw new Error('amount must be positive');
  const u = new URL(o.orderUrl ?? JUPITERZ.orderUrl);
  u.search = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount.toString(), taker: o.taker, excludeRouters: JUPITERZ.others }).toString();
  const res = await (o.fetchFn ?? fetch)(u.toString(), { headers: headers(o), signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  const j: any = await res.json().catch(() => undefined);
  if (!res.ok || !j) return { none: `JupiterZ /order answered HTTP ${res.status}${j?.error ? ': ' + String(j.error).slice(0, 160) : ''}` };
  if (j.error) return { none: `JupiterZ: ${String(j.error).slice(0, 160)}` };
  if (j.router !== 'jupiterz') return { none: `the winning router was ${j.router}, not jupiterz` };
  if (!j.transaction) return { none: `JupiterZ quoted but could not build a transaction (code ${j.errorCode ?? '?'}: ${String(j.errorMessage ?? '').slice(0, 120)})` };
  if (j.inputMint !== o.inputMint || j.outputMint !== o.outputMint) throw new JupiterRefused('JupiterZ answered for a different pair than requested');
  if (j.taker !== o.taker) throw new JupiterRefused('JupiterZ answered for a different taker');
  if (j.swapMode !== undefined && j.swapMode !== 'ExactIn') throw new JupiterRefused(`unexpected swap mode ${j.swapMode}`);
  if (j.transactionVersion !== undefined && j.transactionVersion !== 0) throw new JupiterRefused(`unexpected transaction version ${j.transactionVersion}`);
  if (typeof j.requestId !== 'string' || !j.requestId || /[:\s]/.test(j.requestId)) throw new JupiterRefused('JupiterZ answered without a usable requestId');
  if (typeof j.maker !== 'string') throw new JupiterRefused('JupiterZ answered without the maker'); b58decode(j.maker);
  const expireAt = Number(j.expireAt); if (!Number.isSafeInteger(expireAt) || expireAt <= 0) throw new JupiterRefused('JupiterZ answered without a valid expireAt');
  const inAmount = big(j.inAmount, 'inAmount'), outAmount = big(j.outAmount, 'outAmount');
  if (inAmount !== o.amount) throw new JupiterRefused(`JupiterZ quoted ${inAmount} in, we asked for ${o.amount}`);
  const tx = Uint8Array.from(Buffer.from(j.transaction, 'base64'));
  return { requestId: j.requestId, maker: j.maker, expireAt, inAmount, outAmount, feeBps: Number(j.feeBps ?? 0), tx, message: Uint8Array.from(splitWire(tx).message) };
}
/** What JupiterZ market makers would pay right now, with no taker: a price only, nothing is built or signed. Used before a trade is accepted (the server's share-price
 *  check on a stock whose pools are too thin); the trade itself still goes through fetchRfqOrder, the gate and the simulation. */
export async function fetchRfqQuote(o: { inputMint: string; outputMint: string; amount: bigint } & RfqCfg): Promise<{ outAmount: bigint } | RfqNone> {
  if (!(o.amount > 0n)) throw new Error('amount must be positive');
  const u = new URL(o.orderUrl ?? JUPITERZ.orderUrl);
  u.search = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount.toString(), excludeRouters: JUPITERZ.others }).toString();
  const res = await (o.fetchFn ?? fetch)(u.toString(), { headers: headers(o), signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  const j: any = await res.json().catch(() => undefined);
  if (!res.ok || !j) return { none: `JupiterZ /order answered HTTP ${res.status}` };
  if (j.error || j.router !== 'jupiterz') return { none: j.error ? `JupiterZ: ${String(j.error).slice(0, 160)}` : 'no JupiterZ quote' };
  if (j.inputMint !== o.inputMint || j.outputMint !== o.outputMint || String(j.inAmount) !== o.amount.toString()) return { none: 'JupiterZ answered for a different request' };
  const out = big(j.outAmount, 'outAmount'); return out > 0n ? { outAmount: out } : { none: 'JupiterZ quoted nothing' };
}

export interface RfqFill { inputAmount: bigint; outputAmount: bigint; expireAt: number; feeBps?: number }
/** Decodes an Order Engine `fill`: 8-byte discriminator, input_amount u64, output_amount u64, expire_at i64, then an optional 5-byte trailer the program does not read. */
export function decodeFill(data: Uint8Array): RfqFill {
  if (data.length !== 32 && data.length !== 37) throw new JupiterRefused(`Order Engine instruction data is ${data.length} bytes (a fill is 32, or 37 with its trailer)`);
  for (let i = 0; i < 8; i++) if (data[i] !== JUPITERZ.fillDiscriminator[i]) throw new JupiterRefused('the Order Engine instruction is not a fill');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expire = v.getBigInt64(24, true); if (expire <= 0n || expire > 2n ** 40n) throw new JupiterRefused('fill expiry out of range');
  return { inputAmount: v.getBigUint64(8, true), outputAmount: v.getBigUint64(16, true), expireAt: Number(expire), ...(data.length === 37 ? { feeBps: v.getUint16(32, true) } : {}) };
}

export interface RfqGateCtx {
  wallet: string; maker: string; wsol: string;
  /** Mints of the trade; wSOL means native SOL on that side (the engine trades native SOL). */
  inMint: string; outMint: string; amountIn: bigint; minOut: bigint;
  /** Token program of each trade mint, as the CHAIN reports it. */
  tokenProgram: (mint: string) => string;
  nowSec: number; maxExpirySec?: number; maxComputeUnits?: number;
}
export interface RfqGateResult { fill: RfqFill; createdTokenAccounts: string[]; ixs: JIx[] }

/** Refuses every RFQ transaction that is not exactly what we asked for. `wire` is Jupiter's unsigned transaction; what is signed is its message, unchanged. */
export function gateRfq(wire: Uint8Array, c: RfqGateCtx): RfqGateResult {
  const refuse = (why: string): never => { throw new JupiterRefused(why); };
  const { sigs, message } = splitWire(wire);
  const pm = parseMessage(message);
  if (pm.version !== 0) refuse('an RFQ transaction must be a v0 message');
  if (pm.signers !== 2 || sigs.length !== 2) refuse(`an RFQ transaction needs exactly two signers (the maker and our wallet), this one needs ${pm.signers}`);
  if (pm.readonlySigned !== 0) refuse('an RFQ signer is read-only');
  if (pm.staticKeys[0] !== c.maker) refuse(`the fee payer ${pm.staticKeys[0]} is not the quote's maker ${c.maker}`);
  if (pm.staticKeys[1] !== c.wallet) refuse('our wallet is not the second signer');
  if (c.maker === c.wallet) refuse('the maker is our own wallet');
  if (sigs.some(s => s.some(b => b !== 0))) refuse('the RFQ transaction arrived already signed');
  if (pm.lookups.length) refuse('the RFQ transaction uses address lookup tables, which this gate does not accept');
  const ixs = resolveMessage(pm, []);
  const sol = c.wsol, E = JUPITERZ.orderEngine, none = (a?: string) => a === E;
  const inProg = c.tokenProgram(c.inMint), outProg = c.tokenProgram(c.outMint);
  const ours = new Set([c.wallet, ataAddress(c.wallet, c.inMint, inProg), ataAddress(c.wallet, c.outMint, outProg), ataAddress(c.wallet, sol)]);
  const created: string[] = []; let fill: RfqFill | undefined, cuLimit = 0;
  ixs.forEach((ix, n) => {
    for (const a of ix.accounts) if (a.isSigner && a.pubkey !== c.wallet && a.pubkey !== c.maker) refuse(`instruction ${n} needs a signature from ${a.pubkey}`);
    const k = ix.accounts.map(a => a.pubkey);
    if (ix.programId === COMPUTE_BUDGET) {
      if (ix.accounts.length) refuse('a compute budget instruction with accounts');
      if (ix.data[0] === 2 && ix.data.length === 5) cuLimit = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true);
      else if (!(ix.data[0] === 3 && ix.data.length === 9)) refuse(`compute budget instruction type ${ix.data[0]} is not allowed`);
      return;   // the price is paid by the maker (the fee payer), not by us
    }
    if (ix.programId === PROGRAMS.ata) {
      if (!(ix.data.length === 0 || (ix.data.length === 1 && (ix.data[0] === 0 || ix.data[0] === 1)))) refuse('unexpected associated-token-account instruction');
      if (created.length) refuse('more than one token account is created');
      if (c.outMint === sol) refuse('a SOL-out fill needs no token account');
      if (k.length !== 6 || k[0] !== c.wallet || k[2] !== c.wallet || k[3] !== c.outMint || k[4] !== PROGRAMS.system || k[5] !== outProg) refuse('the only token account allowed is our own account for the output token, funded by our wallet');
      if (k[1] !== ataAddress(c.wallet, c.outMint, outProg)) refuse('the token account address does not match our wallet and the output mint');
      created.push(k[1]); return;
    }
    if (ix.programId === E) {
      if (fill) refuse('more than one fill');
      const f = decodeFill(ix.data);
      if (k.length !== 11 && k.length !== 12) refuse(`a fill has 11 accounts (12 with the maker's temporary wSOL account), this one has ${k.length}`);
      const acc = ix.accounts;
      if (k[0] !== c.wallet || !acc[0].isSigner || !acc[0].isWritable) refuse('the fill taker is not our wallet, signing');
      if (k[1] !== c.maker || !acc[1].isSigner) refuse('the fill maker is not the quote\'s maker, signing');
      const [tIn, mIn, tOut, mOut, inMint, inP, outMint, outP, sys] = k.slice(2, 11);
      if (inMint !== c.inMint || outMint !== c.outMint) refuse('the fill is for a different pair than requested');
      if (inP !== inProg || outP !== outProg) refuse('the fill names a token program the chain does not report for that mint');
      if (sys !== PROGRAMS.system) refuse('the fill\'s system program is wrong');
      // our side: SOL from the wallet itself (no input account), tokens from our own associated account; output to our own associated account, or to the wallet for SOL
      if (c.inMint === sol ? !none(tIn) : tIn !== ataAddress(c.wallet, c.inMint, inProg)) refuse('the fill takes the input from an account that is not ours for this trade');
      if (c.outMint === sol ? !none(tOut) : tOut !== ataAddress(c.wallet, c.outMint, outProg)) refuse('the fill pays the output to an account that is not ours');
      // the maker's side must not be any account of ours
      for (const m of [mIn, mOut]) if (!none(m) && ours.has(m)) refuse('the fill uses one of our accounts as the maker\'s account');
      if (k.length === 12) { const pda = findProgramAddress([Buffer.from(JUPITERZ.tempWsolSeed), pubkeyBytes(c.maker)], E).address; if (k[11] !== pda || acc[11].isSigner) refuse('the fill\'s extra account is not the maker\'s temporary wSOL account'); }
      if (f.inputAmount !== c.amountIn) refuse(`the fill spends ${f.inputAmount}, the trade is for ${c.amountIn}`);
      if (f.outputAmount < c.minOut) refuse(`the fill pays ${f.outputAmount}, below the minimum ${c.minOut}`);
      if (f.expireAt <= c.nowSec) refuse('the RFQ quote has expired');
      if (f.expireAt > c.nowSec + (c.maxExpirySec ?? 120)) refuse(`the RFQ quote expires ${f.expireAt - c.nowSec}s from now, more than allowed`);
      fill = f; return;
    }
    refuse(`program ${ix.programId} is not allowed in an RFQ transaction`);
  });
  if (!fill) refuse('no Order Engine fill in the RFQ transaction');
  // our wallet signs: only the fill (as taker) and the token-account create (as funder) may name it as a signer
  ixs.forEach((ix, n) => { if (ix.accounts.some(a => a.pubkey === c.wallet && a.isSigner) && ix.programId !== E && ix.programId !== PROGRAMS.ata) refuse(`instruction ${n} uses our wallet as a signer`); });
  if (cuLimit > (c.maxComputeUnits ?? 400_000)) refuse(`compute unit limit ${cuLimit} is above the cap`);
  return { fill: fill!, createdTokenAccounts: created, ixs };
}

/** The engine stores this as the transaction's raw bytes: enough to resend to `/execute` after a restart and to know when the quote can no longer land. */
export const encodeRfqRaw = (requestId: string, expireAt: number, wire: Uint8Array) => `jupz1:${requestId}:${expireAt}:${Buffer.from(wire).toString('base64')}`;
export function decodeRfqRaw(raw: string): { requestId: string; expireAt: number; wire: string } | undefined {
  const m = /^jupz1:([^:]+):(\d+):([A-Za-z0-9+/=]+)$/.exec(raw); return m ? { requestId: m[1], expireAt: Number(m[2]), wire: m[3] } : undefined;
}
/** Our signature into our slot of Jupiter's message; the maker's slot stays empty (the maker fills it during `/execute`). */
export function rfqWire(message: Uint8Array, slot: number, sig: Uint8Array): Uint8Array {
  const n = message[1]; if (slot < 0 || slot >= n || sig.length !== 64) throw new Error('bad signature slot');
  return cat(shortvec(n), ...Array.from({ length: n }, (_, i) => (i === slot ? sig : new Uint8Array(64))), message);
}

export interface ExecuteResult { status: 'Success' | 'Failed'; code: number; signature?: string; error?: string; totalInputAmount?: string; totalOutputAmount?: string }
/** `/execute` error codes after which the maker never signed, so the transaction cannot land (still only trusted once the quote has expired, see SolanaChain). */
export const RFQ_NOT_SENT = new Set([-1, -2, -3, -2002, -2003, -2004]);
/** POST /execute. A transport failure throws (the caller treats it as "ack lost"); any answer is returned as is. */
export async function executeRfq(c: RfqCfg, signedBase64: string, requestId: string): Promise<ExecuteResult> {
  const res = await (c.fetchFn ?? fetch)(c.executeUrl ?? JUPITERZ.executeUrl, { method: 'POST', headers: headers(c, true), body: JSON.stringify({ signedTransaction: signedBase64, requestId }), signal: AbortSignal.timeout(c.timeoutMs ?? 60_000) });
  const j: any = await res.json().catch(() => undefined);
  if (!j || typeof j !== 'object') throw new Error(`JupiterZ /execute answered HTTP ${res.status} without JSON`);
  if (!res.ok && j.code === undefined) return { status: 'Failed', code: -2002, error: String(j.error ?? `HTTP ${res.status}`).slice(0, 200) };
  return { status: j.status === 'Success' ? 'Success' : 'Failed', code: Number(j.code ?? (j.status === 'Success' ? 0 : -2001)), signature: typeof j.signature === 'string' ? j.signature : undefined, error: j.error ? String(j.error).slice(0, 200) : undefined, totalInputAmount: j.totalInputAmount, totalOutputAmount: j.totalOutputAmount };
}
