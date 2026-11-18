/** The chains one execution server can serve at once (CHAINS=solana,base). Each enabled chain gives every user its own account (Trader, wallet link, orders,
 *  journal, ledger, settings), all under the user's ONE lease, so a node's leases, forwarding, Redis, rate limits and health are shared by every chain.
 *
 *  Requests name the chain with a path prefix: /v1/<chain>/... (for example /v1/base/trades/buy, /v1/base/wallet/link/start). A path without a prefix goes to the
 *  DEFAULT chain, the first one in CHAINS, so a single-chain server and its clients keep working unchanged.
 *
 *  State: the default chain keeps the unprefixed state names it always had (`<ns>:u:<user>:engine`, `...:solwallet`), so data written by a single-chain server still loads.
 *  Every other chain's state is under `<ns>:u:<user>:@<chain>:<name>`. The default chain is written to Redis (`<ns>:chains:default`) the first time a node starts, and a
 *  node whose first chain differs refuses to start: reordering CHAINS would otherwise hand one chain's journal to another.
 *
 *  Adding an EVM chain is an entry in CHAIN_SPECS (chain id, the env names of its RPC, Privy policy and caps, its aggregator), built by evmChain() in main.ts. The SDK's
 *  EVM trader (packages/sdk/src/base.ts) needs the network's contracts (V2 router, factory, wrapped native, a dollar pool) in EVM_NETWORKS; it has base, bnb and robinhood. */

export type ChainKind = 'practice' | 'solana' | 'evm';
export interface EvmSpec {
  /** EIP-155 chain id. */
  chainId: number;
  /** The env var with the RPC URL, and Alchemy's network name for the ALCHEMY_API_KEY fallback (https://<alchemyNet>.g.alchemy.com/v2/<key>). */
  rpcEnv: string; alchemyNet?: string;
  /** The env var with this chain's Privy policy id (each chain has its own policy: its own contracts and value caps). */
  policyEnv: string;
  /** Prefix of the engine's caps: <capsPrefix>_MAX_TRADE_ETH and <capsPrefix>_DAILY_CAP_ETH (native coin, 18 decimals), and their defaults. */
  capsPrefix: string; maxTradeDefault: string; dailyCapDefault: string;
  /** Which contract set of the SDK's EVM trader this chain uses (packages/sdk/src/base.ts EVM_NETWORKS: base, bnb, robinhood). */
  network: 'base' | string;
  /** Aggregators for tokens with no direct pool: the env var that turns Relay off (=off) and Relay's API key env var. */
  relayEnv?: string; relayKeyEnv?: string;
  /** The env var that picks the aggregator, when the SDK offers more than one for this network. */
  aggregatorEnv?: string;
  nativeSymbol: string;
}
export interface ChainSpec { id: string; kind: ChainKind; label: string; evm?: EvmSpec }

export const CHAIN_SPECS: Record<string, ChainSpec> = {
  practice: { id: 'practice', kind: 'practice', label: 'Practice (simulated chain, fake funds)' },
  solana: { id: 'solana', kind: 'solana', label: 'Solana mainnet' },
  base: { id: 'base', kind: 'evm', label: 'Base mainnet', evm: { chainId: 8453, rpcEnv: 'BASE_RPC_URL', alchemyNet: 'base-mainnet', policyEnv: 'PRIVY_BASE_POLICY_ID',
    capsPrefix: 'BASE', maxTradeDefault: '0.01', dailyCapDefault: '0.05', network: 'base', relayEnv: 'BASE_RELAY', relayKeyEnv: 'RELAY_API_KEY', aggregatorEnv: 'BASE_AGGREGATOR', nativeSymbol: 'ETH' } },
  // BNB Smart Chain: PancakeSwap V2 against WBNB. Caps are in BNB (BNB_MAX_TRADE_ETH / BNB_DAILY_CAP_ETH: the suffix names the 18-decimal native unit, not the coin).
  bnb: { id: 'bnb', kind: 'evm', label: 'BNB Chain', evm: { chainId: 56, rpcEnv: 'BNB_RPC_URL', alchemyNet: 'bnb-mainnet', policyEnv: 'PRIVY_BNB_POLICY_ID',
    capsPrefix: 'BNB', maxTradeDefault: '0.02', dailyCapDefault: '0.1', network: 'bnb', nativeSymbol: 'BNB' } },
  // Robinhood Chain (Arbitrum Nitro L2, ETH gas): Uniswap V2 against WETH.
  robinhood: { id: 'robinhood', kind: 'evm', label: 'Robinhood Chain', evm: { chainId: 4663, rpcEnv: 'ROBINHOOD_RPC_URL', alchemyNet: 'robinhood-mainnet', policyEnv: 'PRIVY_ROBINHOOD_POLICY_ID',
    capsPrefix: 'ROBINHOOD', maxTradeDefault: '0.01', dailyCapDefault: '0.05', network: 'robinhood', nativeSymbol: 'ETH' } },
  // The next EVM chain is one more entry here plus its contracts in EVM_NETWORKS (packages/sdk/src/base.ts), for example:
  // arbitrum: { id: 'arbitrum', kind: 'evm', label: 'Arbitrum One', evm: { chainId: 42161, rpcEnv: 'ARBITRUM_RPC_URL', alchemyNet: 'arb-mainnet', policyEnv: 'PRIVY_ARBITRUM_POLICY_ID',
  //   capsPrefix: 'ARBITRUM', maxTradeDefault: '0.01', dailyCapDefault: '0.05', network: 'arbitrum', nativeSymbol: 'ETH' } },
};

