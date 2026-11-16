import type { LeaderEvent } from '../../core/src/index.ts';
import type { SolRpc } from './raydium.ts';
export interface SolWatchCfg {
    chain: string;
    wsol: string;
    leaders: string[];
    /** Mints that count as the "quote" side of a swap. Wrapped SOL and native SOL are always merged into NATIVE. */
    quoteMints: string[];
    minConfirmations: number;
    /** Rent-exempt minimum of a token account (lamports), subtracted from the leader's SOL change when the tx created token accounts. Read once from the node when absent. */
    tokenAccountRent?: bigint;
    trackDepth?: number;
    maxPages?: number;
}
interface Held extends LeaderEvent {
    slot: number;
}
interface Tracked {
    txHash: string;
    slot: number;
}
export interface SolWatchState {
    cursors: [string, string][];
    known: string[];
    holding: Held[];
    tracked: Tracked[];
    seeded: string[];
}
export declare class SolLeaderWatcher {
    private cfg;
    private rpc;
    cursors: Map<string, string>;
    known: Set<string>;
    holding: Held[];
    tracked: Tracked[];
    private seeded;
    private rent?;
    /** signatures seen but not parseable as a swap/transfer, and why (kept short) */
    skipped: string[];
    /** history() only: signature -> slot of the transaction, so callers can look up block times. */
    slots: Map<string, number>;
    /** history() only: signature -> the quote asset of a swap ('NATIVE' for SOL, else the mint). */
    quotes: Map<string, string>;
    constructor(cfg: SolWatchCfg, rpc: SolRpc);
    snapshot(): SolWatchState;
    load(s: SolWatchState): void;
    private tokenRent;
    private statusOf;
    /** New signatures for one leader, OLDEST first. The first ever poll only records where "now" is. */
    private fresh;
    poll(): Promise<{
        events: LeaderEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
    /** Recent history of one wallet, newest first, as pure READ: no cursor, `known`, `holding` or `tracked` is touched. Examines the latest `limit` successful signatures (max 100);
     *  signatures that are not a token swap/transfer produce no event, and one the node cannot serve is skipped (a note is kept in `skipped`). */
    /** What the last history() call saw: signatures returned, how many of them failed on chain, how many successful ones were read, how many became events. */
    lastHistory: {
        signatures: number;
        failed: number;
        read: number;
        listed: number;
    };
    history(leader: string, limit: number): Promise<LeaderEvent[]>;
    /** Transaction -> the leader's own value movement. Undefined when nothing the leader owns moved. */
    private parse;
}
export {};
