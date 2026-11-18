import { STOCK_LIST, STOCK_LIST_META } from './stocklist.generated.js';
/** xStocks (Backed). 8 decimals. Extensions: metadataPointer, tokenMetadata, permanentDelegate, defaultAccountState (initialized), scaledUiAmountConfig, pausableConfig, confidentialTransferMint, transferHook (no program). */
export const XSTOCKS_KEYS = { freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', permanentDelegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', pauseAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs' };
/** Ondo Global Markets. 9 decimals. Same extensions as xStocks but NO permanent delegate. */
export const ONDO_KEYS = { freezeAuthority: '51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK', permanentDelegate: null, pauseAuthority: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD' };
/** Backpack Securities. 6 decimals. Same extensions as xStocks; one key holds freeze, pause and the permanent delegate. */
export const BACKPACK_KEYS = { freezeAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a', permanentDelegate: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a', pauseAuthority: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a' };
const ISSUERS = { x: { issuer: 'Backed (xStocks)', keys: XSTOCKS_KEYS }, on: { issuer: 'Ondo Global Markets', keys: ONDO_KEYS }, bp: { issuer: 'Backpack Securities', keys: BACKPACK_KEYS } };
/** Every registered stock (TokenSafety's default allowance list). */
export const STOCKS_SOLANA = STOCK_LIST.map(([code, symbol, mint, decimals, underlying, liq, dev, ok]) => ({ mint, symbol, ...ISSUERS[code], keys: { ...ISSUERS[code].keys }, decimals, underlying,
    market: { liquidityUsd: liq, deviationPct: dev, tradable: ok === 1 } }));
export const XSTOCKS_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.x.issuer);
export const ONDO_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.on.issuer);
export const BACKPACK_SOLANA = STOCKS_SOLANA.filter(a => a.issuer === ISSUERS.bp.issuer);
export { STOCK_LIST_META };
const byMint = new Map(STOCKS_SOLANA.map(a => [a.mint, a]));
/** Symbols are unique per issuer (xStocks end in x, Ondo in on) but could clash across issuers: the tradable one, then the most liquid, wins. */
const bySymbol = new Map();
for (const a of [...STOCKS_SOLANA].sort((p, q) => Number(q.market.tradable) - Number(p.market.tradable) || (q.market.liquidityUsd ?? -1) - (p.market.liquidityUsd ?? -1))) {
    const k = a.symbol.toLowerCase();
    if (!bySymbol.has(k))
        bySymbol.set(k, a);
}
export const stockByMint = (mint) => byMint.get(mint);
/** Ticker lookup (TSLAx, TSLAon, TSLA), case-insensitive; `issuer` narrows it. */
export const stockBySymbol = (symbol, issuer) => issuer ? STOCKS_SOLANA.find(a => a.symbol.toLowerCase() === symbol.toLowerCase() && a.issuer === issuer) : bySymbol.get(symbol.toLowerCase());
