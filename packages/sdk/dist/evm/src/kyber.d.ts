/** Engine token ('NATIVE' or 0x address) as KyberSwap writes it (ETH is 0xeeee...eeee). */
export declare const kAddr: (t: string) => string;
/** KyberSwap could not answer right now (rate limited, a server error, unreachable): transient, so a trade waits and retries. Other answers (no route) are final. */
export declare class KyberUnavailable extends Error {
}
export interface KyberQuote {
    amountOut: bigint;
    routeSummary: unknown;
    path: string[];
}
export interface KyberBuild {
    to: string;
    data: string;
    value: bigint;
    amountOut: bigint;
}
export declare class KyberClient {
    private o;
    constructor(o?: {
        chain?: string;
        clientId?: string;
        baseUrl?: string;
        fetchFn?: typeof fetch;
        timeoutMs?: number; /** Retries after HTTP 429 (default 2, waiting 1.5 and 3 s). */
        retries429?: number;
    });
    private url;
    private call;
    /** Best route for an exact input. Read-only. */
    quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberQuote>;
    /** The transaction for a quoted route, sent from and paid to `wallet`, with `slippageBps`. Read-only (KyberSwap builds it; nothing is signed). */
    build(q: KyberQuote, wallet: string, slippageBps: number): Promise<KyberBuild>;
}
/** Refuses a KyberSwap transaction that is not exactly our swap (see the header). Returns the transaction to sign and its on-chain minimum. */
export declare function gateKyber(b: KyberBuild, c: {
    wallet: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minOut: bigint;
}): {
    swap: {
        to: string;
        data: string;
        value: bigint;
    };
    minReturn: bigint;
};
