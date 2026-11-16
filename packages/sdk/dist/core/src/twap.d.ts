import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent } from './types.ts';
import type { Persist } from './durable.ts';
/** TWAP ORDER (time-weighted average price): buy or sell one token from ONE wallet in `slices` equal parts, one part every `intervalS` seconds, so a large order does not move the pool
 *  in one go. Each slice is an ordinary Engine intent (own policy check, nonce, idempotency key `twap:<id>:<n>`), so a restart can never send a slice twice.
 *  What this is NOT: a guarantee of the average price. A TWAP spreads the timing; it does not promise a price. Slices go out one at a time (each is quoted after the previous one has settled),
 *  and a slice that cannot go within its window (price beyond your limit, too much impact, thin liquidity, node down) is SKIPPED and reported, never silently made up later. */
export declare const MAX_TWAP_SLICES = 100;
export interface TwapSpec {
    /** Unique per TWAP order. Slice keys are `twap:<id>:<n>`, so submitting the same id again can never trade a slice twice. */
    id: string;
    userId: string;
    walletId: string;
    chain: string;
    token: string;
    quoteToken: string;
    venues: string[];
    side: 'buy' | 'sell';
    /** buy: quote-token budget for the whole order. sell: token amount for the whole order. */
    total: bigint;
    slices: number;
    intervalS: number;
    /** Chain time (seconds) of the first slice. Default: the time of the first tick. */
    startAt?: number;
    /** How long after its due time a slice may still go. Past that it is skipped. Default: one interval. */
    windowS?: number;
    slippageBps: number;
    deadlineS?: number;
    maxFeeBps?: number;
    /** quote units per token, x1e18 (same unit as price orders). buy: a slice waits while the pool price is ABOVE this. sell: waits while it is BELOW. */
    limitPriceE18?: bigint;
    /** A slice waits while selling/buying it would move the best pool's price by more than this. */
    maxSliceImpactBps?: number;
    /** Randomize each slice's time by up to +/- this percent of half an interval, so the schedule is not a metronome. Fixed per order id (the same order always has the same schedule). 0..50. */
    jitterPct?: number;
    /** 'continue' (default): a failed slice does not stop the rest. 'stop': after the first failed slice the unsent ones are skipped. */
    onFailure?: 'continue' | 'stop';
    /** Lower the slice ceiling below 100 (a plan limit). */
    maxSlices?: number;
}
export declare function validateTwap(s: TwapSpec): void;
/** Split `total` into `n` parts that sum exactly; the remainder (one unit each) goes to the first slices. */
export declare function splitSlices(total: bigint, n: number): bigint[];
/** Due time of every slice. Slice 0 never goes before `startAt`; jitter is at most a quarter interval each way, so slices always stay in order. */
export declare function twapSchedule(s: Pick<TwapSpec, 'id' | 'slices' | 'intervalS' | 'jitterPct'>, startAt: number): number[];
export type SliceStatus = 'pending' | 'inflight' | 'filled' | 'failed' | 'skipped';
export interface SliceState {
    n: number;
    key: string;
    amount: bigint;
    dueAt: number;
    status: SliceStatus;
    reason?: string;
    waiting?: string;
    spent?: bigint;
    received?: bigint;
}
export interface TwapSummary {
    id: string;
    side: 'buy' | 'sell';
    slices: SliceState[];
    filled: number;
    failed: number;
    skipped: number;
    open: number;
    spent: bigint;
    received: bigint;
    avgPriceE18?: bigint;
    nextDueAt?: number;
    done: boolean;
    cancelled: boolean;
    refused?: string;
}
/** Durable like the other runners: a write-ahead checkpoint of the slice table, outbox and in-flight keys, so a crash re-submits the same idempotency keys and never trades a slice twice. */
export declare class TwapRunner {
    private d;
    slices: SliceState[];
    outbox: Intent[];
    inflight: Set<string>;
    planned: boolean;
    cancelled: boolean;
    startAt?: number;
    refused?: string;
    lastError?: string;
    private backend?;
    constructor(d: {
        engine: Engine;
        chain: ChainPort;
        spec: TwapSpec;
        persistPath?: Persist;
    });
    get spec(): TwapSpec;
    checkpoint(): void;
    private slice;
    private get tin();
    private get tout();
    /** Stop the schedule: slices not yet sent are skipped. A slice already in flight finishes (it is on the chain or about to be). */
    cancel(): void;
    /** Once: the wallet must hold the WHOLE amount now, and the schedule is fixed. Nothing is sent here. */
    private preflight;
    /** Best authorized venue for this slice: the one that pays the most. Undefined (with a reason) when none can quote. */
    private best;
    tick(): Promise<{
        submitted: string[];
        error?: string;
    }>;
    /** Decide the next slice that is due: skip ones whose window has passed, hold ones the limits block, send the first that is clear. */
    private next;
    private flushOutbox;
    /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach to engine records, settle. */
    resume(): Promise<void>;
    settle(): Promise<void>;
    summary(): TwapSummary;
}
