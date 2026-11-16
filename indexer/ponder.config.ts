/** Which chains and pools to index comes ONLY from environment variables: no address, chain id or RPC URL is baked in.
 *  INDEX_CHAINS            comma list of chain keys the terminal uses: ethereum,bnb
 *  For each key K (upper-case, e.g. ETHEREUM):
 *    INDEX_RPC_<K>           JSON-RPC URL (a local anvil fork for verification)
 *    INDEX_CHAIN_ID_<K>      chain id of that RPC (checked by Ponder against the node)
 *    INDEX_POOLS_<K>         comma list of V2 pair addresses to index
 *    INDEX_START_BLOCK_<K>   first block to index (use a recent block; history before it is not indexed)
 *    INDEX_STABLES_<K>       comma list of stablecoin token addresses that count as USD quote
 *    INDEX_WRAPPED_<K>       wrapped native token address (WETH / WBNB)
 *    INDEX_REF_POOL_<K>      a wrapped-native/stablecoin pair (must also be in INDEX_POOLS) used to price the native token
 */
import { createConfig } from 'ponder';
import { http } from 'viem';
import { pairAbi } from './abis/pair.ts';

const env = process.env, keys = (env.INDEX_CHAINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is not set (see indexer/README.md)`); return v; };
const chains: Record<string, any> = {}, contracts: Record<string, any> = {};
for (const key of keys) {
  const K = key.toUpperCase();
  chains[key] = { id: Number(need(`INDEX_CHAIN_ID_${K}`)), rpc: http(need(`INDEX_RPC_${K}`)), pollingInterval: 1000 };
  contracts[`Pair_${key}`] = { abi: pairAbi, chain: { [key]: { address: need(`INDEX_POOLS_${K}`).split(',').map(s => s.trim().toLowerCase()), startBlock: Number(need(`INDEX_START_BLOCK_${K}`)) } } };
}
export default createConfig({ chains, contracts } as any);
