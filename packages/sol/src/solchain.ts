/** SolanaChain: a `ChainPort` over Solana JSON-RPC, so the SAME Engine, Router, OrderRunner, CopyRunner and SnipeRunner can drive Solana.
 *  What differs from the EVM port, and how it is mapped:
 *   - No nonce. Replay protection is the recent blockhash plus a unique signature. `confirmedNonce` returns 0, so the engine's nonce is only a LOCAL sequence
 *     (it is never compared with the chain). The transaction id is its first signature (base58); resubmitting identical bytes is idempotent at the node.
 *   - Validity is a blockhash window. A tx that is absent after its blockhash expired can never land: resubmitting it is rejected by the node and the engine fails
 *     the record (and releases its limit charge). The engine does NOT rebuild with a fresh blockhash; a new intent is needed. Fails closed.
 *   - No allowances: `needsApproval` is always undefined. Wrapped SOL is created, synced and closed inside the swap transaction, so a wallet's native SOL is spent and
 *     received directly. Associated token accounts for the output token are created inside the same transaction (their rent is reported as network cost).
 *   - Finality is Solana's own: `confirmations` reports the finalityDepth when the signature is `finalized`, else the node's confirmation count (capped below it).
 *   - Fills come from the transaction's pre/post balances for the wallet (lamports and token balances), never from the quote.
 *   - Platform fee collection is NOT implemented (a tx with platformFeeBps > 0 is refused). Pending-tx cancellation is not offered (no `evict`).
 *   - Signing is injected (`SolSigner`); the repo ships a dev-only ed25519 signer for throwaway keys. Custody is out of scope.
 *   - Only Raydium AMM v4 pools (constant-product) are supported; no CLMM/CPMM/Orca/Meteora, pump.fun bonding curves only through the `pump` option (SOL <-> token, curve not complete, no mayhem or cashback coins), no routing across pools, no Token-2022 transfer-fee accounting. */
import type { ChainPort, SimTx, Receipt, Venue } from '../../core/src/index.ts';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import { base58, ataAddress, createAtaIdempotent, systemTransfer, syncNative, closeAccount, compileLegacy, unsignedTx, wireTx, raydiumSwapBaseIn, setComputeUnitLimit, setComputeUnitPrice, b58decode } from './tx.ts';
import type { Ix, PoolKeys } from './tx.ts';
import { RaydiumVenue, loadPoolKeys, decodePoolState, AMM_STATUS_SWAP } from './raydium.ts';
import type { SolRpc } from './raydium.ts';
import type { SolSigner } from './signer.ts';
import { fetchBuild, fetchRoutableProgramIds, compileV0, parseMessage, resolveMessage, decodeTable, gateInstructions, walletTokenAccountsAtRisk, unsignedV0, wireV0, JupiterVenue, JupiterRefused } from './jupiterswap.ts';
import type { JupCfg, JIx, Table } from './jupiterswap.ts';
import { fetchJupiterQuote, JUPITER_QUOTE_URL } from './jupiter.ts';
import type { TxSubmitter } from './submitter.ts';
import { PriorityFees, limitFromSimulation, clampPrice, PRIORITY_DEFAULTS } from './priorityfee.ts';
import type { PriorityConfig } from './priorityfee.ts';
import { PROGRAMS, pubkeyBytes, COMPUTE_BUDGET } from './tx.ts';
import { decodeFeeConfig, PumpVenue, PUMP_PROGRAM, decodeCurve, decodeGlobal, pumpAddresses, untradableReason, buy as pumpBuy, quoteBuy, sell as pumpSell, createAtaIdempotent2 } from './pump.ts';

/** Thrown by an RPC when the node ANSWERED with a JSON-RPC error object. Anything else thrown is a transport failure (the ack may be lost). */
export class SolJsonRpcError extends Error { constructor(message: string, public data?: any) { super(message); } }
/** Plain fetch JSON-RPC client (no read-only allowlist: use only against a node you control, e.g. a local test validator). */
export class SolJsonRpc implements SolRpc {
  n = 0; constructor(private url: string, private fetchFn: typeof fetch = fetch) {}
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
    const j: any = await res.json(); if (j.error) throw new SolJsonRpcError(j.error.message ?? JSON.stringify(j.error), j.error.data);
    return j.result as T;
  }
}

