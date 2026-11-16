import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent } from './types.ts';
import type { Persist } from './durable.ts';
/** BULK BUY and BULK SELL (Maestro "Multi-Wallet": buy the same token from several of your wallets at once). One request, up to 10 wallets, each leg an ordinary Engine intent from ITS OWN wallet,
 *  so every wallet keeps its own policy, limits, nonce and idempotency. What this is NOT: an atomic basket. Legs are independent transactions; any can fail while others land, and the
 *  report says exactly which. The legs trade the same pool one after another, so each moves the price for the next: `maxImpactBps` bounds the price impact of the WHOLE amount up front
 *  (each leg's own slippage guard only protects against price movement since that leg was quoted, not against the earlier legs moving it). */
export declare const MAX_BULK_WALLETS = 10;
export interface BulkLeg {
    walletId: string;
    amount: bigint;
}
export interface BulkSpec {
    /** Unique per bulk buy. Leg keys are `bulk:<id>:<walletId>`, so submitting the same id again can never buy twice. */
    id: string;
    userId: string;
    chain: string;
    token: string;
    quoteToken: string;
    venues: string[];
    /** 'buy' (default): each leg spends `amount` of the quote token to buy `token`. 'sell': each leg sells `amount` of `token` for the quote token (amount is in TOKEN units). */
    side?: 'buy' | 'sell';
    legs: BulkLeg[];
    slippageBps: number;
    deadlineS?: number;
    maxFeeBps?: number;
    /** Hard cap on the sum of all legs (quote units). */
    maxTotal?: bigint;
    /** Refuse the whole bulk buy when buying the TOTAL from the best authorized pool would move its price by more than this. Unquotable = refuse. */
    maxImpactBps?: number;
    /** 'continue' (default): a failed leg does not stop the others. 'stop': after the first failed leg the unsent legs are skipped. */
    onFailure?: 'continue' | 'stop';
    /** 'sequential' (default): one leg at a time; the pool is refreshed and the previous leg has settled before the next is quoted, so every leg is priced on the pool as the earlier legs left it.
     *  'parallel': all legs are quoted from the SAME pool state and land one after another, each moving the price: later legs can revert on their own minimum output (nothing is spent when they do).
     *  Parallel is faster and is what a many-wallet launch buy wants; it is explicit because it fails legs by design when the total moves the pool more than the slippage. */
    mode?: 'sequential' | 'parallel';
    /** Legs handed to the engine per tick (stagger; parallel mode). Default: all of them. */
    perTick?: number;
    /** Lower the wallet ceiling below 10 (a plan limit). */
    maxWallets?: number;
}
export declare function validateBulk(s: BulkSpec): void;
/** Split `total` equally; the remainder (one unit each) goes to the first wallets so the legs sum to exactly `total`. */
export declare function splitEqual(wallets: string[], total: bigint): BulkLeg[];
/** Each wallet spends `pctBps` of its own balance (10_000 = all of it). Wallets with a zero result are left out. */
export declare function splitByBalance(balances: Map<string, bigint>, pctBps: number): BulkLeg[];
export type LegStatus = 'pending' | 'inflight' | 'filled' | 'failed' | 'skipped';
export interface LegState {
    walletId: string;
    amount: bigint;
    key: string;
    status: LegStatus;
    reason?: string;
    spent?: bigint;
    received?: bigint;
}
export interface BulkSummary {
    id: string;
    legs: LegState[];
    filled: number;
    failed: number;
    skipped: number;
    open: number;
    spent: bigint;
    received: bigint;
    done: boolean;
    refused?: string;
}
/** Durable like the other runners: a write-ahead checkpoint of the leg table, outbox and in-flight keys, so a crash re-submits the same idempotency keys and never buys a wallet twice. */
export declare class BulkRunner {
    private d;
    legs: LegState[];
    outbox: Intent[];
    inflight: Set<string>;
    planned: boolean;
    refused?: string;
    lastError?: string;
    private backend?;
    constructor(d: {
        engine: Engine;
        chain: ChainPort;
        spec: BulkSpec;
        persistPath?: Persist;
    });
    get spec(): BulkSpec;
    checkpoint(): void;
    private leg;
    /** Once: check every wallet can fund its leg, and that the whole amount stays within the impact limit. Nothing is sent here. */
    private preflight;
    tick(): Promise<{
        submitted: string[];
        error?: string;
    }>;
    private flushOutbox;
    /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach to engine records, settle. */
    resume(): Promise<void>;
    settle(): Promise<void>;
    /** Run ticks until every leg is settled (or `maxTicks`). Convenience for callers that do not drive their own loop. */
    run(opts?: {
        maxTicks?: number;
        waitMs?: number;
    }): Promise<BulkSummary>;
    summary(): BulkSummary;
}
