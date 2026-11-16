export interface Entry {
    id: string;
    key: string;
    account: string;
    amount: bigint;
    asset: string;
    ref: string;
    reverses?: string;
}
/** Append-only double-entry ledger; every posting set balances to zero per asset; idempotent by key. */
export interface AbuseRecord {
    tradeId: string;
    user: string;
    fee: bigint;
    asset: string;
    reasons: string[];
}
export declare class Ledger {
    entries: Entry[];
    audit: AbuseRecord[];
    private keys;
    private claims;
    private n;
    post(key: string, ref: string, asset: string, legs: [string, bigint][]): boolean;
    reverse(key: string): boolean;
    balance(account: string, asset: string): bigint;
    /** Claim payout from a rewards balance exactly once per claim id. */
    claim(claimId: string, user: string, asset: string, amount: bigint): boolean;
    /** Has this trade been flagged as abusive (self-referral / wash)? */
    isFlagged(tradeId: string): boolean;
    /** Sum of every entry for an asset; must always be 0n. */
    total(asset: string): bigint;
}
export interface TradeFact {
    id: string;
    user: string;
    wallet: string;
    platformFee: bigint;
    asset: string;
    confirmed: boolean;
    ownerOfWallets: (w: string) => string;
}
export interface Referral {
    referrer: string;
    commissionBps: number;
}
export interface AbuseFlags {
    selfReferral: boolean; /** result of washFlag for this trade, supplied explicitly by the caller */
    wash?: boolean;
}
export type AccrueResult = 'unconfirmed' | 'accrued' | 'flagged' | 'duplicate';
/**
 * Accrue from CONFIRMED activity only. Split platform fee: referrer commission(s) + user cashback + revenue.
 * Flagged trades (selfReferral/wash passed explicitly) accrue no commission/cashback; the fee is parked in
 * `abuse:flagged` and an audit record is appended. `ref` may be several referrers (split attribution).
 */
export declare function accrue(l: Ledger, t: TradeFact, ref: Referral | Referral[] | undefined, cashbackBps: number, flags: AbuseFlags): AccrueResult;
/** Abuse heuristics: self-referral = referrer controls the traded wallet's owner (or same user). */
export declare function isSelfReferral(user: string, referrer: string, sharedDeviceOrWallet: boolean): boolean;
export interface WashTrade {
    id?: string;
    wallet: string;
    counterparty?: string;
    side: 'buy' | 'sell';
    token: string;
    t: number;
}
export interface WashOpts {
    ownerOf?: (w: string) => string | undefined; /** wallet -> linked-cluster id (funding links, shared device...) */
    clusterOf?: (w: string) => string | undefined;
}
/** Indices of trades that are one leg of a round trip: opposite side, same token, within window, between wallets that are
 *  the same wallet, share an owner, share a cluster, or name each other as counterparty. */
export declare function washIndices(trades: WashTrade[], windowS?: number, o?: WashOpts): Set<number>;
export declare function washFlag(trades: WashTrade[], windowS?: number, o?: WashOpts): boolean;
