export const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
/** With an API key (x-api-key): the keyed host, at the key's rate limit instead of the keyless one. */
export const JUPITER_KEYED_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
export async function fetchJupiterQuote(o) {
    const slip = o.slippageBps ?? 50;
    if (!(o.amount > 0n))
        throw new Error('amount must be positive');
    const u = new URL(o.url ?? (o.apiKey ? JUPITER_KEYED_QUOTE_URL : JUPITER_QUOTE_URL));
    u.search = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount.toString(), slippageBps: String(slip), restrictIntermediateTokens: 'true' }).toString();
    const res = await (o.fetchFn ?? fetch)(u.toString(), { headers: o.apiKey ? { 'x-api-key': o.apiKey } : {}, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    if (!res.ok)
        throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
    const j = await res.json();
    if (j?.error)
        throw new Error(`Jupiter quote error: ${String(j.error).slice(0, 200)}`);
    if (j.inputMint !== o.inputMint || j.outputMint !== o.outputMint)
        throw new Error('Jupiter answered for a different pair than requested: refusing it');
    if (j.swapMode !== 'ExactIn')
        throw new Error(`unexpected swap mode ${j.swapMode}`);
    const big = (v, name) => { if (typeof v !== 'string' || !/^\d+$/.test(v))
        throw new Error(`Jupiter field ${name} is not an integer string`); return BigInt(v); };
    const inAmount = big(j.inAmount, 'inAmount'), outAmount = big(j.outAmount, 'outAmount'), minOut = big(j.otherAmountThreshold, 'otherAmountThreshold');
    if (inAmount !== o.amount)
        throw new Error(`Jupiter quoted ${inAmount} in, we asked for ${o.amount}`);
    if (outAmount <= 0n || minOut > outAmount)
        throw new Error('Jupiter quote is inconsistent (zero output or threshold above output)');
    const impact = Number(j.priceImpactPct);
    if (!Number.isFinite(impact))
        throw new Error('Jupiter priceImpactPct is not a number');
    const route = (Array.isArray(j.routePlan) ? j.routePlan : []).map((r) => ({ label: String(r?.swapInfo?.label ?? '?'), percent: Number(r?.percent ?? 0), ammKey: String(r?.swapInfo?.ammKey ?? '') }));
    return { inputMint: j.inputMint, outputMint: j.outputMint, inAmount, outAmount, minOut, slippageBps: Number(j.slippageBps), priceImpactPct: impact, contextSlot: Number(j.contextSlot), route };
}
/** How far our own quote is from Jupiter's, in bps of Jupiter's output (positive = ours is lower). Jupiter may route over several pools, so a gap is expected; this is a sanity bound, not a pass/fail oracle. */
export const quoteGapBps = (ours, jup) => Number((jup.outAmount - ours) * 10000n / jup.outAmount);
