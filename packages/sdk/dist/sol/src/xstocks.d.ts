/** TOKENIZED STOCKS ON SOLANA, traded here like any token through Jupiter routes (docs/XSTOCKS.md has the sources, liquidity and limits per chain).
 *  All are Token-2022 mints whose issuer keeps a freeze authority and a pause (xStocks and Backpack also a permanent delegate) on purpose: sanctions, court orders, corporate actions.
 *  TokenSafety blocks any such token; for the registered mints it reports these as issuer controls (warnings) ONLY while the on-chain keys equal the keys pinned here. A lookalike
 *  mint, a key change, a delegate appearing where there was none, a paused mint or a transfer hook being set is checked like any other token.
 *  THE REGISTRY is generated (stocklist.generated.ts, `npm run stocks:registry`): every mint on each issuer's own list that carries that issuer's pinned keys on chain, with a
 *  market snapshot (Jupiter liquidity, and whether a 0.05 SOL buy route filled within 3% of the share price). `tradable` in that snapshot is a hint for listings only:
 *  trades are always re-checked live (apps/server/solaccount.ts).
 *  Corporate actions use scaledUiAmountConfig: raw balances never change, one token = multiplier x one share (stocks.ts converts).
 *  None is for US persons (and other restricted places, per each issuer's terms): eligibility is the operator's job, this engine does not know who the user is. */
import type { IssuedAsset } from './tokensafety.ts';
import { STOCK_LIST_META } from './stocklist.generated.ts';
/** xStocks (Backed). 8 decimals. Extensions: metadataPointer, tokenMetadata, permanentDelegate, defaultAccountState (initialized), scaledUiAmountConfig, pausableConfig, confidentialTransferMint, transferHook (no program). */
export declare const XSTOCKS_KEYS: {
    readonly freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs';
    readonly permanentDelegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq';
    readonly pauseAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs';
};
/** Ondo Global Markets. 9 decimals. Same extensions as xStocks but NO permanent delegate. */
export declare const ONDO_KEYS: {
    readonly freezeAuthority: '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK';
    readonly permanentDelegate: null;
    readonly pauseAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD';
};
/** Backpack Securities. 6 decimals. Same extensions as xStocks; one key holds freeze, pause and the permanent delegate. */
export declare const BACKPACK_KEYS: {
    readonly freezeAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a';
    readonly permanentDelegate: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a';
    readonly pauseAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a';
};
export interface StockEntry extends IssuedAsset {
    decimals: number; /** The underlying ticker: TSLAx, TSLAon and Backpack's TSLA are all TSLA. */
    underlying: string;
    /** Snapshot from the registry run (STOCK_LIST_META.generatedAt). */ market: {
        liquidityUsd: number | null;
        deviationPct: number | null;
        tradable: boolean;
    };
}
/** Every registered stock (TokenSafety's default allowance list). */
export declare const STOCKS_SOLANA: readonly StockEntry[];
export declare const XSTOCKS_SOLANA: StockEntry[];
export declare const ONDO_SOLANA: StockEntry[];
export declare const BACKPACK_SOLANA: StockEntry[];
export { STOCK_LIST_META };
export declare const stockByMint: (mint: string) => StockEntry | undefined;
/** Ticker lookup (TSLAx, TSLAon, TSLA), case-insensitive; `issuer` narrows it. */
export declare const stockBySymbol: (symbol: string, issuer?: string) => StockEntry | undefined;
