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
import { STOCK_LIST, STOCK_LIST_META } from './stocklist.generated.ts';

/** xStocks (Backed). 8 decimals. Extensions: metadataPointer, tokenMetadata, permanentDelegate, defaultAccountState (initialized), scaledUiAmountConfig, pausableConfig, confidentialTransferMint, transferHook (no program). */
export const XSTOCKS_KEYS = { freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', permanentDelegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', pauseAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs' } as const;
/** Ondo Global Markets. 9 decimals. Same extensions as xStocks but NO permanent delegate. */
export const ONDO_KEYS = { freezeAuthority: '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK', permanentDelegate: null, pauseAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD' } as const;
/** Backpack Securities. 6 decimals. Same extensions as xStocks; one key holds freeze, pause and the permanent delegate. */
export const BACKPACK_KEYS = { freezeAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a', permanentDelegate: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a', pauseAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a' } as const;
const ISSUERS = { x: { issuer: 'Backed (xStocks)', keys: XSTOCKS_KEYS }, on: { issuer: 'Ondo Global Markets', keys: ONDO_KEYS }, bp: { issuer: 'Backpack Securities', keys: BACKPACK_KEYS } } as const;

export interface StockEntry extends IssuedAsset {
  decimals: number; /** The underlying ticker: TSLAx, TSLAon and Backpack's TSLA are all TSLA. */ underlying: string;
  /** Snapshot from the registry run (STOCK_LIST_META.generatedAt). */ market: { liquidityUsd: number | null; deviationPct: number | null; tradable: boolean };
}
/** Every registered stock (TokenSafety's default allowance list). */
export const STOCKS_SOLANA: readonly StockEntry[] = STOCK_LIST.map(([code, symbol, mint, decimals, underlying, liq, dev, ok]) => ({ mint, symbol, ...ISSUERS[code], keys: { ...ISSUERS[code].keys }, decimals, underlying,
  market: { liquidityUsd: liq, deviationPct: dev, tradable: ok === 1 } }));
export const XSTOCKS_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.x.issuer);
export const ONDO_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.on.issuer);
export const BACKPACK_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.bp.issuer);
export { STOCK_LIST_META };

const byMint = new Map(STOCKS_SOLANA.map(a => [a.mint, a]));
/** Symbols are unique per issuer (xStocks end in x, Ondo in on) but could clash across issuers: the tradable one, then the most liquid, wins. */
const bySymbol = new Map<string, StockEntry>();
for (const a of [...STOCKS_SOLANA].sort((p, q) => Number(q.market.tradable) - Number(p.market.tradable) || (q.market.liquidityUsd ?? -1) - (p.market.liquidityUsd ?? -1))) { const k = a.symbol.toLowerCase(); if (!bySymbol.has(k)) bySymbol.set(k, a); }
export const stockByMint = (mint: string) => byMint.get(mint);
/** Ticker lookup (TSLAx, TSLAon, TSLA), case-insensitive; `issuer` narrows it. */
export const stockBySymbol = (symbol: string, issuer?: string) => issuer ? STOCKS_SOLANA.find(a => a.symbol.toLowerCase() === symbol.toLowerCase() && a.issuer === issuer) : bySymbol.get(symbol.toLowerCase());
