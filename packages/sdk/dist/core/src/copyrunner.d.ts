import { CopyEngine } from './copy.ts';
import type { CopyConfig, LeaderEvent } from './copy.ts';
import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent } from './types.ts';
import type { Persist } from './durable.ts';
/** Where leader events come from (e.g. evm LeaderWatcher). poll() may throw; progress must only advance for what it returned. */
export interface LeaderSource {
    poll(): Promise<{
        events: LeaderEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
    snapshot(): unknown;
    load(s: any): void;
}
/**
 * Glue between a leader-event source, the CopyEngine rules, and the (possibly networked) execution Engine.
 * One tick = refresh pools -> poll leaders -> apply reorgs and events -> WRITE-AHEAD checkpoint -> hand intents to the engine -> settle outcomes.
 * Durable (persistPath): copy attribution state, outbox, in-flight keys and the source cursor are one atomic file, so a crash at any point either
 * re-reads the same blocks (events dedupe by tx:logIndex) or re-submits the same idempotency keys; a trade can never be copied twice.
 * Rules on purpose: one confirmation policy and one quote token per (chain); no automatic selling on a leader reorg (positions are flagged 'orphaned').
 */
export declare class CopyRunner {
    private d;
    copy: CopyEngine;
    outbox: Intent[];
    inflight: Set<string>;
    lastError?: string;
    private backend?;
    constructor(d: {
        engine: Engine;
        chain: ChainPort;
        source: LeaderSource;
        cfgs: CopyConfig[];
        persistPath?: Persist;
        probeAmount?: bigint;
        /** Optional per-token data the chain port does not have (market cap in quote units, measured taxes). Absent fields make configured checks skip the buy. */
        info?: (chain: string, token: string) => {
            marketCap?: bigint;
            buyTaxBps?: number;
            sellTaxBps?: number;
        } | undefined;
    });
    checkpoint(): void;
    /** Price and depth from the freshest pool state. No authorised venue can quote it = zero liquidity = the copy is skipped (fail closed). */
    private market;
    tick(): Promise<{
        events: number;
        reorged: number;
        submitted: string[];
        error?: string;
    }>;
    private flushOutbox;
    /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach, settle. */
    resume(): Promise<void>;
    adopt(): void;
    /** Advance in-flight copies; attribute each outcome to the leader exactly once (the checkpoint removes it from inflight in the same write). */
    settle(): Promise<void>;
}
