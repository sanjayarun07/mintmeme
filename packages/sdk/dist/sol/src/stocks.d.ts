/** TOKENIZED-STOCK HELPERS for Solana: the live state of a stock mint (corporate-action multiplier, issuer pause), per-share amounts and prices, and a check of the price a route
 *  would fill at against the underlying stock price.
 *
 *  Per share vs per token: Solana stock mints (xStocks, Ondo, Backpack) carry Token-2022 `scaledUiAmountConfig`. Raw balances never change on a dividend or split; instead
 *  one token = `multiplier` shares (AAPLx 1.0033 after dividends). The engine trades raw token units, which is correct; a person thinks in shares and per-share prices:
 *    shares = tokens x multiplier,  price per share = price per token / multiplier.
 *  A scheduled change (`newMultiplier` from `newMultiplierEffectiveTimestamp`) applies from that time; issuers set it for 00:30 UTC the day after the ex-date.
 *
 *  Reference price: Jupiter's Price API V3 (`GET https://lite-api.jup.ag/price/v3?ids=...`, keyless) returns, for stock tokens, `stockData.price`: the underlying share price
 *  (seen 2026-11-18 for xStocks, Ondo and Backpack mints). A route that would fill far from it (Ondo on Solana filled at about 3x the share price on that day while Jupiter's
 *  impact figure said 0) is refused by `checkFillPrice`. */
import type { SolRpcLike } from './tokensafety.ts';
import type { IssuedAsset } from './tokensafety.ts';
export interface StockState {
    mint: string;
    decimals: number; /** Effective now, as a decimal string ("1" when the mint has no multiplier). */
    multiplier: string;
    paused: boolean;
    /** A scheduled multiplier not yet in force, and when (unix seconds). */ next?: {
        multiplier: string;
        at: number;
    };
}
/** Reads the mints (one getMultipleAccounts, jsonParsed). A mint that does not exist or is not a token mint is left out. `nowSec` decides which multiplier is in force. */
export declare function readStockStates(rpc: SolRpcLike, mints: string[], nowSec?: number): Promise<Map<string, StockState>>;
/** The state of one mint from its jsonParsed account (as getAccountInfo / getMultipleAccounts return it), or undefined if it is not a token mint. */
export declare function stockStateOf(mint: string, acct: any, nowSec?: number): StockState | undefined;
/** Raw token units for `shares` (a decimal string) of a stock: tokens = shares / multiplier, rounded DOWN (never sells or asks for more than the person said). */
export declare function rawForShares(shares: string, multiplier: string, decimals: number): bigint;
/** Shares for raw token units, as a decimal string with `places` decimals (rounded down). */
export declare function sharesForRaw(raw: bigint, multiplier: string, decimals: number, places?: number): string;
/** A per-share USD price as the per-token price the engine uses: per token = per share x multiplier. Returns a decimal string. */
export declare function perTokenPrice(perShareUsd: string, multiplier: string): string;
export interface StockPrice {
    usdPrice?: number; /** The underlying share price, when Jupiter knows the token is a stock. */
    stockPrice?: number;
}
/** Jupiter Price API V3, cached per mint (default 30 s). Failures return an empty map: callers treat "no reference" explicitly. */
export declare class JupiterStockPrices {
    private o;
    private cache;
    constructor(o?: {
        url?: string;
        fetchFn?: typeof fetch;
        ttlMs?: number;
        timeoutMs?: number;
        now?: () => number;
    });
    get(mints: string[]): Promise<Map<string, StockPrice>>;
}
export interface FillCheck {
    ok: boolean;
    perShareUsd: number;
    referenceUsd: number | null;
    deviationPct: number | null;
    why?: string;
}
/** The per-share USD price a route gives, against the underlying share price. Buying: paying more than `maxDeviationPct` above it is refused; selling: receiving more than that
 *  below it. Without a reference (`referenceUsd` null) the result is ok with `why` saying so: the caller decides whether that is acceptable. */
export declare function checkFillPrice(o: {
    side: 'buy' | 'sell';
    solLamports: bigint;
    tokensRaw: bigint;
    decimals: number;
    multiplier: string;
    solUsd: number;
    referenceUsd: number | null | undefined;
    maxDeviationPct?: number;
}): FillCheck;
/** The registered stock for a mint, or a symbol (TSLAx, TSLAon, TSLA), or undefined. */
export declare function findStock(mintOrSymbol: string, list?: readonly IssuedAsset[]): IssuedAsset | undefined;
/** The underlying ticker of a registered stock: TSLAx, TSLAon and TSLA are all TSLA. */
export declare const underlying: (a: IssuedAsset) => string;
