import type { Intent } from './types.ts';
import type { SimChain } from './simchain.ts';
/** The part of a chain the Sniper reads (sync). SimChain satisfies it; a networked chain supplies a snapshot adapter. */
export interface SnipeView {
    block: number;
    time: number;
    balance(w: string, t: string): bigint;
    tokens: Pick<SimChain['tokens'], 'get'>;
    state: {
        venues: Map<string, import('./types.ts').Venue>;
    };
}
import type { TokenFacts, RiskReport } from './risk.ts';
import type { Order } from './orders.ts';
/** LAUNCH SNIPING (bounded, eligibility-respecting).
 *  Design rules enforced here:
 *   - participates only once trading is enabled (chain tokenBehavior.tradingOpenBlock reached AND any trading-enabled event openBlock reached); never tries to bypass restrictions
 *   - at most `maxAttempts` buys, at most one in flight, at most one per block, total committed spend never exceeds maxSpend, slippage never widened
 *   - no mempool inspection / no front- or back-running / no sandwich logic: decisions use only confirmed launch events and current chain state
 *   - runs the risk analyzer (buy+sell simulation) as a pre-trade check; a passing check is NOT a safety certification */
export type LaunchEventType = 'pool-created' | 'liquidity-added' | 'trading-enabled' | 'curve-created' | 'graduated';
export interface LaunchEvent {
    type: LaunchEventType;
    chain: string;
    token: string;
    txHash: string;
    logIndex: number;
    block: number;
    venueId?: string;
    quoteLiquidity?: bigint;
    openBlock?: number;
    successor?: string;
}
export interface Launch {
    key: string;
    chain: string;
    token: string;
    kind: 'pool' | 'curve' | 'unknown';
    venueId?: string;
    venueHistory: string[];
    status: 'detected' | 'tradable' | 'graduated' | 'revoked';
    eventLiquidity: bigint;
    tradingOpenBlock?: number;
    tradingEnabledSeen: boolean;
    detectedBlock: number;
    tradableSinceBlock?: number;
    graduatedTo?: string;
    events: LaunchEvent[];
}
export declare class LaunchDetector {
    private opts;
    private evs;
    private seen;
    private revokedTx;
    log: {
        id: string;
        decision: string;
    }[];
    constructor(opts?: {
        requireTradingEnabledEvent?: boolean;
    });
    snapshot(): {
        evs: [string, LaunchEvent[]][];
        seen: string[];
        revokedTx: string[];
        log: {
            id: string;
            decision: string;
        }[];
    };
    load(s: ReturnType<LaunchDetector['snapshot']>): void;
    /** Idempotent: duplicates (same chain/tx/log/type, any provider) and events from revoked txs are ignored. Returns the updated launch, or undefined if ignored. */
    onEvent(e: LaunchEvent): Launch | undefined;
    /** Reorg: every event of this tx is revoked and launch state is recomputed from the surviving events. */
    revoke(chain: string, txHash: string): Launch[];
    /** Every launch the detector knows (one per chain+token). */
    launches(): Launch[];
    get(chain: string, token: string): Launch | undefined;
    private setVenue;
}
/** Carry open orders over a graduation: same order ids, same reservations, same token; only the venue allow-list gains the successor. */
export declare function migrateOrders(orders: Iterable<Order>, token: string, fromVenue: string, toVenue: string): string[];
export interface ExitRules {
    takeProfitBps?: number;
    stopLossBps?: number;
    trailingStopBps?: number;
    ttlS?: number;
    minLiquidity?: bigint;
    maxDeviationBps?: number;
    maxQuoteAgeMs?: number;
    maxAttempts?: number;
}
export interface SnipeConfig {
    userId: string;
    walletId: string;
    chain: string;
    quoteToken: string;
    venues: string[];
    maxSpend: bigint;
    delayBlocks: number;
    minLiquidity: bigint;
    maxLiquidity?: bigint;
    maxValuation?: bigint;
    totalSupply?: bigint;
    maxTaxBps: number;
    maxAttempts: number;
    slippageBps: number;
    maxSlippageBps?: number;
    maxFeeBps?: number;
    deadlineS?: number;
    rejectVerdicts?: RiskReport['verdict'][];
    blockedTokens?: string[];
    exit?: ExitRules;
    /** Pre-trade risk check. Default: simulated buy+sell through a SimChain. A networked chain MUST supply one (its report may say what it could not check). */
    riskCheck?: (launch: Launch, amount: bigint, facts: TokenFacts) => RiskReport;
}
export interface SnipeLimits {
    maxWalletTokens?: bigint;
}
export interface SnipeAttempt {
    n: number;
    key: string;
    amount: bigint;
    block: number;
    status: 'inflight' | 'filled' | 'failed';
}
export interface SnipeState {
    attempts: SnipeAttempt[];
    committed: bigint;
    filledSpend: bigint;
    filledTokens: bigint;
    done: boolean;
}
export type SnipeDecision = {
    ok: true;
    intent: Intent;
    attempt: number;
    risk: RiskReport;
    block: number;
} | {
    ok: false;
    reason: string;
    code: string;
    risk?: RiskReport;
    block: number;
};
export declare class Sniper {
    chain: SnipeView;
    cfg: SnipeConfig;
    states: Map<string, SnipeState>;
    constructor(chain: SnipeView, cfg: SnipeConfig);
    snapshot(): {
        states: [string, SnipeState][];
    };
    load(s: ReturnType<Sniper['snapshot']>): void;
    state(key: string): SnipeState;
    /** Decide whether to buy now. Returns an Intent (and records the attempt as in flight) or a rejection reason. Pure w.r.t. the chain (simulation only). */
    decide(launch: Launch | undefined, facts: TokenFacts, limits?: SnipeLimits): SnipeDecision;
    /** Execution outcome. Failure releases the committed budget (a reverted buy spends only gas) but the ATTEMPT stays counted. */
    report(launchKey: string, idempotencyKey: string, res: {
        ok: true;
        tokens: bigint;
        spent: bigint;
    } | {
        ok: false;
    }): void;
}
/** Post-buy exits as OrderManager-compatible descriptors (caller passes them to OrderManager.place). TP and SL share an OCO group => one reservation, one leg fires. */
export declare function exitOrders(cfg: SnipeConfig, launch: Pick<Launch, 'key' | 'token'>, fill: {
    tokens: bigint;
    quoteSpent: bigint;
}, nowS: number): Order[];
export interface LaunchSimulation {
    token: string;
    venue: string;
    block: number;
    time: number;
    tradingOpenBlock?: number;
    restrictedBlocksRemaining: number;
    buy: {
        feasible: boolean;
        reason?: string;
        tokensOut?: bigint;
        taxBps?: number;
        priceImpactBps?: number;
    };
    sell: {
        feasible: boolean;
        reason?: string;
        quoteOut?: bigint;
        taxBps?: number;
    };
    maxTxAmount?: bigint;
    maxTxBlocksExit?: boolean;
    limitations: string[];
}
/** Dry-run of a buy and the round-trip sell on a throwaway wallet, at the current chain state. Reports taxes (from balance deltas), max tx limit and restricted blocks. */
export declare function simulateLaunch(chain: SimChain, p: {
    token: string;
    venue: string;
    quoteToken?: string;
    amount: bigint;
}): LaunchSimulation;
