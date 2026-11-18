import type { Backend } from '../../core/src/index.ts';
import { EvmRpcChain, RelayClient, KyberClient } from '../../evm/src/index.ts';
import type { RawSigner, Eip1559Request, RpcLike } from '../../evm/src/index.ts';
import { PrivyApi } from '../../sol/src/index.ts';
import type { PrivyConfig } from '../../sol/src/index.ts';
import { Trader } from './trader.ts';
/** Base mainnet, Uniswap V2 (addresses read back from the chain: router.factory(), router.WETH(), factory.getPair(WETH, USDC)). */
export declare const BASE: {
    readonly chainId: 8453;
    readonly router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24';
    readonly factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6';
    readonly weth: '0x4200000000000000000000000000000000000006';
    readonly usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    readonly wethUsdcPair: '0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c';
};
/** One EVM network the trader runs on: a Uniswap V2 style router and factory against the wrapped native coin, and a V2 pool against a dollar stablecoin for USD
 *  prices. Every address is read back from the chain (router.factory(), router.WETH(), factory.getPair(wrapped, usd)). `fee`: what a V2 pool keeps of the input
 *  (Uniswap V2 997/1000; PancakeSwap V2 9975/10000). `relay`: Relay's contracts are pinned for Base only, so other networks run without aggregator routes. */
export interface EvmNetwork {
    id: string;
    label: string;
    engineChain: string;
    chainId: number;
    router: string;
    factory: string;
    weth: string;
    native: string;
    dex: string;
    usd: {
        token: string;
        decimals: number;
        pair: string;
    };
    fee?: {
        num: bigint;
        den: bigint;
    };
    finalityDepth: number;
    relay: boolean;
    kyberChain?: string;
}
export declare const EVM_NETWORKS: Record<string, EvmNetwork>;
/** Defaults: at most 0.01 ETH per buy and 0.05 ETH of buys per day. The Privy policy should cap the value separately. */
export declare const BASE_DEFAULT_CAPS: {
    maxTradeWei: bigint;
    dailyCapWei: bigint;
};
/** Below this much WETH a V2 pool is treated as thin and Relay routes are added next to it (1 WETH). */
export declare const THIN_V2_WETH: bigint;
/** JSON-RPC over HTTPS. A JSON-RPC error object becomes JsonRpcError (the node answered); anything else is a transport failure. */
export declare class EvmJsonRpc implements RpcLike {
    private url;
    private o;
    private n;
    constructor(url: string, o?: {
        timeoutMs?: number;
        fetchFn?: typeof fetch;
    });
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
/** A RawSigner backed by Privy (eth_signTransaction). `wallets` maps each lowercase 0x address it may sign for to its Privy wallet id. */
export declare class PrivyEvmSigner implements RawSigner {
    private api;
    private wallets;
    constructor(api: PrivyApi, wallets: Map<string, string>);
    sign(q: Eip1559Request): Promise<string>;
}
export interface BaseTraderOptions {
    userId: string;
    /** The user's Privy Ethereum wallet address (0x...). Undefined: a read-only account that refuses trades until a wallet is linked. */
    address?: string;
    /** The Privy wallet id saved when the user linked (checked against Privy). Optional. */
    walletId?: string;
    rpcUrl: string;
    /** Privy settings with your BASE policy id (chainType is set to ethereum for you), or a PrivyApi built with chainType 'ethereum'. */
    privy: PrivyConfig | PrivyApi;
    persistDir?: string;
    state?: (name: string) => Backend;
    caps?: {
        maxTradeWei: bigint;
        dailyCapWei: bigint;
    };
    /** ETH/USD for USD triggers. Default: the Uniswap V2 WETH/USDC pool on Base, read on chain, cached 30 s. */
    ethUsd?: () => Promise<{
        price: number;
        at: number;
    } | null>;
    rpc?: RpcLike;
    log?: (m: string) => void;
    /** Relay routes for tokens without a Uniswap V2 WETH pool (Coinbase stocks, V3/V4/Aerodrome-only tokens). Default on; `false` turns it off. Relay's docs require an API
     *  key for /quote/v2 (`apiKey`). Your Privy Base policy must allow Relay's router and approval proxy (RELAY_BASE) or Privy refuses those trades. */
    relay?: false | {
        apiKey?: string;
        client?: RelayClient;
    };
    /** Which aggregator routes those tokens: 'relay' (default) or 'kyberswap' instead (packages/evm/src/kyber.ts, keyless with an x-client-id). Your Privy Base policy
     *  must allow KyberSwap's router (KYBER.router) for swaps and for exact approvals. `relay: false` turns aggregator routes off whichever is chosen. */
    aggregator?: 'relay' | 'kyberswap';
    kyber?: {
        clientId?: string;
        client?: KyberClient;
    };
    /** Which network (EVM_NETWORKS: base, bnb, robinhood). Default base. Caps and amounts are in that network's native coin (ETH or BNB, 18 decimals). */
    network?: string | EvmNetwork;
}
export interface BaseTrader {
    trader: Trader;
    chain: EvmRpcChain;
    active: boolean;
    why?: string;
    prepare: (token: string) => Promise<void>;
    sync: () => Promise<void>;
    refuseIfInactive: () => void;
    /** Plain units for one API call: `token` (0x address), `eth` for ETH amounts, `tokens` or `pct` to sell, `price` in ETH per token or `priceUsd`, `slippagePct` ... */
    simple: (path: string, body: any) => Promise<any>;
}
/** ETH/USD from the V2 WETH/USDC pool reserves on Base (one eth_call, cached). `net`: another network's native coin against its dollar pool. */
export declare function baseEthUsd(rpc: RpcLike, ttlMs?: number, net?: EvmNetwork): () => Promise<{
    price: number;
    at: number;
} | null>;
export declare function createBaseTrader(o: BaseTraderOptions): Promise<BaseTrader>;
