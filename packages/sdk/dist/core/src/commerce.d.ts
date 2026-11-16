import { Ledger } from './ledger.ts';
import type { Referral } from './ledger.ts';
export type LimitKind = 'walletsPerChain' | 'monitors' | 'copyWallets' | 'snipes' | 'limitOrders';
export interface TierDef {
    id: string;
    priceUnits: bigint;
    limits: Record<LimitKind, number>;
}
export interface TierConfig {
    tiers: Record<string, TierDef>;
    freeTier: string;
    periodMs: number;
    asset: string;
}
export declare const DAY_MS = 86400000;
export declare function defaultTierConfig(): TierConfig;
export interface Decision {
    allow: boolean;
    reason?: string;
}
export declare function enforce(cfg: TierConfig, tier: string, kind: LimitKind, currentCount: number): Decision;
interface Payment {
    id: string;
    user: string;
    tier: string;
    at: number;
    price: bigint;
    asset: string;
    refunded: boolean;
}
/** Subscription state is derived by replaying non-refunded payments, so refund/renewal ordering cannot corrupt it. */
export declare class Subscriptions {
    l: Ledger;
    cfg: TierConfig;
    payments: Payment[];
    constructor(l: Ledger, cfg: TierConfig);
    /** Purchase or renew. Idempotent per paymentId. A renewal while active extends from the current expiry. */
    purchase(paymentId: string, user: string, tier: string, now: number): boolean;
    /** Refund reverses the ledger posting and removes the paid period (idempotent). */
    refund(paymentId: string): boolean;
    private state;
    expiresAt(user: string): number;
    /** Effective tier at `now`; falls back to free after expiry. */
    tierOf(user: string, now: number): string;
    enforce(user: string, kind: LimitKind, currentCount: number, now: number): Decision;
}
export type FeeMode = 'in-tx' | 'accrued-then-swept';
export interface ChainFee {
    mode: FeeMode;
    sweepMin: bigint; /** bps by tier; `default` used when a tier is missing */
    bps: Record<string, number> & {
        default: number;
    };
}
export interface FeeSchedule {
    chains: Record<string, ChainFee>;
}
export declare function feeBps(s: FeeSchedule, chain: string, tier: string): number;
export declare class FeeCollector {
    l: Ledger;
    sched: FeeSchedule;
    sweeps: Map<string, bigint>;
    constructor(l: Ledger, sched: FeeSchedule);
    /** Computes and books the fee for a trade. in-tx: straight to revenue. accrued: held in fees:accrued:<chain> until swept. Returns the fee. */
    charge(tradeId: string, chain: string, user: string, tier: string, notional: bigint, asset: string): bigint;
    /** Reorg: undo a fee booking. If already swept the accrued account goes negative (a visible clawback, never silent). */
    reverseCharge(tradeId: string): boolean;
    /** Move accrued fees to revenue. Debits exactly once per sweepId; below per-chain minimum nothing happens and the id stays usable. */
    sweep(sweepId: string, chain: string, asset: string): {
        swept: bigint;
        reason?: string;
    };
}
export interface ReferralConfig {
    commissionBps: number; /** share (bps of commission) that goes to the token-link referrer when the user is already referred */
    tokenSplitBps: number;
}
export declare class ReferralBook {
    cfg: ReferralConfig;
    private sticky;
    private tokenLinks;
    constructor(cfg: ReferralConfig);
    /** First valid referrer wins and is immutable. Invalid: self, or a cycle (referrer is already downstream of user). Token links on an already-referred user only add a per-token split. */
    attribute(user: string, referrer: string, token?: string): 'sticky' | 'token-split' | 'ignored';
    private wouldCycle;
    referrerOf(user: string): string | undefined;
    /** Referrals to pass to accrue() for a trade in `token`: the original referrer, split with the token-link referrer if one exists. */
    referralsFor(user: string, token?: string): Referral[];
}
/** Reorg: reverse a trade's accrual (commission, cashback, revenue). */
export declare function reverseAccrual(l: Ledger, tradeId: string): boolean;
export interface Campaign {
    id: string;
    boostBps: number;
    start: number;
    end: number;
    tokens?: string[];
}
/** Base cashback plus the single largest active boost (boosts do not stack), capped. */
export declare function effectiveCashbackBps(base: number, campaigns: Campaign[], now: number, token: string | undefined, capBps?: number): number;
export interface CompetitionCfg {
    id: string;
    start: number;
    end: number;
    asset: string;
    minTradeNotional: bigint;
    perUserTokenCap: bigint;
    prizes: bigint[];
}
export interface CompTrade {
    id: string;
    user: string;
    token: string;
    notional: bigint;
    t: number;
    confirmed: boolean;
    flagged: boolean;
    source: 'platform' | 'venue';
}
/** Leaderboard by OUR platform volume only. Volume is credited solely from recorded, confirmed, unflagged platform trades; nothing is ever synthesized. */
export declare class Competition {
    l: Ledger;
    cfg: CompetitionCfg;
    private credited;
    private paid;
    constructor(l: Ledger, cfg: CompetitionCfg);
    record(t: CompTrade): {
        counted: bigint;
        reason?: string;
    };
    /** Reorg: remove a trade's volume. Not allowed after prizes were paid. */
    reverse(tradeId: string): boolean;
    private userToken;
    volume(user: string): bigint;
    /** Volume desc; ties broken by user id ascending (deterministic, input-order independent). */
    leaderboard(): {
        user: string;
        volume: bigint;
        rank: number;
    }[];
    /** Pay prizes from the prize pool into reward balances; one payout per rank, idempotent. Requires the window to have ended. */
    payPrizes(now: number): number;
}
export {};
