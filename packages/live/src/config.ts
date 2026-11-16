/** Values copied from OFFICIAL pages on 2026-11-13 (source URL beside each). Anything not found officially is listed in `unconfigured`
 *  and is never filled from memory. The harness verifies every address ON-CHAIN, so a wrong value fails instead of passing. */
export const FETCHED = '2026-11-13';
export const ETH = {
  chainIdExpected: 1n,   // checked against what the node reports
  uniswapV2Factory: { address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  uniswapV2Router02: { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
  weth9: { address: null as string | null, note: 'not on the official Uniswap page; read from the official router WETH() on-chain instead' },
};
export const SOL = {
  programs: [
    { name: 'Raydium AMM v4', address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', source: 'https://docs.raydium.io/reference/program-addresses' },
    { name: 'Raydium CPMM', address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', source: 'https://docs.raydium.io/reference/program-addresses' },
    { name: 'Raydium CLMM', address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', source: 'https://docs.raydium.io/reference/program-addresses' },
  ],
  unconfigured: ['Orca Whirlpools program id (not stated on docs.orca.so pages read; take from the SDK or official repo)', 'SPL Token program id (solana.com/docs was rate limited)', 'Wrapped SOL mint (same)'],
};
/** Raydium AMM v4 account layout (LIQUIDITY_STATE_LAYOUT_V4, 752 bytes, little-endian). Offsets summed by hand from the official SDK field list:
 *  https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/liquidity/layout.ts (cross-checked against raydium-sdk/src/liquidity/layout.ts). */
export { AMM_V4_LAYOUT } from '../../sol/src/raydium.ts';
/** OBSERVED 2026-11-14, not from a vendor doc: this account is touched by Raydium AMM v4 pool creation (it is the create-pool fee destination in Raydium's open-source SDK; recalled, then checked). The 8 most
 *  recent signatures touching it were each parsed by RaydiumLaunchSource into a pool that passed the on-chain checks (owner = AMM v4 program, 752 bytes). It is a DISCOVERY aid for `RaydiumLaunchSource.watch`,
 *  so polling reads a handful of transactions instead of every swap on the program. If Raydium ever changes it, detection goes quiet (see KNOWN_LIMITATIONS). */
export const RAYDIUM_V4_POOL_CREATION_WATCH = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';
/** OBSERVED 2026-11-14: the mint-authority account that signs every Pump.fun token creation (in a 25 s live window all 17 transactions that mentioned it were CreateV2, each initialising a new Token-2022 mint).
 *  A log subscription that mentions it carries creations only, not every trade on the program (the program itself produced ~330 notifications/s in the same window). The program is PAD.pump.program. */
export const PUMP_CREATE_WATCH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
/** Solana Foundation's public JSON-RPC WebSocket. OBSERVED 2026-11-14: it accepts logsSubscribe, while Alchemy's Solana endpoint on this plan answers "Method 'logsSubscribe' not found". Rate limited, no SLA. Override with SOLANA_WS_URL. */
export const SOLANA_PUBLIC_WS = 'wss://api.mainnet-beta.solana.com';
export const SOL_POOL = {
  // Highest-TVL standard (AMM v4) SOL/USDC pool per api-v3.raydium.io /pools/info/mint on 2026-11-13. The harness verifies it ON-CHAIN (owner program, size, mints), so a wrong id fails.
  id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', idSource: 'https://api-v3.raydium.io/pools/info/mint (mint1=WSOL, mint2=USDC, poolType=standard, sorted by liquidity)',
  wsol: { mint: 'So11111111111111111111111111111111111111112', source: 'mintA in the Raydium API pool response' },
  usdc: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
  benchmarkPoolInfo: 'https://api-v3.raydium.io/pools/info/ids', benchmarkQuote: 'https://transaction-v1.raydium.io/compute/swap-base-in',
};
export const ETH_UNCONFIGURED = ['Uniswap V2 pair init code hash (not on the official deployments page; pairs are read via factory.getPair instead)'];
export const urls = (key: string) => ({ eth: `https://eth-mainnet.g.alchemy.com/v2/${key}`, sol: `https://solana-mainnet.g.alchemy.com/v2/${key}` });

/** BNB Smart Chain, PancakeSwap V2. Every value below was read on an official page on 2026-11-14 (not recalled). WBNB is NOT on those pages: it is read on-chain from router.WETH(). */
export const BSC = {
  chainIdExpected: 56n, chainIdSource: 'https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/',
  pancakeV2Factory: { address: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', source: 'https://developer.pancakeswap.finance/contracts/v2/addresses' },
  pancakeV2Router: { address: '0x10ED43C718714eb63d5aA57B78B54704E256024E', source: 'https://developer.pancakeswap.finance/contracts/v2/addresses' },
};
/** Default BSC node: the first public mainnet endpoint on the official page (no key; stated limit 10K requests per 5 minutes; eth_getLogs is disabled there, we only use eth_call).
 *  Override with BSC_RPC_URL. The Alchemy key in .env is not enabled for BNB (it answers 403), so it is not used for BSC. */
export const BSC_PUBLIC_RPC = { url: 'https://bsc-dataseed.bnbchain.org', source: 'https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/' };
export const urlsBsc = (_key?: string) => process.env.BSC_RPC_URL || BSC_PUBLIC_RPC.url;
