import { LaunchDetector, Sniper } from './snipe.ts';
import type { LaunchEvent, SnipeConfig, Launch } from './snipe.ts';
import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { OrderRunner } from './orderrunner.ts';
import type { Intent } from './types.ts';
import type { RiskReport } from './risk.ts';
import type { Persist } from './durable.ts';
export interface LaunchSource {
    poll(): Promise<{
        events: LaunchEvent[];
        reorged: {
            chain: string;
            txHash: string;
        }[];
    }>;
    snapshot(): unknown;
    load(s: any): void;
    /** token -> pool info, so the chain can load the new pool */
    pairs: Map<string, {
        pair: string;
    }>;
}
/** The honest risk report for a networked chain: it states what was NOT checked. Taxes are measured only AFTER the buy (fill shortfall). */
export declare const unverifiedRisk: (launch: Launch, block: number, now: number) => RiskReport;
/**
 * Launch sniping on a networked chain: LaunchSource -> LaunchDetector -> eligibility (a dry-run of the REAL buy must succeed; a revert such as "trading not enabled"
 * is waited out, never bypassed, and costs no attempt) -> Sniper limits (budget, attempts, delay, liquidity, valuation) -> Engine -> exits through OrderRunner.
 * Durable like the other runners: write-ahead checkpoint of detector, sniper, outbox, in-flight keys and the source cursor; exits are placed idempotently.
 * No mempool, no front-running: it acts only on MINED launch events and current pool state, so it is always after the launch tx.
 */
export declare class SnipeRunner {
    private d;
    detector: LaunchDetector;
    sniper: Sniper;
    outbox: Intent[];
    inflight: Set<string>;
    /** why each launch was not bought (last evaluation) and what each filled attempt measured */
    status: Map<string, string>;
    private pools;
    results: Map<string, {
        tokens: bigint;
        spent: bigint;
        buyTaxBps: number;
    }>;
    /** launches that FILLED but whose exit orders could not be placed (position is open without exits: needs the user's attention) */
    exitErrors: Map<string, string>;
    lastError?: string;
    private backend?;
    constructor(d: {
        engine: Engine;
        chain: ChainPort & {
            addPool?(p: {
                id: string;
                pair: string;
            }): void;
            removePool?(id: string): void;
        };
        source: LaunchSource;
        cfg: SnipeConfig;
        orders?: OrderRunner;
        persistPath?: Persist;
        /** Optional async fetch of per-launch facts the synchronous riskCheck needs (e.g. a Solana mint account). A throw skips this launch for this tick; nothing is bought on unknown facts. */
        inspect?: (l: Launch) => Promise<void>;
    });
    checkpoint(): void;
    private launchKeyOf;
    tick(): Promise<{
        events: number;
        submitted: string[];
        error?: string;
    }>;
    private flushOutbox;
    resume(): Promise<void>;
    adopt(): void;
    settle(): Promise<void>;
}
