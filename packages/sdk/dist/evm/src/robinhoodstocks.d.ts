/** Robinhood stock tokens on Robinhood Chain (4663), from https://api.robinhood.com/rhj/assets on 2026-11-19: 203 tokens, all ACTIVE, 18 decimals, one deployment each,
 *  issued by Robinhood Assets (Jersey) Ltd (docs/XSTOCKS.md, "Robinhood Chain"). The key is the underlying ticker, which is also the token's symbol.
 *  One token is worth uiMultiplier() / 1e18 shares (dividends and splits move it: TSLA 1.0, NVDA 1.000775, SPY 1.001718 on 2026-11-19); read it on chain, never assume 1.
 *  Liquidity is on Uniswap V3/V4 and KyberSwap's PMM (Metric), reached through KyberSwap. */
export declare const ROBINHOOD_STOCKS: Record<string, string>;
/** uiMultiplier() selector (keccak256("uiMultiplier()")[0..4]); the result is shares per token scaled by 1e18. */
export declare const UI_MULTIPLIER_SELECTOR = "0xa60bf13d";
