// Minimal Uniswap V2 / PancakeSwap V2 pair ABI: only what the indexer reads. Event and function signatures are the public V2 interface.
export const pairAbi = [
  { type: 'event', name: 'Swap', inputs: [
    { name: 'sender', type: 'address', indexed: true }, { name: 'amount0In', type: 'uint256', indexed: false }, { name: 'amount1In', type: 'uint256', indexed: false },
    { name: 'amount0Out', type: 'uint256', indexed: false }, { name: 'amount1Out', type: 'uint256', indexed: false }, { name: 'to', type: 'address', indexed: true } ] },
  { type: 'event', name: 'Sync', inputs: [{ name: 'reserve0', type: 'uint112', indexed: false }, { name: 'reserve1', type: 'uint112', indexed: false }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
export const erc20Abi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;
