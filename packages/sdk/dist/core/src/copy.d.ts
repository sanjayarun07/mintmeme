import type { Intent } from './types.ts';
export interface LeaderEvent {
    provider: string;
    chain: string;
    txHash: string;
    logIndex: number;
    leader: string;
    kind: 'swap' | 'transfer' | 'liquidity' | 'bridge' | 'airdrop';
    side: 'buy' | 'sell';
    token: string;
    quoteAmount: bigint;
    tokenAmount: bigint;
    leaderBalanceBefore: bigint;
    leaderBalanceAfter: bigint;
    leaderPriceE18: bigint;
    confirmations: number;
}
export interface CopyConfig {
    follower: string;
    walletId: string;
    userId: string;
    leader: string;
    chain: string;
    quoteToken: string;
    mode: 'fixed' | 'proportional';
    fixed: bigint;
    ratioBps: number;
    sides: 'buy' | 'sell' | 'both';
    maxPerLeader: bigint;
    maxPerToken: bigint;
    dailyLimit: bigint;
    maxPositions: number;
    cooldownS: number;
    minLiquidity: bigint;
    maxDeviationBps: number;
    allow?: string[];
    block?: string[];
    minConfirmations: number;
    followLeaderExit: boolean;
    slippageBps: number;
    venues: string[];
    /** Sell-following variant. Default: followLeaderExit ? 'full-on-exit' : 'proportional'.
     *  proportional: mirror the leader's sold fraction. full-on-exit: proportional, but 100% once the leader's balance hits zero.
     *  full-on-any-sell: close the whole attributed position on any leader sell. ignore: never mirror sells. */
    exitMode?: 'proportional' | 'full-on-exit' | 'full-on-any-sell' | 'ignore';
    /** If a proportional sell would leave less than this many attributed tokens, sell the remainder too (never more than attributed). */
    dustTokens?: bigint;
    /** "Max Buy": hard cap on ONE copied buy, in quote units. Applied after Buy % (ratioBps) so it always wins. */
    maxBuy?: bigint;
    /** "Track Only": run every rule and log what WOULD be bought or sold, but never emit an intent, reserve allocation, or touch cooldown/daily state. */
    trackOnly?: boolean;
    /** "Auto Buy Checks". Quote-unit values for market cap and liquidity; tax in bps. A configured check whose input is UNAVAILABLE skips the buy (fail closed), it never guesses. */
    checks?: {
        minMc?: bigint;
        maxMc?: bigint;
        minLiq?: bigint;
        maxLiq?: bigint;
        maxBuyTaxBps?: number;
        maxSellTaxBps?: number;
    };
    /** "Duplicate Buy": false = block a buy on a token this leader-follower pair already holds (attributed inventory or an in-flight buy). true/undefined = allow (legacy). MAESTRO_COPY_DEFAULTS sets false. */
    duplicateBuy?: boolean;
    /** "Price Impact Alert": skip a buy whose quoted impact for the intended amount exceeds this many bps (Maestro default 2000 = 20%). Slippage is never raised to compensate. Unquotable = skip. */
    priceImpactAlertBps?: number;
    /** Tokens (stablecoins) whose leader trades are never copied, buy or sell ("Copy Sell filters out stablecoin transactions"). */
    stablecoins?: string[];
}
/** Maestro's documented defaults for the settings above, for callers that want parity; spread into a config: `{ ...cfg, ...MAESTRO_COPY_DEFAULTS }`.
 *  Not applied automatically: existing callers keep their legacy behaviour. */
export declare const MAESTRO_COPY_DEFAULTS: {
    readonly duplicateBuy: false;
    readonly priceImpactAlertBps: 2000;
};
/** Documented ceilings: Buy % up to 1000% (ratioBps 100_000). */
export declare const MAX_BUY_PCT_BPS = 100000;
export declare function validateCopyConfig(c: CopyConfig): void;
/** Confirmation policy presets. fast = act on 0 confirmations (lowest latency, exposed to leader-tx reorg/drop: positions may become 'orphaned').
 *  safe = wait N confirmations (reorg-resistant, but later entry/exit and worse price). */
