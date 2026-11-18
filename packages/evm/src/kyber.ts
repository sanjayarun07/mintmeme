/** KYBERSWAP as a same-chain venue on EVM chains (Base first): an alternative to Relay (relay.ts) for tokens whose liquidity is not in Uniswap V2 pools (memecoins on
 *  Uniswap V3/V4 and Aerodrome, Coinbase stocks). KyberSwap is a THIRD-PARTY service, so nothing it returns is signed blindly.
 *
 *  What a KyberSwap swap is (decoded from live builds on Base, 2026-11-18: ETH -> ZORA and ZORA -> ETH, read-only):
 *   - ONE transaction to KyberSwap's router `MetaAggregationRouterV2` (0x6131B5fae19EA4f9D964eAc0408E4408b66337b5, KYBER.router), `swap(SwapExecutionParams)`, with
 *     value = the input on a buy with ETH and 0 on a sell; a sell first needs `approve(router, exact amount)`.
 *   - The calldata names srcToken, dstToken, dstReceiver, amount, minReturnAmount and fee receivers (aggregator.ts `decodeKyberSwap`). The router itself checks that
 *     dstReceiver's balance of dstToken rose by at least minReturnAmount and reverts otherwise; ETH is 0xeeee...eeee.
 *  `gateKyber` refuses anything else: only the pinned router, the exact input as both value (ETH in) and `amount`, our pair, our wallet as the receiver, no fee receivers,
 *  and an on-chain minimum at least the engine's. The simulation (aggregator.ts `simulateCalls`) then checks the wallet's real balance changes.
 *  API, as it answered on https://aggregator-api.kyberswap.com (2026-11-18, read-only builds for ETH <-> ZORA and ETH -> NVDAc): `GET /{chain}/api/v1/routes` (tokenIn, tokenOut,
 *  amountIn) returns `data.routeSummary` and `data.routerAddress`; `POST /{chain}/api/v1/route/build` (routeSummary, sender, recipient, slippageTolerance in bps) returns
 *  `data.data` (calldata), `data.routerAddress`, `data.transactionValue`, `data.amountIn`, `data.amountOut`. Keyless with an `x-client-id` header (answered 2026-11-18).
 *  Not done: permits, fee sharing (`feeAmount`/`feeReceiver` are refused by the gate). */
import { NATIVE } from '../../core/src/index.ts';
import { normAddr } from './abi.ts';
import { AggRefused, decodeKyberSwap, KYBER } from './aggregator.ts';

const lc = (s: string) => s.toLowerCase();
/** Engine token ('NATIVE' or 0x address) as KyberSwap writes it (ETH is 0xeeee...eeee). */
export const kAddr = (t: string) => (t === NATIVE ? KYBER.native : lc(normAddr(t)));

/** KyberSwap could not answer right now (rate limited, a server error, unreachable): transient, so a trade waits and retries. Other answers (no route) are final. */
export class KyberUnavailable extends Error {}
export interface KyberQuote { amountOut: bigint; routeSummary: unknown; path: string[] }
export interface KyberBuild { to: string; data: string; value: bigint; amountOut: bigint }

