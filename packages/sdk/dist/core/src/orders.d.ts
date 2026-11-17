import { Reservations } from './reservations.ts';
import type { Intent } from './types.ts';
export type OrderKind = 'limit_buy' | 'limit_sell' | 'take_profit' | 'stop_loss' | 'trailing_stop';
export interface SupplyInfo {
    source: string;
    circulating?: bigint;
    total?: bigint;
}
export interface Order {
    id: string;
    userId: string;
    walletId: string;
    chain: string;
    token: string;
    quoteToken: string;
    kind: OrderKind;
    amount: bigint;
    triggerPriceE18?: bigint;
    trailBps?: number;
    ocoGroup?: string;
    expiresAt: number;
    /** Opt-in slippage chase: each failed attempt retries with stepBps more slippage, never above maxBps. Without it, retries keep the original slippage. */
    chase?: {
        stepBps: number;
        maxBps: number;
    };
    /** When set, the trigger is fixed in USD per whole token (decimal string) and triggerPriceE18 is re-derived from the live quote/USD price by the Trader. Persisted with the order. */
    usdPrice?: string;
    maxQuoteAgeMs: number;
    minLiquidity: bigint;
    maxDeviationBps: number;
    maxAttempts: number;
    slippageBps: number;
    venues: string[];
    mcap?: {
        targetE18: bigint;
        basis: 'circulating' | 'fdv';
        supply: SupplyInfo;
    };
    status: 'active' | 'fired' | 'cancelled' | 'expired' | 'failed' | 'disabled';
    reason?: string;
    attempts: number;
    peakE18?: bigint;
}
export interface Snapshot {
    priceE18: bigint;
    ts: number;
    liquidity: bigint;
    executableOut: (o: Order) => bigint;
}
/** Slippage for the order's next attempt: the original value, or with chase, original + attempts x step, capped at the chase maximum (and never below the original). */
export declare function slippageFor(o: Pick<Order, 'slippageBps' | 'attempts' | 'chase'>): number;
export declare class OrderManager {
    private res;
    private run;
    private now;
    private clockMs;
    /** Optional plan-limit gate: called with the user's current active-order count before placing; a deny makes place() throw with the reason. */
    private gate?;
    orders: Map<string, Order>;
    private claimed;
    constructor(res: Reservations, run: (i: Intent) => void, now: () => number, clockMs: () => number, 
    /** Optional plan-limit gate: called with the user's current active-order count before placing; a deny makes place() throw with the reason. */
    gate?: ((o: Order, active: number) => {
        allow: boolean;
        reason?: string;
    }) | undefined);
    /** Copy of the state worth persisting (orders incl. attempts/peaks, OCO claims). bigint values are kept as bigint: serialize with store.ts rep/rev. Reservations are snapshotted by their owner. */
    snapshot(): {
        orders: Order[];
        claimed: string[];
    };
    load(s: {
        orders: Order[];
        claimed: string[];
    }): void;
    place(o: Order): Order;
    cancel(id: string): void;
    /** Move an active order's trigger price. The reservation, amount, attempts and OCO link are kept. A bracket's take profit must stay above its stop loss.
     *  Trailing stops have no fixed trigger, and market-cap orders keep their cap target, so neither can be edited this way. */
    retrigger(id: string, priceE18: bigint): Order;
    private owner;
    private maybeRelease;
    /** Evaluate against a fresh snapshot AND an executable quote; never trigger from a stale/illiquid/unexecutable price. */
    evaluate(o: Order, s: Snapshot): {
        fire: boolean;
        why: string;
    };
    tick(snapOf: (o: Order) => Snapshot | undefined): string[];
    /** Execution result callback: bounded retries with unchanged limits; reservation released on terminal outcome. */
    onResult(id: string, ok: boolean): void;
}
