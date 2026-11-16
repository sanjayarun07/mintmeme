/**
 * Alerts, community bot decision logic, and trending. Pure logic: no network, no clock (callers pass time).
 * Delivery is injected; nothing here posts anywhere except through an explicit, authorization-gated sink.
 */
export declare class Watchlists {
    maxPerUser: number;
    private m;
    constructor(maxPerUser?: number);
    add(userId: string, tokenKey: string): boolean;
    remove(userId: string, tokenKey: string): boolean;
    list(userId: string): string[];
    watchers(tokenKey: string): string[];
}
export interface PriceAlertSpec {
    id: string;
    userId: string;
    token: string;
    direction: 'above' | 'below';
    threshold: number;
    oneShot?: boolean;
    hysteresisBps?: number;
}
export interface PriceAlertFire {
    alertId: string;
    userId: string;
    token: string;
    direction: 'above' | 'below';
    threshold: number;
    price: number;
    tickId: string;
}
interface PA extends PriceAlertSpec {
    armed: boolean;
    active: boolean;
}
/** Fires on cross. One-shot by default. Repeating alerts re-arm only after price retreats past threshold by hysteresis (no flapping). */
export declare class PriceAlerts {
    private alerts;
    private seenTicks;
    add(spec: PriceAlertSpec): boolean;
    cancel(id: string): boolean;
    evaluate(token: string, price: number, tickId: string): PriceAlertFire[];
    isActive(id: string): boolean;
    /** Durable state: every alert with whether it is armed and active, so a restart neither re-fires a one-shot alert nor forgets a live one. */
    snapshot(): PA[];
    load(list: PA[]): void;
}
export type ActivityKind = 'swap' | 'transfer' | 'bridge' | 'airdrop';
export interface Leg {
    token: string;
    delta: bigint;
}
export interface ChainEvent {
    chain: string;
    txHash: string;
    logIndex: number;
    blockHash: string;
    blockNumber: number;
    wallet: string;
    legs: Leg[];
    valueUsd: number;
    counterpartyIsBridge?: boolean;
    fromKnownDistributor?: boolean;
}
export declare const eventKey: (e: Pick<ChainEvent, 'chain' | 'txHash' | 'logIndex'>) => string;
export declare function classify(e: ChainEvent): ActivityKind;
export interface WalletAlert {
    type: 'activity';
    key: string;
    wallet: string;
    kind: ActivityKind;
    whale: boolean;
    valueUsd: number;
    blockHash: string;
}
export interface WalletRevoke {
    type: 'revoke';
    key: string;
    wallet: string;
    reason: 'reorg';
}
export declare class WalletAlerts {
    cfg: {
        minValueUsd: number;
        whaleUsd: number;
    };
    private watched;
    private sent;
    constructor(cfg: {
        minValueUsd: number;
        whaleUsd: number;
    });
    watch(wallet: string, minValueUsd?: number): void;
    unwatch(wallet: string): void;
    /** Dedupe by chain:tx:logIndex. A key revoked by reorg may alert again when re-included. */
    ingest(e: ChainEvent): WalletAlert | null;
    /** Reorg: block removed. Emit revocations for every alert sent from it and forget their dedupe keys. */
    revokeBlock(chain: string, blockHash: string): WalletRevoke[];
}
export interface GroupAuthorization {
    groupId: string;
    authorizedBy: string;
    authorizedAt: number;
    evidence: string;
}
export interface TradeNotice {
    eventKey: string;
    token: string;
    side: 'buy' | 'sell';
    valueUsd: number;
    wallet?: string;
    ts: number;
}
export type BotDecision = {
    post: true;
    text: string;
} | {
    post: false;
    reason: string;
};
/** Posts ONLY to groups with an explicit authorization record. No auth => never posts, regardless of other config. */
export declare class CommunityBot {
    private o;
    private auth;
    private cfg;
    private posts;
    private seen;
    constructor(o: {
        maxPerWindow: number;
        windowS: number;
        sink?: (groupId: string, text: string) => void;
    });
    authorize(a: GroupAuthorization, cfg: {
        minBuyUsd: number;
        postSells?: boolean;
    }): boolean;
    revoke(groupId: string): void;
    isAuthorized(groupId: string): boolean;
    notify(groupId: string, n: TradeNotice, now: number): BotDecision;
}
export interface TrendTrade {
    eventKey: string;
    token: string;
    wallet: string;
    side: 'buy' | 'sell';
    valueUsd: number;
    ts: number;
}
export interface TrendCfg {
    halfLifeS: number;
    perWalletCapUsd: number;
    roundTripWindowS: number;
    minLiquidityUsd: number;
    k: number;
    windowS: number;
}
export interface TrendRow {
    token: string;
    score: number;
    uniqueWallets: number;
    volumeUsd: number;
}
export declare class Trending {
    private cfg;
    private trades;
    private keys;
    private liq;
    constructor(cfg: TrendCfg);
    setLiquidity(token: string, usd: number): void;
    ingest(t: TrendTrade): boolean;
    /** Wallets that bought AND sold the same token within roundTripWindow are treated as wash and excluded for that token. */
    private washWallets;
    private rows;
    /** Internal ranking (still no per-user data). */
    rank(now: number): TrendRow[];
    /** Public aggregate: tokens with fewer than k distinct contributing wallets are omitted entirely; no wallet ids, no per-user rows. */
    publicAggregate(now: number): {
        token: string;
        score: number;
        uniqueWallets: number;
    }[];
}
export {};