const b99 = (h: string) => b58decode(h);
export interface SolChainConfig { id: string; wsol: string; /** Raydium AMM v4 program for pools added later (sniping); defaults to the first configured pool's program */ program?: string; pools: { id: string; program: string }[]; computeUnitLimit?: number; priorityMicroLamports?: bigint; finalityDepth?: number;
  /** Automatic priority fees (priorityfee.ts): price from recent fees on the trade's accounts, limit from simulation, total capped. Unset: the fixed `priorityMicroLamports` (default none) and Jupiter's own price. */
  priority?: PriorityConfig;
  /** Jupiter routes the engine may use. `pairs` are directions (a pair needs one entry per direction); `refAmount` is the size of the quote snapshot used for estimates. */
  /** pump.fun bonding curves to track, by mint. Only curves we can trade (not complete, not mayhem or cashback) become tradable venues; the rest are loaded with the reason they are not. */
  pump?: { mints: string[] };
  jupiter?: JupCfg & { quoteUrl?: string; pairs: { inMint: string; outMint: string; refAmount: bigint }[] };
  /** How signed transactions are sent (default: the node's sendTransaction). A tip-paying submitter such as Jito adds its tip instruction to curve and Raydium transactions; Jupiter-built transactions are sent through the plain node instead (their instruction list is Jupiter's). */
  submitter?: TxSubmitter }
const FINAL = 32, TOKEN_ACCOUNT_SIZE = 165;

export class SolanaChain implements ChainPort {
  id: string; family = 'solana'; time = 0; block = 0; finalityDepth: number;
  state = { venues: new Map<string, Venue>() };
  private keys = new Map<string, PoolKeys>(); private rent?: bigint; private cfg: SolChainConfig; private tipped = new Set<string>(); private fees?: PriorityFees;
  /** Signatures this process sent recently. Solana has no mempool query, so a just-sent tx is not visible for a moment: report it as pending instead of absent (avoids pointless identical resends). */
  private sentAt = new Map<string, number>(); static VISIBILITY_GRACE_MS = 4000;
  /** Set when the last Jupiter quote refresh failed (the Jupiter venue is then absent, so routing falls back to other venues). */
  jupiterError?: string;
  constructor(cfg: SolChainConfig, private rpc: SolRpc, private signer: SolSigner) { this.cfg = { ...cfg, pools: [...cfg.pools] }; this.id = cfg.id; this.finalityDepth = cfg.finalityDepth ?? FINAL; if (cfg.priority) this.fees = new PriorityFees(rpc as any, cfg.priority); }
  venues() { return [...this.state.venues.values()]; }
  /** Add a pool to track. SnipeRunner passes `{ id, pair }`; the program defaults to the first configured pool's program. */
  addPool(p: { id: string; program?: string; pair?: string }) { const program = p.program ?? this.cfg.program ?? this.cfg.pools[0]?.program; if (!program) throw new Error('no Raydium program configured for new pools'); if (!this.cfg.pools.some(x => x.id === p.id)) this.cfg.pools.push({ id: p.id, program }); }
  removePool(id: string) { this.cfg.pools = this.cfg.pools.filter(x => x.id !== id); this.state.venues.delete(id); this.keys.delete(id); }
  private async rpcCall<T>(method: string, params: unknown[] = []): Promise<T> { try { return await this.rpc.call<T>(method, params); } catch (e) { if (e instanceof SolJsonRpcError) throw e; throw new RpcError((e as Error).message); } }

