import type { Amount, PriceOrderInput, BulkInput, TwapInput, TraderEvent } from './trader.ts';
export interface ClientOptions {
    baseUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}
type J = any;
export declare class MemeClient {
    private o;
    constructor(o: ClientOptions);
    private req;
    overview(): Promise<any>;
    quote(p: {
        side: 'buy' | 'sell';
        token: string;
        amount: Amount;
        slippageBps?: number;
    }): Promise<any>;
    /** `key` becomes the Idempotency-Key: retrying the same key never trades twice. */
    buy(p: {
        walletId: string;
        token: string;
        amount: Amount;
        slippageBps?: number;
        minOut?: Amount;
        key?: string;
        deadlineS?: number;
        maxFeeBps?: number;
    }): Promise<any>;
    sell(p: {
        walletId: string;
        token: string;
        amount?: Amount;
        pctBps?: number;
        slippageBps?: number;
        minOut?: Amount;
        key?: string;
        deadlineS?: number;
        maxFeeBps?: number;
    }): Promise<any>;
    trades(q?: {
        limit?: number;
        origin?: string;
        walletId?: string;
    }): Promise<any>;
    trade(key: string): Promise<any>;
    advance(key: string): Promise<any>;
    cancelStuck(walletId: string, opts?: {
        force?: boolean;
    }): Promise<any>;
    limitBuy(p: PriceOrderInput): Promise<any>;
    limitSell(p: PriceOrderInput): Promise<any>;
    takeProfit(p: PriceOrderInput): Promise<any>;
    stopLoss(p: PriceOrderInput): Promise<any>;
    trailingStop(p: Omit<PriceOrderInput, 'priceE18'> & {
        trailBps: number;
    }): Promise<any>;
    bracket(p: Omit<PriceOrderInput, 'priceE18' | 'priceUsd'> & {
        takeProfitE18?: Amount;
        stopLossE18?: Amount;
        takeProfitUsd?: string;
        stopLossUsd?: string;
        trailBps?: number;
    }): Promise<any>;
    orders(q?: {
        status?: string;
        token?: string;
    }): Promise<any>;
    order(id: string): Promise<any>;
    /** Move an active order's trigger: priceE18 (quote token) or priceUsd (dollars). */
    editOrder(id: string, p: {
        priceE18?: Amount;
        priceUsd?: string;
    }): Promise<any>;
    cancelOrder(id: string): Promise<any>;
    bulkBuy(p: BulkInput): Promise<any>;
    bulkSell(p: BulkInput & {
        pctBps?: number;
    }): Promise<any>;
    bulk(id: string): Promise<any>;
    twap(p: TwapInput): Promise<any>;
    twapStatus(id: string): Promise<any>;
    cancelTwap(id: string): Promise<any>;
    addPriceAlert(p: {
        id?: string;
        token: string;
        direction: 'above' | 'below';
        threshold: number;
        oneShot?: boolean;
    }): Promise<any>;
    cancelPriceAlert(id: string): Promise<any>;
    positions(): Promise<any>;
    history(token?: string): Promise<any>;
    pauseEntries(): Promise<any>;
    resumeEntries(): Promise<any>;
    snipes(): Promise<any>;
    addSnipe(p: J): Promise<any>;
    copies(): Promise<any>;
    addCopy(p: J): Promise<any>;
    /** Server-sent events: order, trade, bulk, twap, snipe and alert changes. Resolves when the stream ends; pass an AbortSignal to stop listening. */
    events(on: (e: TraderEvent) => void, signal?: AbortSignal): Promise<void>;
}
export {};
