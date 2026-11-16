/** Jupiter aggregator QUOTE client (read-only). Fetches an exact-in quote from Jupiter's public Swap API v1 and validates its shape before anything trusts it.
 *  Scope: QUOTES ONLY. Executing a Jupiter route needs the /swap-instructions response (versioned transactions with address lookup tables), a different transaction builder than
 *  the legacy one in tx.ts; that is NOT implemented. Treat the result as a benchmark or a second opinion on price, never as something the engine can sign. */
export interface JupiterQuote { inputMint: string; outputMint: string; inAmount: bigint; outAmount: bigint; minOut: bigint; slippageBps: number; priceImpactPct: number; contextSlot: number; route: { label: string; percent: number; ammKey: string }[] }
export const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export async function fetchJupiterQuote(o: { inputMint: string; outputMint: string; amount: bigint; slippageBps?: number; fetchFn?: typeof fetch; url?: string; timeoutMs?: number }): Promise<JupiterQuote> {
  const slip = o.slippageBps ?? 50; if (!(o.amount > 0n)) throw new Error('amount must be positive');
  const u = new URL(o.url ?? JUPITER_QUOTE_URL); u.search = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount.toString(), slippageBps: String(slip), restrictIntermediateTokens: 'true' }).toString();
  const res = await (o.fetchFn ?? fetch)(u.toString(), { signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
  const j: any = await res.json(); if (j?.error) throw new Error(`Jupiter quote error: ${String(j.error).slice(0, 200)}`);
  if (j.inputMint !== o.inputMint || j.outputMint !== o.outputMint) throw new Error('Jupiter answered for a different pair than requested: refusing it');
  if (j.swapMode !== 'ExactIn') throw new Error(`unexpected swap mode ${j.swapMode}`);
  const big = (v: unknown, name: string) => { if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`Jupiter field ${name} is not an integer string`); return BigInt(v); };
  const inAmount = big(j.inAmount, 'inAmount'), outAmount = big(j.outAmount, 'outAmount'), minOut = big(j.otherAmountThreshold, 'otherAmountThreshold');
  if (inAmount !== o.amount) throw new Error(`Jupiter quoted ${inAmount} in, we asked for ${o.amount}`);
  if (outAmount <= 0n || minOut > outAmount) throw new Error('Jupiter quote is inconsistent (zero output or threshold above output)');
  const impact = Number(j.priceImpactPct); if (!Number.isFinite(impact)) throw new Error('Jupiter priceImpactPct is not a number');
  const route = (Array.isArray(j.routePlan) ? j.routePlan : []).map((r: any) => ({ label: String(r?.swapInfo?.label ?? '?'), percent: Number(r?.percent ?? 0), ammKey: String(r?.swapInfo?.ammKey ?? '') }));
  return { inputMint: j.inputMint, outputMint: j.outputMint, inAmount, outAmount, minOut, slippageBps: Number(j.slippageBps), priceImpactPct: impact, contextSlot: Number(j.contextSlot), route };
}

/** How far our own quote is from Jupiter's, in bps of Jupiter's output (positive = ours is lower). Jupiter may route over several pools, so a gap is expected; this is a sanity bound, not a pass/fail oracle. */
export const quoteGapBps = (ours: bigint, jup: JupiterQuote) => Number((jup.outAmount - ours) * 10_000n / jup.outAmount);
