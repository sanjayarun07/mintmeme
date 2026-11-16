import type { ChainPort } from './port.ts';
/**
 * One shared price feed for many accounts. Wrap a single read chain once and give the wrapper to every account's engine and order runner:
 *  - refresh('venues') is single-flight (callers that arrive while one is running share it) and reused for `ttlMs` after it finishes, so N accounts
 *    ticking once a second cause ONE reload of the pools, not N. Price staleness is therefore at most `ttlMs` (default 500 ms) beyond what an
 *    order's own maxQuoteAgeMs already allows.
 *  - refresh('head') is single-flight only, never reused: the engine relies on it to see new blocks and confirmations promptly.
 * Everything else (quotes, simulation, submit, balances) goes straight to the wrapped chain. The wrapper owns no keys and no per-user state.
 */
export declare class SharedFeed {
    private chain;
    private o;
    /** how many refresh calls arrived, and how many actually reached the wrapped chain */
    stats: {
        asked: number;
        upstream: number;
    };
    private inflight;
    private doneAt;
    constructor(chain: ChainPort, o?: {
        ttlMs?: number;
        clockMs?: () => number;
    });
    reset(): void;
    private refresh;
}
