/** V2LaunchWatcher: detects new Uniswap-V2-style pools and their first liquidity from chain logs (factory PairCreated + pair Mint) over plain JSON-RPC,
 *  and turns them into `LaunchEvent`s for the core LaunchDetector. Only pairs against the wrapped native token are launches here.
 *  What it CANNOT see (so the sniper must not pretend to): a token's own "trading enabled" switch (there is no standard event: the sniper learns about it only
 *  by test-simulating the buy), launchpad curves, v3/v4 pools, and anything before the first poll (it starts from the current head).
 *  Reorgs: emitted events are tracked by block hash for `trackDepth` blocks; a vanished tx is reported so the detector can revoke it. */
import type { LaunchEvent } from '../../core/src/index.ts';
import type { RpcLike } from './rpcchain.ts';
export interface LaunchWatchCfg {
    chain: string;
    factory: string;
    weth: string;
    startBlock?: number;
    maxBlocksPerPoll?: number;
    trackDepth?: number;
}
export interface PairInfo {
    token: string;
    pair: string;
    wethIsToken0: boolean;
}
interface Tracked {
    txHash: string;
    blockHash: string;
    blockNumber: number;
}
export interface LaunchWatchState {
    cursor: number | undefined;
    tipHash: string | undefined;
    pairs: [string, PairInfo][];
    known: string[];
    tracked: Tracked[];
}
export declare class V2LaunchWatcher {
    private cfg;
    private rpc;
    cursor: number | undefined;
    tipHash: string | undefined;
    pairs: Map<string, PairInfo>;
    known: Set<string>;
    tracked: Tracked[];
    constructor(cfg: LaunchWatchCfg, rpc: RpcLike);
    snapshot(): LaunchWatchState;
    load(s: LaunchWatchState): void;
    poll(): Promise<{
        events: LaunchEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
}
export {};
