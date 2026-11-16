import type { Fill, TxState } from './types.ts';
/**
 * Portfolio accounting from CONFIRMED fills only. State is a pure fold over an append-only event log, so a
 * reorg-revoked trade (revokeTrade) simply drops out and everything is recomputed.
 *
 * Policies (deliberate, documented):
 *  - Positions are keyed by user|chain|token identity. Venue is attribute of a trade, never part of the key, so a curve->pool
 *    migration keeps balance, cost basis and history.
 *  - Positions exist only for non-quote tokens. Quote tokens (default [NATIVE]) are the cost currency.
 *  - Cost basis = average cost over KNOWN lots, from our own fills (spent incl. platform fee; network fee is reported separately)
 *    or from a user-supplied basis carrying a provenance label. Anything else (transfer/airdrop, foreign quote token,
 *    token<->token swap) is UNKNOWN and stays unknown; it is never guessed.
 *  - Sells/transfers-out consume known and unknown quantity pro-rata; realized P&L covers only the known part.
 *  - Platform-routed volume is kept apart from venue-observed volume; the two are never summed.
 */
export type Provenance = 'own_fill' | 'user_supplied' | 'unknown_transfer';
export interface TradeInput {
    id: string;
    userId: string;
    chain: string;
    tokenIn: string;
    tokenOut: string;
    venue: string;
    state: TxState;
    fill: Fill;
    ts: number;
    origin?: string;
}
export interface Basis {
    cost: bigint;
    costToken: string;
    provenance: 'user_supplied';
    note?: string;
}
export interface Price {
    num: bigint;
    den: bigint;
}
export type FeeBook = {
    platform: Record<string, bigint>;
    venue: Record<string, bigint>;
    network: Record<string, bigint>;
};
export interface TradeRecord {
    id: string;
    ts: number;
    venue: string;
    side: 'buy' | 'sell';
    token: string;
    quoteToken: string | null;
    tokenQty: bigint;
    quoteAmount: bigint | null;
    fees: {
        platform: bigint;
        venue: bigint;
        network: bigint;
    };
}
export interface PositionView {
    chain: string;
    token: string;
    balance: bigint;
    knownQty: bigint;
    unknownQty: bigint;
    costToken: string | null;
    knownCost: bigint;
    avgCost: Price | null;
    realizedPnl: bigint;
    realizedUnknownProceeds: bigint;
    unrealizedPnl: bigint | null;
    unrealizedKnownPortion: bigint | null;
    fees: FeeBook;
    venues: string[];
    basisSources: Provenance[];
    oversold: boolean;
    firstTs: number | null;
}
export declare class Portfolio {
    private events;
    private ids;
    private migrations;
    private venueVol;
    readonly quoteTokens: Set<string>;
    constructor(quoteTokens?: string[]);
    /** Only confirmed/finalized fills count. Idempotent on id. */
    recordTrade(t: TradeInput): {
        accepted: boolean;
        reason?: string;
    };
    /** Reorg/unresolved: remove a previously recorded trade. */
    revokeTrade(id: string): boolean;
    recordTransferIn(e: {
        id: string;
        userId: string;
        chain: string;
        token: string;
        qty: bigint;
        ts: number;
        basis?: Basis;
    }): boolean;
    recordTransferOut(e: {
        id: string;
        userId: string;
        chain: string;
        token: string;
        qty: bigint;
        ts: number;
    }): boolean;
    /** Venue change is metadata only: positions are untouched. */
    recordMigration(chain: string, token: string, from: string, to: string, ts: number): void;
    migrationsOf(chain: string, token: string): {
        chain: string;
        token: string;
        from: string;
        to: string;
        ts: number;
    }[];
    /** Venue-observed volume (market data), kept apart from platform volume. */
    recordVenueVolume(venue: string, token: string, amount: bigint): void;
    venueVolume(venue: string, token: string): bigint;
    private fold;
    positions(userId: string, prices?: Map<string, Price>): PositionView[];
    position(userId: string, chain: string, token: string, prices?: Map<string, Price>): PositionView | undefined;
    history(userId: string, token?: string): TradeRecord[];
    fees(userId: string): FeeBook;
    /** Volume routed through OUR platform, per quote token. Not mixed with venue volume. */
    platformVolume(userId: string): Record<string, bigint>;
}
