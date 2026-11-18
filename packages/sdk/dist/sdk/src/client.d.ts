import type { Amount, PriceOrderInput, BulkInput, TwapInput, TraderEvent } from './trader.ts';
/** `userId`: with an APP key, the end user every call acts for (sent as X-User-Id). Use `forUser` to get a client per end user. */
export interface ClientOptions {
    baseUrl: string;
    apiKey: string;
    userId?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}
type J = any;
export declare class MemeClient {
    private o;
    constructor(o: ClientOptions);
    private req;
    /** With an app key: the same client acting for another end user. */
    forUser(userId: string): MemeClient;
    appWebhook(): Promise<any>;
    /** Returns the signing secret once (generated unless you pass one). Verify each delivery: x-memedesk-signature t=..,v1=HMAC-SHA256(secret, "t.body"). */
    setAppWebhook(url: string, secret?: string): Promise<any>;
    deleteAppWebhook(): Promise<any>;
    testAppWebhook(): Promise<any>;
    appUsers(): Promise<any>;
    /** The app's own fee on its users' trades (MODE=solana-mainnet): bps of each trade, paid in SOL to `wallet` inside the trade, capped by the operator. */
    appFees(): Promise<any>;
    setAppFees(wallet: string, bps: number): Promise<any>;
    deleteAppFees(): Promise<any>;
    recordTrades(q?: {
        limit?: number;
        before?: string;
    }): Promise<any>;
    auditLog(q?: {
        limit?: number;
        before?: string;
    }): Promise<any>;
    /** App keys: records of all the app's end users. */
    appRecordTrades(q?: {
        limit?: number;
        before?: string;
    }): Promise<any>;
    appAuditLog(q?: {
        limit?: number;
        before?: string;
    }): Promise<any>;
    overview(): Promise<any>;
    /** Buy with `sol`, or sell `pct` of the holding or `tokens`. Resolves with the trade (state, fill, failure). Same `key` again never trades twice. */
    swap(p: {
        side: 'buy' | 'sell';
        mint: string;
        sol?: string;
        tokens?: string;
        pct?: number;
        slippagePct?: number;
        key?: string; /** this trade only: true = private (Jito), false = public; absent = your setting */
        mevProtection?: boolean;
    }): Promise<any>;
    /** A standing order that trades by itself: `limit-buy` (with `sol`), `limit-sell`, `take-profit`, `stop-loss` (with `tokens` or `pct`), trigger `priceUsd` or `price` (SOL per token);
     *  `trailing-stop` with `trailPct`; `bracket` with `tpUsd` and/or `slUsd`. */
    placeOrder(p: {
        type: 'limit-buy' | 'limit-sell' | 'take-profit' | 'stop-loss' | 'trailing-stop' | 'bracket';
        mint: string;
        sol?: string;
        tokens?: string;
        pct?: number;
        priceUsd?: string | number;
        price?: string;
        trailPct?: number;
        tpUsd?: string;
        slUsd?: string;
        slippagePct?: number;
        chase?: {
            stepBps: number;
            maxBps: number;
        };
        id?: string;
        ttlS?: number;
        mevProtection?: boolean;
    }): Promise<any>;
    /** The linked wallet (MODE=solana-mainnet): address, and whether the server may trade it now (and why not). */
    wallet(): Promise<any>;
    linkStart(address: string): Promise<any>;
    linkFinish(address: string, signatureBase64: string): Promise<any>;
    unlink(): Promise<any>;
    /** Trading settings (MODE=solana-mainnet). `mevProtection: true` sends trades privately through Jito with a tip of at most `maxTipSol` (default 0.0001). Off by default. */
    settings(): Promise<any>;
    updateSettings(p: {
        mevProtection?: boolean;
        maxTipSol?: string;
    }): Promise<any>;
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
/** For an app's webhook endpoint: true when `signatureHeader` (x-memedesk-signature) matches the RAW request body for `secret` and is at most `toleranceS` old. */
export declare function verifyWebhook(secret: string, rawBody: string, signatureHeader: string, toleranceS?: number, nowS?: number): Promise<boolean>;
export {};