export declare const CONFIRMATION_PRESETS: {
    readonly fast: {
        readonly minConfirmations: 0;
        readonly tradeoff: 'fast: 0 conf, reorg risk';
    };
    readonly safe: (n?: number) => {
        minConfirmations: number;
        tradeoff: string;
    };
};
export declare function withConfirmationPolicy(c: CopyConfig, preset: 'fast' | 'safe', n?: number): CopyConfig;
export type PositionStatus = 'none' | 'open' | 'orphaned';
interface FillRec {
    k: string;
    token: string;
    side: 'buy' | 'sell';
    tokens: bigint;
    quote: bigint;
    signal: string;
    reversed: boolean;
}
/** Optional fields are data the source may not have; a configured check on a missing field skips the buy. */
export interface Market {
    priceE18: bigint;
    liquidity: bigint;
    marketCap?: bigint;
    buyTaxBps?: number;
    sellTaxBps?: number;
    impactBps?: (amountQuote: bigint) => number | undefined;
}
export declare class CopyEngine {
    private cfgs;
    private market;
    private run;
    private now;
    private seen;
    private revoked;
    /** attributed inventory: `${follower}|${leader}|${token}` -> tokens bought because of that leader */
    inv: Map<string, bigint>;
    /** cost basis (quote units) of currently attributed inventory; reduced proportionally on sells. Per-leader cap is NET of this. */
    costBasis: Map<string, bigint>;
    /** buys emitted but not yet filled (counted against caps so in-flight orders cannot oversubscribe) */
    private pending;
    private intents;
    private fills;
    private flags;
    private last;
    private daily;
    log: {
        id: string;
        decision: string;
    }[];
    constructor(cfgs: CopyConfig[], market: (chain: string, token: string) => Market, run: (i: Intent) => void, now: () => number);
    onReorg(chain: string, txHash: string): void;
    /** Leader signal tx reorged. Pending signals are revoked (above); fills already recorded from it are reversed out of attributed
     *  inventory and the position is flagged 'orphaned'. The tokens are still in the wallet: NO automatic sell is issued. */
    recordReorg(chain: string, txHash: string): string[];
    positionStatus(f: string, l: string, t: string): PositionStatus;
    orphanReason(f: string, l: string, t: string): string | undefined;
    /** Net exposure: cost basis of attributed inventory plus in-flight buys. */
    exposure(f: string, l: string, tok?: string | null): bigint;
    /** Auto Buy Checks. Returns a skip reason, or undefined when every configured check passes. */
    private checkBuy;
    private skip;
    attributed(f: string, l: string, t: string): bigint;
    onEvent(e: LeaderEvent): void;
    private handle;
    private emit;
    /** Call with confirmed fill only: attributes inventory to the leader. `signal` (chain:txHash:logIndex) enables reorg reversal.
     *  Buy: inventory += tokens, cost basis += quoteSpent. Sell: tokens clamped to attributed inventory, cost basis reduced proportionally. */
    recordFill(c: CopyConfig, token: string, side: 'buy' | 'sell', tokens: bigint, quoteSpent: bigint, signal?: string, intentKey?: string): void;
    /** Failed/expired buy: release its in-flight reservation. */
    recordFailure(intentKey: string): void;
    /** Plain-data copy of ALL mutable state (bigints preserved; serialise with rep/rev). Used for durable persistence. */
    snapshot(): {
        seen: string[];
        revoked: string[];
        inv: [string, bigint][];
        costBasis: [string, bigint][];
        pending: [string, bigint][];
        intents: [string, {
            c: CopyConfig;
            token: string;
            side: 'buy' | 'sell';
            amt: bigint;
            signal: string;
        }][];
        fills: FillRec[];
        flags: [string, string][];
        last: [string, number][];
        daily: [string, bigint][];
        log: {
            id: string;
            decision: string;
        }[];
    };
    load(s: ReturnType<CopyEngine['snapshot']>): void;
    /** Config an emitted intent was created under (so a runner can attribute its outcome after a restart). */
    intentInfo(key: string): {
        c: CopyConfig;
        token: string;
        side: 'buy' | 'sell';
        amt: bigint;
        signal: string;
    } | undefined;
}
export {};
