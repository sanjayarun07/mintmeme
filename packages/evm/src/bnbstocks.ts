/** bStocks on BNB Chain (BTech, Binance-affiliated). Binance publishes no address list, so the registry (bnbstocklist.generated.ts, `npm run stocks:bnb`) takes candidates from
 *  CoinGecko and keeps only tokens verified on chain to be beacon proxies of the bStocks beacon BSTOCKS_BEACON, with 18 decimals. 92 verified on 2026-11-20.
 *  BEP-20 with Scaled UI (BEP-677): one token is uiMultiplier()/1e18 shares (NVDAB 1.000778; SNDKB 8 after SanDisk's 8-for-1 split, as Coinbase's SNDKc on Base).
 *  Liquidity is on PancakeSwap V3/Infinity, Uniswap V3 and prop AMMs, reached through KyberSwap; V2 pools are thin. */
import { BNB_STOCK_LIST } from './bnbstocklist.generated.ts';

/** The beacon every bStock points at (EIP-1967 beacon slot), read on chain 2026-11-20 from the five on Trust Wallet's announcement (NVDAB, TSLAB, CRCLB, MUB, SNDKB). */
export const BSTOCKS_BEACON = '0x156d6dce9a4f6139a3406f1f021f1a4880de93a3';
/** The bStocks the server trades and the app lists: symbol to address, those tradable at the last registry run (liquidity, a KyberSwap route near the share price).
 *  The others stay in BNB_STOCK_LIST for reference. Every trade is re-checked against the share price whatever the registry said. */
export const BNB_STOCKS: Record<string, string> = Object.fromEntries(BNB_STOCK_LIST.filter(r => r[6] === 1).map(r => [r[0], r[1]]));
/** Company name by symbol, for display. */
export const BNB_STOCK_NAMES: Record<string, string> = Object.fromEntries(BNB_STOCK_LIST.map(r => [r[0], r[2]]));