/** First path segments of the API's own routes: a chain id may never be one of these, or /v1/<chain>/... would be ambiguous. */
export const RESERVED_SEGMENTS = new Set(['app', 'overview', 'quote', 'trades', 'wallets', 'wallet', 'orders', 'bulk', 'twap', 'alerts', 'positions', 'history', 'entries',
  'snipes', 'copies', 'events', 'health', 'openapi.json', 'records', 'tokens', 'stocks', 'settings', 'chains']);
export const CHAIN_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** MODE values from before CHAINS existed, and the chain each one is. */
const MODES: Record<string, string> = { practice: 'practice', 'solana-mainnet': 'solana', 'base-mainnet': 'base' };

/** The chains to serve, default first. CHAINS=solana,base wins; otherwise MODE (practice, solana-mainnet, base-mainnet) is a one-chain shorthand; neither: practice. */
export function parseChains(e: NodeJS.ProcessEnv, specs: Record<string, ChainSpec> = CHAIN_SPECS): ChainSpec[] {
  const raw = e.CHAINS?.trim();
  if (raw) {
    const ids = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!ids.length) throw new Error('CHAINS is empty: list one or more of ' + Object.keys(specs).join(', '));
    const seen = new Set<string>();
    for (const id of ids) {
      if (!specs[id]) throw new Error(`CHAINS: ${id} is not a known chain. Known: ${Object.keys(specs).join(', ')}`);
      if (seen.has(id)) throw new Error(`CHAINS lists ${id} twice`); seen.add(id);
    }
    if (e.MODE && !ids.includes(MODES[e.MODE] ?? '')) throw new Error(`MODE=${e.MODE} and CHAINS=${raw} disagree: unset MODE (CHAINS replaces it)`);
    if (ids.includes('practice') && ids.length > 1) throw new Error('CHAINS: practice (fake funds) cannot be served next to real chains on one server: run it on its own NAMESPACE');
    return ids.map(id => specs[id]);
  }
  const mode = e.MODE ?? 'practice', id = MODES[mode];
  if (!id) throw new Error(`MODE=${mode} is not built in. Use CHAINS=solana,base (any of ${Object.keys(specs).join(', ')}), or MODE=practice, solana-mainnet or base-mainnet.`);
  return [specs[id]];
}

/** Check a spec table (a unit test runs this over CHAIN_SPECS). */
export function checkSpecs(specs: Record<string, ChainSpec>) {
  for (const [k, s] of Object.entries(specs)) {
    if (k !== s.id) throw new Error(`chain ${k}: id ${s.id} differs from its key`);
    if (!CHAIN_ID_RE.test(s.id) || RESERVED_SEGMENTS.has(s.id)) throw new Error(`chain id ${s.id} is not allowed (lowercase letters, digits, dash; not an API route name)`);
    if (s.kind === 'evm' && (!s.evm || !Number.isInteger(s.evm.chainId))) throw new Error(`chain ${s.id}: an evm chain needs evm.chainId`);
  }
}

/** Redis key of the namespace's default chain (see the header). */
export const defaultChainKey = (ns: string) => `${ns}:chains:default`;
/** The state name a chain's account uses for `name`: the default chain keeps the old names, every other chain is prefixed. */
/** `@` cannot appear in an app end user's id (`<app>:<endUser>`, letters, digits, dot, dash, underscore), so `<ns>:u:shop:@base:engine` (user shop on base) can never be
 *  the default-chain state of end user `base` of app `shop` (`<ns>:u:shop:base:engine`). */
export const stateName = (chain: string, isDefault: boolean, name: string) => (isDefault ? name : `@${chain}:${name}`);