  async refresh(what: 'head' | 'venues') {
    const slot = await this.rpcCall<number>('getSlot', [{ commitment: 'confirmed' }]); this.block = slot;
    let t: number | null = null; try { t = await this.rpcCall<number | null>('getBlockTime', [slot]); } catch { /* block time unavailable for very fresh slots */ }
    this.time = t ?? this.time ?? Math.floor(Date.now() / 1000); if (!this.time) this.time = Math.floor(Date.now() / 1000);
    if (what !== 'venues') return;
    for (const p of this.cfg.pools) {
      let k = this.keys.get(p.id); if (!k) { k = (await this.loadKeys(p)).keys; this.keys.set(p.id, k); }
      const r: any = await this.rpcCall('getMultipleAccounts', [[p.id, k.baseVault, k.quoteVault], { encoding: 'base64', commitment: 'confirmed' }]);
      const [pool, bv, qv] = r.value as ({ data: [string, string] } | null)[]; if (!pool || !bv || !qv) throw new RpcError(`pool ${p.id} or its vaults are missing`);
      const st = decodePoolState(Buffer.from(pool.data[0], 'base64')), amt = (a: { data: [string, string] }) => Buffer.from(a.data[0], 'base64').readBigUInt64LE(64);
      const v = new RaydiumVenue(p.id, k, st.baseMint, st.quoteMint, amt(bv) - st.baseNeedTakePnl, amt(qv) - st.quoteNeedTakePnl, st.swapFeeNum, st.swapFeeDen, this.cfg.wsol,
        st.status === AMM_STATUS_SWAP && st.openTime <= BigInt(this.time), slot);
      this.state.venues.set(p.id, v);
    }
    await this.refreshPump(slot);
    await this.refreshJupiter();
  }
  /** Add a pump.fun curve to track (for example from a launch stream). */
  addCurve(mint: string) { const m = this.cfg.pump?.mints ?? []; if (!m.includes(mint)) this.cfg.pump = { mints: [...m, mint] }; }
  removeCurve(mint: string) { this.cfg.pump = { mints: (this.cfg.pump?.mints ?? []).filter(x => x !== mint) }; this.state.venues.delete(`pump:${mint}`); }
  private async refreshPump(slot: number) {
    const mints = this.cfg.pump?.mints ?? []; if (!mints.length) return;
    const g = pumpAddresses(mints[0], mints[0], PROGRAMS.token).global;   // the global address does not depend on the mint
    const gi: any = await this.rpcCall('getAccountInfo', [g, { encoding: 'base64', commitment: 'confirmed' }]); if (!gi?.value) throw new RpcError('the pump.fun Global account is missing on this chain');
    if (gi.value.owner !== PUMP_PROGRAM) throw new RpcError(`the pump.fun Global account is owned by ${gi.value.owner}, not the pump program`);
    const global = decodeGlobal(Buffer.from(gi.value.data[0], 'base64'));
    let fees: ReturnType<typeof decodeFeeConfig> | undefined, feeErr: string | undefined;
    try { const fa = pumpAddresses(mints[0], mints[0], PROGRAMS.token).feeConfig; const fi: any = await this.rpcCall('getAccountInfo', [fa, { encoding: 'base64', commitment: 'confirmed' }]); if (!fi?.value) throw new Error('fee config account missing'); fees = decodeFeeConfig(Buffer.from(fi.value.data[0], 'base64')); } catch (e) { feeErr = `pump.fun fee schedule not readable: ${(e as Error).message}`; }
    for (const mint of mints) {
      const curveAddr = pumpAddresses(mint, mint, PROGRAMS.token).bondingCurve;
      const r: any = await this.rpcCall('getMultipleAccounts', [[curveAddr, mint], { encoding: 'base64', commitment: 'confirmed' }]); const [c, m] = r.value as ({ owner: string; data: [string, string] } | null)[];
      if (!c || !m || c.owner === PROGRAMS.system) { this.state.venues.delete(`pump:${mint}`); continue; }   // no curve for this mint (the address may hold plain lamports, owned by the system program)
      if (c.owner !== PUMP_PROGRAM) throw new RpcError(`curve ${curveAddr} is owned by ${c.owner}, not the pump program`);
      const curve = decodeCurve(Buffer.from(c.data[0], 'base64'));
      this.state.venues.set(`pump:${mint}`, new PumpVenue(`pump:${mint}`, mint, m.owner, curve, global, feeErr ?? untradableReason(curve, m.owner), slot, fees));
    }
  }
  private pumpInstructions(tx: SimTx, v: PumpVenue, budget: Ix[]): Ix[] {
    const w = tx.wallet, ctx = { user: w, mint: v.mint, tokenProgram: v.tokenProgram, curve: v.curve, feeRecipient: v.global.feeRecipient, buybackRecipient: v.global.buybackRecipients[0] };
    if (tx.tokenIn === NATIVE && tx.tokenOut === v.mint) { const tokens = quoteBuy(tx.amountIn, v.curve, v.totalFeeBps).tokens; if (tokens < tx.minOut || tokens === 0n) throw new Error('pump.fun buy would receive fewer tokens than the minimum'); return [...budget, createAtaIdempotent2(w, w, v.mint, v.tokenProgram), pumpBuy(ctx, tokens, tx.amountIn)]; }
    if (tx.tokenIn === v.mint && tx.tokenOut === NATIVE) return [...budget, pumpSell(ctx, tx.amountIn, tx.minOut)];
    throw new Error(`pump.fun curve ${v.mint} trades only SOL for that token and back`);
  }
  /** Make ANY token tradable: look for a live pump.fun bonding curve and for a Jupiter route, and track whichever exist. Read-only (quotes and account reads). The Router then picks the best quote among the venues.
   *  Jupiter venues are priced from one reference quote each (buy `refLamports` of SOL, and sell back what that returned), so quotes for much larger sizes are an estimate and the real route is built again at trade time. */
  async addToken(mint: string, o: { refLamports?: bigint } = {}): Promise<{ pump: boolean; jupiter: boolean; notes: string[] }> {
    const notes: string[] = []; let pump = false, jupiter = false;
    const had = (this.cfg.pump?.mints ?? []).includes(mint); this.addCurve(mint);
    try { await this.refreshPump(this.block); const v = this.state.venues.get(`pump:${mint}`) as PumpVenue | undefined; pump = !!v; if (v && !v.tradable) { notes.push(`pump.fun curve found but not tradable here: ${v.tradableReason ?? 'graduated'}`); pump = false; } else if (!v) notes.push('no pump.fun curve for this mint'); }
    catch (e) { notes.push(`pump.fun check failed: ${(e as Error).message}`); }
    if (!pump && !had) this.removeCurve(mint);
    const j = this.cfg.jupiter;
    if (!j) notes.push('Jupiter routing is not configured on this chain');
    else try {
      const ref = o.refLamports ?? 50_000_000n, q = await fetchJupiterQuote({ inputMint: this.cfg.wsol, outputMint: mint, amount: ref, slippageBps: 50, fetchFn: j.fetchFn, url: j.quoteUrl ?? JUPITER_QUOTE_URL, timeoutMs: j.timeoutMs });
      if (q.outAmount > 0n) { const add = (inMint: string, outMint: string, refAmount: bigint) => { if (!j.pairs.some(p => p.inMint === inMint && p.outMint === outMint)) j.pairs.push({ inMint, outMint, refAmount }); }; add(this.cfg.wsol, mint, ref); add(mint, this.cfg.wsol, q.outAmount); await this.refreshJupiter(); jupiter = this.state.venues.has(`jup:${this.cfg.wsol.slice(0, 6)}>${mint.slice(0, 6)}`); }
      else notes.push('Jupiter found no route');
    } catch (e) { notes.push(`no Jupiter route: ${(e as Error).message}`); }
    return { pump, jupiter, notes };
  }
  private async refreshJupiter() {
    const j = this.cfg.jupiter; if (!j) return; this.jupiterError = undefined;
    for (const p of j.pairs) {
      const id = `jup:${p.inMint.slice(0, 6)}>${p.outMint.slice(0, 6)}`;
      try {
        const q = await fetchJupiterQuote({ inputMint: p.inMint, outputMint: p.outMint, amount: p.refAmount, slippageBps: 50, fetchFn: j.fetchFn, url: j.quoteUrl ?? JUPITER_QUOTE_URL, timeoutMs: j.timeoutMs });
        this.state.venues.set(id, new JupiterVenue(id, p.inMint, p.outMint, this.cfg.wsol, p.refAmount, q.outAmount, Math.round(Math.abs(q.priceImpactPct) * 100), q.contextSlot));
      } catch (e) { this.state.venues.delete(id); this.jupiterError = (e as Error).message; }
    }
  }
  private loadKeys(p: { id: string; program: string }) { return loadPoolKeys(this.rpc, p.id, p.program).catch(e => { throw e instanceof SolJsonRpcError ? e : new RpcError((e as Error).message); }); }
  async confirmedNonce() { return 0; }