export class KyberClient {
  constructor(private o: { chain?: string; clientId?: string; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number; /** Retries after HTTP 429 (default 2, waiting 1.5 and 3 s). */ retries429?: number } = {}) {}
  private url(p: string) { return `${this.o.baseUrl ?? 'https://aggregator-api.kyberswap.com'}/${this.o.chain ?? 'base'}/api/v1/${p}`; }
  private async call(p: string, init: RequestInit = {}): Promise<any> {
    const send = () => (this.o.fetchFn ?? fetch)(this.url(p), { ...init, headers: { 'x-client-id': this.o.clientId ?? 'memedesk', ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    let r: Response; try { r = await send(); } catch (e) { throw new KyberUnavailable(`KyberSwap is unreachable: ${(e as Error).message}`); }
    for (let i = 0; r.status === 429 && i < (this.o.retries429 ?? 2); i++) { await new Promise(ok => setTimeout(ok, 1500 * 2 ** i)); try { r = await send(); } catch (e) { throw new KyberUnavailable(`KyberSwap is unreachable: ${(e as Error).message}`); } }
    const j: any = await r.json().catch(() => ({})), why = `KyberSwap ${p.split('?')[0]} failed: HTTP ${r.status}${j?.message ? `: ${String(j.message).slice(0, 200)}` : ''}`;
    if (r.status === 429 || r.status >= 500) throw new KyberUnavailable(why);
    if (!r.ok || j?.code !== 0 || !j?.data) throw new Error(why);
    return j.data;
  }
  /** Best route for an exact input. Read-only. */
  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberQuote> {
    const d = await this.call(`routes?tokenIn=${kAddr(tokenIn)}&tokenOut=${kAddr(tokenOut)}&amountIn=${amountIn}`), rs = d.routeSummary;
    if (!rs || lc(String(rs.tokenIn)) !== kAddr(tokenIn) || lc(String(rs.tokenOut)) !== kAddr(tokenOut) || String(rs.amountIn) !== String(amountIn)) throw new Error('KyberSwap answered for a different trade than requested');
    if (lc(String(d.routerAddress ?? '')) !== KYBER.router) throw new AggRefused(`KyberSwap routes through ${d.routerAddress}, not its pinned router`);
    if (!/^\d+$/.test(String(rs.amountOut))) throw new Error('KyberSwap amountOut is not an integer');
    return { amountOut: BigInt(rs.amountOut), routeSummary: rs, path: [...new Set((rs.route ?? []).flat().map((x: any) => String(x?.exchange ?? '?')))] as string[] };
  }
  /** The transaction for a quoted route, sent from and paid to `wallet`, with `slippageBps`. Read-only (KyberSwap builds it; nothing is signed). */
  async build(q: KyberQuote, wallet: string, slippageBps: number): Promise<KyberBuild> {
    const d = await this.call('route/build', { method: 'POST', body: JSON.stringify({ routeSummary: q.routeSummary, sender: lc(wallet), recipient: lc(wallet), slippageTolerance: slippageBps }) });
    if (typeof d.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(d.data) || !/^\d+$/.test(String(d.transactionValue ?? '')) || !/^\d+$/.test(String(d.amountOut ?? ''))) throw new Error('KyberSwap build answered an unexpected shape');
    return { to: lc(String(d.routerAddress)), data: d.data, value: BigInt(d.transactionValue), amountOut: BigInt(d.amountOut) };
  }
}

/** Refuses a KyberSwap transaction that is not exactly our swap (see the header). Returns the transaction to sign and its on-chain minimum. */
export function gateKyber(b: KyberBuild, c: { wallet: string; tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint }) {
  const refuse = (why: string): never => { throw new AggRefused(why); };
  if (lc(b.to) !== KYBER.router) refuse(`the KyberSwap transaction goes to ${b.to}, not its pinned router`);
  const native = c.tokenIn === NATIVE; if (b.value !== (native ? c.amountIn : 0n)) refuse(`the KyberSwap transaction sends ${b.value} wei, not ${native ? c.amountIn : 0n}`);
  const d = decodeKyberSwap(b.data);
  if (d.srcToken !== kAddr(c.tokenIn) || d.dstToken !== kAddr(c.tokenOut)) refuse(`the KyberSwap swap trades ${d.srcToken} -> ${d.dstToken}, not this pair`);
  if (d.amount !== c.amountIn) refuse(`the KyberSwap swap spends ${d.amount}, not exactly ${c.amountIn}`);
  if (d.dstReceiver !== lc(c.wallet)) refuse(`the KyberSwap swap pays ${d.dstReceiver}, not our wallet`);
  if (d.feeReceivers !== 0) refuse('the KyberSwap swap pays fee receivers');
  if (d.minReturnAmount < c.minOut) refuse(`the route's on-chain minimum ${d.minReturnAmount} is below ours (${c.minOut})`);
  return { swap: { to: KYBER.router as string, data: b.data, value: b.value }, minReturn: d.minReturnAmount };
}
