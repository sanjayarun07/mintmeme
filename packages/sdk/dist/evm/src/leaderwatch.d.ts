/** LeaderWatcher: turns a leader wallet's on-chain activity into CopyEngine `LeaderEvent`s using plain JSON-RPC (no indexer, no mempool).
 *  How it works: scan each new block, take transactions whose `from` is a tracked leader, read the receipt, and compute the leader's NET token
 *  deltas from ERC-20 Transfer logs plus native value / WETH Withdrawal. Exactly one non-quote token moving against a quote asset = a swap.
 *  Balances before/after come from eth_call at block-1 / block (needs state for those blocks: fine near head, archive node for old ones).
 *  Reorgs: emitted events are tracked by block hash for `trackDepth` blocks; if the tx vanishes or lands in another block, it is reported in `reorged`.
 *  Honest limits (see docs/KNOWN_LIMITATIONS.md): only transactions SENT BY the leader EOA (not smart-wallet / aggregator-internal / contract wallets);
 *  protocol-agnostic delta detection, so a token with transfer tax shows the net amount; several leader txs in one block share the block-level balance reads;
 *  ERC-721/1155 are ignored; no mempool: the earliest signal is a mined block. */
import type { LeaderEvent } from '../../core/src/index.ts';
import type { RpcLike } from './rpcchain.ts';
export declare const NATIVE_QUOTE = "NATIVE";
export interface WatchCfg {
    chain: string;
    weth: string;
    leaders: string[];
    /** Assets that count as the "money" side of a swap: lowercase token addresses and/or 'NATIVE'. */
    quoteTokens: string[];
    /** Hold an event until its block has this many confirmations (0 = act as soon as it is mined). One policy per watcher. */
    minConfirmations: number;
    startBlock?: number;
    maxBlocksPerPoll?: number;
    trackDepth?: number;
}
export interface Tracked {
    txHash: string;
    blockHash: string;
    blockNumber: number;
}
type Held = LeaderEvent & Tracked;
export interface WatchState {
    cursor: number | undefined;
    tipHash: string | undefined;
    known: string[];
    holding: Held[];
    tracked: Tracked[];
}
export declare class LeaderWatcher {
    private cfg;
    private rpc;
    cursor: number | undefined;
    tipHash: string | undefined;
    known: Set<string>;
    holding: Held[];
    tracked: Tracked[];
    private leaders;
    constructor(cfg: WatchCfg, rpc: RpcLike);
    snapshot(): WatchState;
    load(s: WatchState): void;
    private head;
    private balanceAt;
    /** One pass. Throws on node errors WITHOUT losing progress: the cursor only moves past blocks that were scanned completely. */
    poll(): Promise<{
        events: LeaderEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
    /** Receipt -> LeaderEvent (swap) / 'transfer' event (any other value movement) / undefined (no value movement or reverted). */
    private parse;
}
export {};