  async balanceOf(wallet: string, token: string) {
    if (token === NATIVE) return BigInt((await this.rpcCall<any>('getBalance', [wallet, { commitment: 'confirmed' }])).value);
    const r: any = await this.rpcCall('getTokenAccountsByOwner', [wallet, { mint: token }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  async needsApproval() { return undefined; }

  private res(t: string) { return t === NATIVE ? this.cfg.wsol : t; }
  /** Instructions for a SimTx. Throws if it cannot be built (unknown venue, platform fee requested). */
  private instructions(tx: SimTx): Ix[] {
    const w = tx.wallet, budget: Ix[] = [setComputeUnitLimit(this.cfg.computeUnitLimit ?? 300_000)];
    if ((this.cfg.priorityMicroLamports ?? 0n) > 0n) budget.push(setComputeUnitPrice(this.cfg.priorityMicroLamports!));
    if (tx.kind === 'noop') return [systemTransfer(w, w, 0n)];
    if (tx.kind === 'approve') throw new Error('Solana has no token allowances: an approve transaction should never be requested');
    if (tx.platformFeeBps > 0) throw new Error('platform fee collection is not implemented on this chain (set the platform fee to 0 for real-node trading)');
    const pv = this.state.venues.get(tx.venue); if (pv instanceof PumpVenue) return this.pumpInstructions(tx, pv, budget);
    const v = this.state.venues.get(tx.venue); if (!(v instanceof RaydiumVenue)) throw new Error(`venue ${tx.venue} is not loaded (refresh venues first)`);
    const wsol = this.cfg.wsol, inM = this.res(tx.tokenIn), outM = this.res(tx.tokenOut), wsolAta = ataAddress(w, wsol), inA = ataAddress(w, inM), outA = ataAddress(w, outM);
    const ixs: Ix[] = [...budget];
    if (tx.tokenIn === NATIVE) ixs.push(createAtaIdempotent(w, w, wsol), createAtaIdempotent(w, w, outM), systemTransfer(w, wsolAta, tx.amountIn), syncNative(wsolAta));
    else if (tx.tokenOut === NATIVE) ixs.push(createAtaIdempotent(w, w, wsol));
    else ixs.push(createAtaIdempotent(w, w, outM));
    ixs.push(raydiumSwapBaseIn(v.keys, inA, outA, w, tx.amountIn, tx.minOut));
    if (tx.tokenIn === NATIVE || tx.tokenOut === NATIVE) ixs.push(closeAccount(wsolAta, w, w));
    return ixs;
  }

  private jupVenue(tx: SimTx) { const v = tx.kind === 'noop' || tx.kind === 'approve' ? undefined : this.state.venues.get(tx.venue); return v instanceof JupiterVenue ? v : undefined; }
  private async accountsAt(addrs: string[]) {
    const out: ({ lamports: number; owner: string; data: Buffer } | null)[] = [];
    for (let i = 0; i < addrs.length; i += 100) {
      const r: any = await this.rpcCall('getMultipleAccounts', [addrs.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
      for (const a of r.value) out.push(a ? { lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data[0], 'base64') } : null);
    }
    return out;
  }
  /** Ask Jupiter for the route, compile it ourselves, run the safety gate on the exact bytes to be signed, then SIMULATE and check the wallet's balances. Throws JupiterRefused to stop. */
  private async buildJupiter(tx: SimTx, v: JupiterVenue) {
    const j = this.cfg.jupiter!, w = tx.wallet, wsol = this.cfg.wsol, inM = this.res(tx.tokenIn), outM = this.res(tx.tokenOut);
    if (tx.platformFeeBps > 0) throw new JupiterRefused('platform fee collection is not implemented on this chain (set the platform fee to 0)');
    if (!v.supports(tx.tokenIn, tx.tokenOut)) throw new JupiterRefused('this Jupiter venue does not cover that pair');
    const allowed = await fetchRoutableProgramIds(j);
    const ask = (slippageBps: number) => fetchBuild({ ...j, inputMint: inM, outputMint: outM, amount: tx.amountIn, taker: w, slippageBps });
    // Slippage is set so Jupiter's OWN minimum output is at least the engine's minOut: tighter than the engine allows is fine, looser never is.
    let b = await ask(50);
    if (b.outAmount < tx.minOut) throw new JupiterRefused(`Jupiter now quotes ${b.outAmount} out, below your minimum ${tx.minOut}: the price moved`);
    if (b.minOut < tx.minOut) {
      const need = Number((b.outAmount - tx.minOut) * 10_000n / b.outAmount); if (need < 1) throw new JupiterRefused('the allowed slippage is under 1 bp: Jupiter cannot honour it');
      b = await ask(need); if (b.minOut < tx.minOut) throw new JupiterRefused(`Jupiter's minimum output ${b.minOut} is below yours (${tx.minOut}): refusing`);
    }
    // Lookup tables come from the chain; what Jupiter claims about them must agree.
    const ids = b.claimedTables.map(t => t.key), infos = await this.accountsAt(ids), tables: Table[] = [];
    ids.forEach((id, i) => { const a = infos[i]; if (!a) throw new JupiterRefused(`lookup table ${id} does not exist on chain`); const t = decodeTable(id, a.data);
      b.claimedTables[i].addresses.forEach((x, k) => { if (t.addresses[k] !== x) throw new JupiterRefused(`lookup table ${id} on chain differs from what Jupiter described`); }); tables.push(t); });
    const bh: any = await this.rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    let message = compileV0(w, b.ixs, b99(bh.value.blockhash), tables);
    const final = resolveMessage(parseMessage(message), tables);
    const gate = gateInstructions(final, { wallet: w, wsol, tokenIn: inM, tokenOut: outM, amountIn: tx.amountIn, allowedPrograms: allowed, maxPriorityLamports: j.maxPriorityLamports ?? 2_000_000n, maxComputeUnits: j.maxComputeUnits ?? 1_400_000 });
    const wAta = ataAddress(w, wsol), inAta = ataAddress(w, inM), outAta = ataAddress(w, outM), okSet = new Set([wAta, inAta, outAta, ...gate.createdTokenAccounts]);
    const route = final[gate.swapIndex], cand = route.accounts.filter(a => a.isWritable && !a.isSigner).map(a => a.pubkey), cinfo = await this.accountsAt(cand), wb = pubkeyBytes(w);
    const mine = new Set(cand.filter((a, i) => { const x = cinfo[i]; return !!x && x.owner === PROGRAMS.token && x.data.length === 165 && x.data.subarray(32, 64).equals(Buffer.from(wb)); }));
    const risk = walletTokenAccountsAtRisk(route, w, okSet, a => mine.has(a)); if (risk.length) throw new JupiterRefused(`the route writes our token account(s) ${risk.join(', ')} that this swap is not about`);
    // Simulate and check the wallet's balances: output at least minOut, input at most the intent.
    const watch = [w, ...(tx.tokenIn === NATIVE ? [] : [inAta]), ...(tx.tokenOut === NATIVE ? [] : [outAta])];
    const pre = await this.accountsAt(watch);
    const sim: any = await this.rpcCall('simulateTransaction', [Buffer.from(unsignedV0(message)).toString('base64'), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64', accounts: { encoding: 'base64', addresses: watch } }]);
    if (sim.value.err) throw new JupiterRefused(`simulation failed: ${JSON.stringify(sim.value.err)}${sim.value.logs?.length ? `: ${sim.value.logs[sim.value.logs.length - 1]}` : ''}`);
    const post = (sim.value.accounts as any[]).map(a => a ? { lamports: BigInt(a.lamports), data: Buffer.from(a.data[0], 'base64') } : null);
    const tok = (a: { data: Buffer } | null) => (a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n), lam = (a: { lamports: number | bigint } | null) => BigInt(a?.lamports ?? 0);
    const feeAll = 5000n + gate.priorityLamports, rent = BigInt(gate.createdNonWsol) * await this.rentExempt();
    let k = 1;
    if (tx.tokenIn === NATIVE) { const spent = lam(pre[0]) - lam(post[0]); if (spent > tx.amountIn + feeAll + rent) throw new JupiterRefused(`simulated SOL spend ${spent} exceeds the intent ${tx.amountIn} plus fees ${feeAll} and new token-account rent ${rent}`); }
    else { const spent = tok(pre[k]) - tok(post[k]); k++; if (spent > tx.amountIn) throw new JupiterRefused(`simulated token spend ${spent} exceeds the intent ${tx.amountIn}`); }
    let got: bigint;
    if (tx.tokenOut === NATIVE) got = lam(post[0]) - lam(pre[0]) + feeAll + rent; else got = tok(post[k]) - tok(pre[k]);
    if (tx.tokenIn === NATIVE && tx.tokenOut === NATIVE) throw new JupiterRefused('SOL to SOL is not a swap');
    if (got < tx.minOut) throw new JupiterRefused(`simulated output ${got} is below the minimum ${tx.minOut}`);
    // Fees, as Jupiter's compute-unit guide recommends: Jupiter sets only a price, so the network would charge it on up to 1.4M units. Set the limit from this simulation
    // (units used x 1.2) and the price from recent fees on the route's accounts (or Jupiter's price, capped), then recompile the same instructions and gate them again.
    if (this.fees || gate.computeUnitLimit === 0) {
      const limit = gate.computeUnitLimit || limitFromSimulation(Number(sim.value.unitsConsumed ?? 1_400_000)), cap = this.cfg.priority?.maxLamports ?? PRIORITY_DEFAULTS.maxLamports;
      const jupPrice = b.ixs.filter(i => i.programId === COMPUTE_BUDGET && i.data[0] === 3 && i.data.length === 9).map(i => Buffer.from(i.data).readBigUInt64LE(1))[0] ?? 0n;
      const price = this.fees ? await this.fees.price(cand, limit).catch(() => clampPrice(jupPrice, limit, cap)) : clampPrice(jupPrice, limit, j.maxPriorityLamports ?? 2_000_000n);
      const cb = (data: Uint8Array): JIx => ({ programId: COMPUTE_BUDGET, accounts: [], data });
      message = compileV0(w, [cb(setComputeUnitLimit(limit).data), cb(setComputeUnitPrice(price).data), ...b.ixs.filter(i => i.programId !== COMPUTE_BUDGET)], b99(bh.value.blockhash), tables);
      gateInstructions(resolveMessage(parseMessage(message), tables), { wallet: w, wsol, tokenIn: inM, tokenOut: outM, amountIn: tx.amountIn, allowedPrograms: allowed, maxPriorityLamports: j.maxPriorityLamports ?? 2_000_000n, maxComputeUnits: j.maxComputeUnits ?? 1_400_000 });
    }
    return { message, simulatedOut: got, quotedOut: b.outAmount, labels: b.routeLabels };
  }

  async simulate(tx: SimTx) {
    const jv = this.jupVenue(tx);
    if (jv) {
      const rz = (status: 'success' | 'reverted', reason?: string): Receipt => ({ hash: 'sim', status, reason, block: this.block + 1, deltas: {}, network: 0n, platformFee: 0n, venueFee: 0n });
      try { const r = await this.buildJupiter(tx, jv); return { block: this.block, receipt: { ...rz('success'), deltas: tx.tokenOut === NATIVE ? {} : { [this.res(tx.tokenOut)]: r.simulatedOut } } }; }
      catch (e) { if (e instanceof JupiterRefused || e instanceof SolJsonRpcError) return { block: this.block, receipt: rz('reverted', (e as Error).message) }; throw e; }
    }
    const zero = (status: 'success' | 'reverted', reason?: string): Receipt => ({ hash: 'sim', status, reason, block: this.block + 1, deltas: {}, network: 0n, platformFee: 0n, venueFee: 0n });
    let ixs: Ix[]; try { ixs = this.instructions(tx); } catch (e) { return { block: this.block, receipt: zero('reverted', (e as Error).message) }; }
    try {
      const raw = Buffer.from(unsignedTx(compileLegacy(tx.wallet, ixs))).toString('base64');
      const r: any = await this.rpcCall('simulateTransaction', [raw, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64' }]);
      if (r.value.err) return { block: this.block, receipt: zero('reverted', `${JSON.stringify(r.value.err)}${r.value.logs?.length ? `: ${r.value.logs[r.value.logs.length - 1]}` : ''}`) };
      return { block: this.block, receipt: zero('success') };
    } catch (e) { if (!(e instanceof SolJsonRpcError)) throw e; return { block: this.block, receipt: zero('reverted', e.message) }; }
  }

  async prepare(tx: SimTx) {
    const jv = this.jupVenue(tx);
    if (jv) { const { message } = await this.buildJupiter(tx, jv); const sig = await this.signer.sign(tx.wallet, message); return { raw: Buffer.from(wireV0(message, [sig])).toString('base64'), hash: base58(sig) }; }
    const ixs = this.fees && (tx.kind ?? 'swap') === 'swap' ? await this.withPriority(this.instructions(tx), tx.wallet) : this.instructions(tx), sub = this.cfg.submitter, extra = sub?.extraInstruction ? await sub.extraInstruction(tx.wallet) : undefined; if (extra) ixs.push(extra);
    const bh: any = await this.rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const message = compileLegacy(tx.wallet, ixs, b58decode(bh.value.blockhash)), sig = await this.signer.sign(tx.wallet, message); if (extra) this.tipped.add(base58(sig));
    return { raw: Buffer.from(wireTx(message, [sig])).toString('base64'), hash: base58(sig) };
  }

  /** pump.fun and Raydium: the limit from a simulation (units used x 1.2; the configured limit if it cannot be simulated) and the price from recent fees on the accounts
   *  this trade writes, capped (priorityfee.ts). An estimate that cannot be read falls back to the floor price. */
  private async withPriority(ixs: Ix[], payer: string): Promise<Ix[]> {
    const body = ixs.filter(i => i.program !== COMPUTE_BUDGET); let limit = this.cfg.computeUnitLimit ?? 300_000;
    try { const r: any = await this.rpcCall('simulateTransaction', [Buffer.from(unsignedTx(compileLegacy(payer, [setComputeUnitLimit(1_400_000), ...body]))).toString('base64'), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64' }]);
      if (!r.value.err && r.value.unitsConsumed) limit = limitFromSimulation(Number(r.value.unitsConsumed)); } catch { /* keep the configured limit */ }
    const writable = body.flatMap(i => i.keys.filter(k => k.writable && !k.signer).map(k => k.pubkey)), p = this.cfg.priority!;
    const price = await this.fees!.price(writable, limit).catch(() => clampPrice(p.minMicroLamports ?? PRIORITY_DEFAULTS.minMicroLamports, limit, p.maxLamports ?? PRIORITY_DEFAULTS.maxLamports));
    return [setComputeUnitLimit(limit), setComputeUnitPrice(price), ...body];
  }

  async submit(tx: SimTx) {
    if (!tx.raw) throw new Error('transaction was not prepared (no raw bytes)');
    this.sentAt.set(tx.hash, Date.now());
    try {
      const sub = this.cfg.submitter, viaSub = sub && (!sub.extraInstruction || this.tipped.has(tx.hash));
      const h = viaSub ? await sub!.send(tx.raw, tx.hash) : await this.rpcCall<string>('sendTransaction', [tx.raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
      if (h !== tx.hash) throw new Error(`node returned signature ${h} but we computed ${tx.hash}: refusing to track a different transaction`);
      return h;
    } catch (e) {
      if (e instanceof RpcError || !(e instanceof SolJsonRpcError)) throw e;
      if (/AlreadyProcessed|already been processed/i.test(e.message)) return tx.hash;   // identical bytes already landed: idempotent success
      if (/Blockhash not found|BlockhashNotFound/i.test(e.message)) throw new Error(`blockhash expired or unknown: this transaction can never land (${e.message})`);
      throw new Error(e.message);
    }
  }

  private async status(hash: string) { const r: any = await this.rpcCall('getSignatureStatuses', [[hash], { searchTransactionHistory: true }]); return r.value[0] as { slot: number; confirmations: number | null; err: unknown; confirmationStatus?: string } | null; }
  async lookup(hash: string) {
    if (await this.status(hash)) return 'included' as const;
    const t = this.sentAt.get(hash); return t !== undefined && Date.now() - t < SolanaChain.VISIBILITY_GRACE_MS ? 'pending' as const : 'none' as const;
  }
  async confirmations(hash: string) {
    const s = await this.status(hash); if (!s) return 0;
    if (s.confirmationStatus === 'finalized' || s.confirmations === null) return this.finalityDepth;
    return Math.min(this.finalityDepth - 1, (s.confirmations ?? 0) + 1);
  }

  private async rentExempt() { return this.rent ??= BigInt(await this.rpcCall<number>('getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_SIZE])); }

  /** Receipt -> the wallet's balance deltas. NATIVE = lamports, so it includes the fee and any rent paid; `network` = fee + rent of token accounts the tx created and left open. */
  async receipt(hash: string): Promise<Receipt | undefined> {
    const s = await this.status(hash); if (!s) return undefined;
    const t: any = await this.rpcCall('getTransaction', [hash, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); if (!t) return undefined;
    const m = t.meta, keys: string[] = t.transaction.message.accountKeys, wallet = keys[0], block = t.slot as number, fee = BigInt(m.fee);
    const deltas: Record<string, bigint> = { [NATIVE]: BigInt(m.postBalances[0]) - BigInt(m.preBalances[0]) };
    if (m.err) return { hash, status: 'reverted', reason: `${JSON.stringify(m.err)}${m.logMessages?.length ? `: ${m.logMessages[m.logMessages.length - 1]}` : ''}`, block, deltas, network: fee, platformFee: 0n, venueFee: 0n };
    const add = (mint: string, d: bigint) => { deltas[mint] = (deltas[mint] ?? 0n) + d; };
    const pre = new Set<number>((m.preTokenBalances as any[]).map(b => b.accountIndex)); let created = 0n, createdRent = 0n;
    for (const b of m.preTokenBalances as any[]) if (b.owner === wallet) add(b.mint, -BigInt(b.uiTokenAmount.amount));
    for (const b of m.postTokenBalances as any[]) if (b.owner === wallet) { add(b.mint, BigInt(b.uiTokenAmount.amount)); if (!pre.has(b.accountIndex) && b.mint !== this.cfg.wsol) { created++; createdRent += BigInt(m.postBalances[b.accountIndex] ?? 0); } }
    for (const k of Object.keys(deltas)) if (k !== NATIVE && deltas[k] === 0n) delete deltas[k];
    const tokenIdx = new Set<number>([...(m.postTokenBalances as any[]), ...(m.preTokenBalances as any[])].map(b => b.accountIndex)); let otherRent = 0n;
    for (let i = 1; i < keys.length; i++) if (!tokenIdx.has(i) && BigInt(m.preBalances[i] ?? 0) === 0n && BigInt(m.postBalances[i] ?? 0) > 0n) otherRent += BigInt(m.postBalances[i]);   // program accounts the tx created and left open (pump.fun's per-user volume accumulator, for one)
    const network = fee + otherRent + (createdRent > 0n ? createdRent : created * await this.rentExempt());   // rent actually paid for the new token accounts (a Token-2022 account is bigger than a classic one)
    let venueFee = 0n;
    for (const v of this.state.venues.values()) if (v instanceof RaydiumVenue) {
      const spent = deltas[v.baseMint] < 0n ? -deltas[v.baseMint] : deltas[v.quoteMint] < 0n ? -deltas[v.quoteMint] : (v.baseMint === this.cfg.wsol || v.quoteMint === this.cfg.wsol) && deltas[NATIVE] < 0n ? -deltas[NATIVE] - network : 0n;
      if (spent > 0n && (deltas[v.baseMint] !== undefined || deltas[v.quoteMint] !== undefined)) { venueFee = spent * v.feeNum / v.feeDen; break; }
    }
    return { hash, status: 'success', block, deltas, network, platformFee: 0n, venueFee };
  }
}
