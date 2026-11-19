/** Mainnet endpoints and addresses for the Solana test UI and the local fork tests. Addresses were copied from official pages on 2026-11-13 (source beside each) and are
 *  verified ON-CHAIN by the fork tests, so a wrong value fails instead of passing. The RPC key is never logged: callers redact it. */
export const urls = (key: string) => ({ eth: `https://eth-mainnet.g.alchemy.com/v2/${key}`, sol: `https://solana-mainnet.g.alchemy.com/v2/${key}` });
/** The Solana RPC every part of this repo uses: SOLANA_RPC_URL, else Helius from HELIUS_API_KEY, else Alchemy from ALCHEMY_API_KEY (its Solana limits answered 429 to
 *  getSlot on the public site). `secret` is the key part to redact from errors. undefined when none is set. */
export function solanaRpc(e: NodeJS.ProcessEnv = process.env): { url: string; secret: string; name: string } | undefined {
  const own = e.SOLANA_RPC_URL?.trim(), helius = e.HELIUS_API_KEY?.trim(), alchemy = e.ALCHEMY_API_KEY?.trim();
  if (own) { const k = /api-key=([^&]+)/.exec(own)?.[1] ?? own.split('/').pop() ?? own; return { url: own, secret: k, name: /helius/.test(own) ? 'Helius' : 'SOLANA_RPC_URL' }; }
  if (helius) return { url: `https://mainnet.helius-rpc.com/?api-key=${helius}`, secret: helius, name: 'Helius' };
  if (alchemy) return { url: urls(alchemy).sol, secret: alchemy, name: 'Alchemy' };
  return undefined;
}
/** Ethereum mainnet, Uniswap V2 (used by the SDK's Ethereum fork test, npm run verify:evm). WETH is not on Uniswap's page: it is read on-chain from router.WETH(). */
export const ETH = {
  chainIdExpected: 1n,
  uniswapV2Factory: { address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  uniswapV2Router02: { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', source: 'https://developers.uniswap.org/deployments (v2 deployments page)' },
  usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
};
