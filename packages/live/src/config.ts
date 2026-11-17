/** Mainnet endpoints and addresses for the Solana test UI and the local fork tests. Addresses were copied from official pages on 2026-11-13 (source beside each) and are
 *  verified ON-CHAIN by the fork tests, so a wrong value fails instead of passing. The RPC key is never logged: callers redact it. */
export const urls = (key: string) => ({ eth: `https://eth-mainnet.g.alchemy.com/v2/${key}`, sol: `https://solana-mainnet.g.alchemy.com/v2/${key}` });
/** Ethereum mainnet, Uniswap V2 (used by the SDK's Ethereum fork test, npm run verify:evm). WETH is not on Uniswap's page: it is read on-chain from router.WETH(). */
export const ETH = {
  chainIdExpected: 1n,
  uniswapV2Factory: { address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  uniswapV2Router02: { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
};
