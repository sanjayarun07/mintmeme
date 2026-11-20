/** bStocks on BNB Chain (BTech, Binance-affiliated): the ones on Trust Wallet's announcement (docs/XSTOCKS.md, "BNB Chain"); Binance publishes no address list, and the
 *  others sharing their beacon (QQQB, SPYB, SPCXB, MSTRB, BNCB) are left out because no official list names them. 18 decimals, BEP-20 with Scaled UI (BEP-677): one token
 *  is uiMultiplier()/1e18 shares (NVDAB 1.000778 on 2026-11-19). Liquidity is on PancakeSwap V3/Infinity and prop AMMs, reached through KyberSwap; their V2 pools are thin.
 *  Checked on chain 2026-11-20 (read-only): every address below is a beacon proxy of the bStocks beacon BSTOCKS_BEACON, with its own symbol and 18 decimals.
 *  SNDKB (0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb, same beacon) is LEFT OUT: its uiMultiplier() reads 8 shares per token, but it trades at the price of ONE SanDisk share
 *  (about $710 on 2026-11-20, DexScreener and a KyberSwap quote), so the share-price check could not trust it. Add it back only once its multiplier matches its market. */
export const BNB_STOCKS: Record<string, string> = {
  NVDAB: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', TSLAB: '0x5b1910eaad6450e50f816082aa078c41f10c292f', CRCLB: '0x80f3d493ebce97e343c53d29a137942416b4ffc0',
  MUB: '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699',
};
/** The beacon every bStock above points at (EIP-1967 beacon slot), read on chain 2026-11-20. */
export const BSTOCKS_BEACON = '0x156d6dce9a4f6139a3406f1f021f1a4880de93a3';
