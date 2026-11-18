/** Jupiter aggregator QUOTE client (read-only). Fetches an exact-in quote from Jupiter's public Swap API v1 and validates its shape before anything trusts it.
 *  Scope: QUOTES ONLY. Executing a Jupiter route needs the /swap-instructions response (versioned transactions with address lookup tables), a different transaction builder than
 *  the legacy one in tx.ts; that is NOT implemented. Treat the result as a benchmark or a second opinion on price, never as something the engine can sign. */
export interface JupiterQuote {
    inputMint: string;
    outputMint: string;
    inAmount: bigint;
    outAmount: bigint;
    minOut: bigint;
    slippageBps: number;
    priceImpactPct: number;
    contextSlot: number;
    route: {
        label: string;
        percent: number;
        ammKey: string;
    }[];
}
export declare const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
/** With an API key (x-api-key): the keyed host, at the key's rate limit instead of the keyless one. */
export declare const JUPITER_KEYED_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
/** GET from Jupiter: with an API key, the keyed host and x-api-key; if the key's quota is used up (429) or the keyed host fails (5xx), the same request (`query`) on the
 *  keyless host. A custom `url` (tests, a proxy) is used as given, with no fallback. The failed response's body is released before the retry. */
export declare function jupiterGet(o: {
    keyed: string;
    keyless: string;
    query: string;
    url?: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}): Promise<Response>;
export declare function fetchJupiterQuote(o: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps?: number;
    fetchFn?: typeof fetch;
    url?: string;
    timeoutMs?: number; /** Jupiter API key: sent as x-api-key, and the keyed host is used unless `url` is given. */
    apiKey?: string;
}): Promise<JupiterQuote>;
/** How far our own quote is from Jupiter's, in bps of Jupiter's output (positive = ours is lower). Jupiter may route over several pools, so a gap is expected; this is a sanity bound, not a pass/fail oracle. */
export declare const quoteGapBps: (ours: bigint, jup: JupiterQuote) => number;
