import type { Amount, PriceOrderInput, BulkInput, TwapInput, TraderEvent } from './trader.ts';
/** `userId`: with an APP key, the end user every call acts for (sent as X-User-Id). Use `forUser` to get a client per end user.
 *  `chain`: on a server that runs several chains (CHAINS=solana,base), the chain every call is for: paths become /v1/<chain>/... (app routes have no chain). Without it,
 *  calls go to the server's default chain. Use `forChain` for a client per chain, `chains()` for the list. */
export interface ClientOptions {
    baseUrl: string;
    apiKey: string;
    userId?: string;
    chain?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}
type J = any;
/** A copy config for the execution server (MODE=solana-mainnet), in plain units. Exactly one of `fixedSol` or `percent`. Unknown fields are refused by the server. */
export interface CopyInput {
    /** One leader wallet, or `leaders` with 1 to 10. */ leader?: string;
    leaders?: string[];
    /** The same SOL on every copied buy. */ fixedSol?: string; /** A share (0.01 to 1000 %) of the SOL the leader spent. */
    percent?: number;
    maxPerTradeSol?: string;
    dailySol?: string;
    maxPerTokenSol?: string;
    /** Token mints or stock tickers to copy only / never. */ allow?: string[];
    block?: string[];
    sides?: 'both' | 'buy';
    exitMode?: 'full-on-exit' | 'proportional' | 'full-on-any-sell' | 'ignore';
    slippagePct?: number;
    cooldownS?: number;
    maxPositions?: number;
    minConfirmations?: number;
    maxDeviationPct?: number;
    maxAgeSlots?: number;
    /** Run every rule and check, record what would be bought, send nothing. */ trackOnly?: boolean;
    id?: string;
}
/** Options on a trade or order for a tokenized stock (Solana). */
export interface StockTradeOptions {
    /** The stock by ticker instead of mint: "TSLAx", "TSLAon" or the underlying "TSLA". */ stock?: string;
    /** true: `shares` is an amount in shares, and priceUsd / tpUsd / slUsd / price are per SHARE (converted with the token's multiplier). */ perShare?: boolean;
    /** With perShare, on sells and sell orders: how many shares to sell (decimal string). Size buys with `sol`. */ shares?: string;
    /** Skip the safety and share-price checks for this one trade. */ allowRiskyToken?: boolean;
}
export declare class MemeClient {
    private o;
    constructor(o: ClientOptions);
    /** The URL of an API path, with this client's chain prefix (not on app routes or the chain list). */
    private url;
    private req;
    /** With an app key: the same client acting for another end user. */
    forUser(userId: string): MemeClient;
    /** The same client for another chain of a multi-chain server (`forChain('base')`). */
    forChain(chain: string): MemeClient;
    /** The chains this server runs and its default chain (no key needed). */
    chains(): Promise<{
        default: string;
        chains: {
            id: string;
            label: string;
            prefix: string;
            default: boolean;
        }[];
    }>;
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
        side: 'buy' | 'sell'; /** Solana mint, or a stock ticker such as "TSLAx" */
        mint?: string; /** Base: the 0x token address (mint works too); Solana: a mint or a stock ticker */
        token?: string;
        sol?: string; /** Base (MODE=base-mainnet): ETH to spend */
        eth?: string; /** BNB Chain: BNB amounts */
        bnb?: string;
        tokens?: string;
        pct?: number;
        slippagePct?: number;
        key?: string; /** this trade only: true = private (Jito), false = public; absent = your setting */
        mevProtection?: boolean;
    } & StockTradeOptions): Promise<any>;
    /** A standing order that trades by itself: `limit-buy` (with `sol`), `limit-sell`, `take-profit`, `stop-loss` (with `tokens` or `pct`), trigger `priceUsd` or `price` (SOL per token);
     *  `trailing-stop` with `trailPct`; `bracket` with `tpUsd` and/or `slUsd`. */
    placeOrder(p: {
        type: 'limit-buy' | 'limit-sell' | 'take-profit' | 'stop-loss' | 'trailing-stop' | 'bracket'; /** the token's mint (or `stock` with a ticker) */
        mint?: string;
        sol?: string; /** Base, Robinhood: ETH amounts */
        eth?: string; /** BNB Chain: BNB amounts */
        bnb?: string;
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
    } & StockTradeOptions): Promise<any>;
    /** The linked wallet (MODE=solana-mainnet): address, and whether the server may trade it now (and why not). */
    wallet(): Promise<any>;
    linkStart(address: string): Promise<any>;
    linkFinish(address: string, signatureBase64: string): Promise<any>;
    unlink(): Promise<any>;
    /** Trading settings (MODE=solana-mainnet). `mevProtection: true` sends trades privately through Jito with a tip of at most `maxTipSol` (default 0.0001). Off by default. */
    settings(): Promise<any>;
    updateSettings(p: {
        mevProtection?: boolean;
        maxTipSol?: string; /** buys of tokens that fail the safety check: block (default), warn or off */
        tokenSafety?: 'block' | 'warn' | 'off';
    }): Promise<any>;
    /** Token safety report (MODE=solana-mainnet): freeze/mint authority, Token-2022 extensions, holder concentration, a sell route, 1-SOL impact, and a verdict. */
    tokenSafety(mint: string): Promise<any>;
    /** Registered stocks (xStocks, Ondo, Backpack): by default the tradable ones, most liquid first. `all` lists every verified mint; `q` a ticker or underlying (TSLA). */
    stocks(q?: {
        all?: boolean;
        q?: string;
        issuer?: string;
        limit?: number;
        offset?: number;
    }): Promise<any>;
    /** One stock: shares per token (multiplier), issuer pause, the share price, what the best route pays per share now, and your holding in shares. */
    stock(symbol: string): Promise<any>;
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
    /** Copy configs with their state: running, lastError, inflight, the last decisions (bought, sold, skipped and why) and skippedByChecks. */
    copies(): Promise<any>;
    /** Follow leader wallets. On a `MODE=solana-mainnet` server: plain units, the linked wallet is the follower (docs/SDK_AND_API.md 4.10); copied buys pass the same token
     *  safety and stock checks as manual buys, within the account's SOL caps. Elsewhere the host supplies the leader source and the body is the engine's CopyConfig. */
    addCopy(p: CopyInput | J): Promise<any>;
    /** Stop a copy config: nothing more is copied; a copy already sent finishes; the tokens stay in the wallet. */
    removeCopy(id: string): Promise<any>;
    /** Server-sent events: order, trade, bulk, twap, snipe and alert changes. Resolves when the stream ends; pass an AbortSignal to stop listening. */
    events(on: (e: TraderEvent) => void, signal?: AbortSignal): Promise<void>;
}
/** For an app's webhook endpoint: true when `signatureHeader` (x-memedesk-signature) matches the RAW request body for `secret` and is at most `toleranceS` old. */
export declare function verifyWebhook(secret: string, rawBody: string, signatureHeader: string, toleranceS?: number, nowS?: number): Promise<boolean>;
export {};
