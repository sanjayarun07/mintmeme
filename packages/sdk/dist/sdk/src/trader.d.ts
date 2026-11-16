import { OrderRunner, BulkRunner, TwapRunner, SnipeRunner, CopyRunner, Portfolio, PriceAlerts } from '../../core/src/index.ts';
import type { Backend, Engine, ChainPort, Order, Fill, BulkSummary, TwapSummary, SnipeConfig, CopyConfig, LaunchSource, LeaderSource, Launch } from '../../core/src/index.ts';
export type Amount = bigint | string | number;
export interface TraderConfig {
    engine: Engine;
    chain: ChainPort;
    userId: string;
    /** The token the platform prices everything in. Default: the chain's native token. */
    quoteToken?: string;
    /** Venue ids or families this Trader may use. Required: the engine only routes through venues you name (the wallet policy must also allow them). */
    venues: string[];
    clockMs?: () => number;
    /** Practice chains have no clock of their own: pass a function that mines blocks so trades can confirm. Real chains leave this out (the network produces blocks). */
    advanceChain?: () => void | Promise<void>;
    /** Directory for durable runner state. Without it everything is in memory and a restart forgets orders, bulk and TWAP jobs (in-flight trades are still safe: the engine store is the record). */
    persistDir?: string;
    /** Where durable state goes when it is not a folder: a function that returns a Backend for a name such as "orders", "trader" or "bulk-b1" (for example `name => redisState.backend(name)`). Wins over persistDir. */
    state?: (name: string) => Backend;
    /** Plan limits: called before an order is placed with the user's active order count. */
    orderGate?: ConstructorParameters<typeof OrderRunner>[0]['gate'];
    defaults?: {
        slippageBps?: number;
        orderTtlS?: number;
        maxDeviationBps?: number;
        maxAttempts?: number;
        maxQuoteAgeMs?: number;
        minLiquidity?: bigint;
    };
}
export interface TradeView {
    key: string;
    state: string;
    walletId: string;
    origin: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    fill?: Fill;
    venue?: string;
    txHash?: string;
    failure?: string;
    history: {
        state: string;
        note?: string;
    }[];
}
export interface QuoteView {
    venue: string;
    amountOut: bigint;
    minOut: bigint;
    priceImpactBps: number;
    platformFee: bigint;
    venueFee: bigint;
    liquidity: bigint;
    alternatives: {
        venue: string;
        amountOut: bigint;
    }[];
}
export type TraderEvent = {
    type: 'trade';
    key: string;
    state: string;
    walletId: string;
    origin: string;
    failure?: string;
} | {
    type: 'order';
    id: string;
    status: Order['status'];
    reason?: string;
    attempts: number;
} | {
    type: 'bulk';
    id: string;
    filled: number;
    failed: number;
    skipped: number;
    open: number;
    done: boolean;
} | {
    type: 'twap';
    id: string;
    filled: number;
    failed: number;
    skipped: number;
    open: number;
    done: boolean;
} | {
    type: 'snipe';
    id: string;
    launch: string;
    status: string;
} | {
    type: 'alert';
    id: string;
    token: string;
    direction: 'above' | 'below';
    threshold: number;
    price: number;
} | {
    type: 'error';
    where: string;
    message: string;
};
export declare class Trader {
    private c;
    readonly orders: OrderRunner;
    readonly portfolio: Portfolio;
    readonly alerts: PriceAlerts;
    readonly bulks: Map<string, BulkRunner>;
    private readonly sides;
    readonly twaps: Map<string, TwapRunner>;
    readonly snipes: Map<string, SnipeRunner>;
    readonly copies: Map<string, CopyRunner>;
    private paused;
    private listeners;
    private timer?;
    private busy;
    private seen;
    private priceAlertSpecs;
    readonly quoteToken: string;
    readonly userId: string;
    constructor(c: TraderConfig);
    private meta?;
    /** The durable store for one named piece of state, or undefined when this Trader is in-memory only. */
    private store;
    /** Account-level state that nothing else owns: the pause switch, price alerts (with armed/active), and the bulk and TWAP jobs so a restart can find them again. Written before the change is reported. */
    private saveMeta;
    private loadMeta;
    private get chain();
    private get engine();
    private d;
    private path;
    private slip;
    on(fn: (e: TraderEvent) => void): () => void;
    private emit;
    private changed;
    private intent;
    /** What a market trade would return right now, from the best authorized venue. Nothing is sent. */
    quote(p: {
        side: 'buy' | 'sell';
        token: string;
        amount: Amount;
        slippageBps?: number;
        walletId?: string;
    }): Promise<QuoteView>;
    /** Market buy: spend `amount` of the quote token on `token`. Resolves when the engine has taken the trade as far as it can (finalized, failed, or waiting on the chain). */
    buy(p: {
        walletId: string;
        token: string;
        amount: Amount;
        slippageBps?: number;
        minOut?: Amount;
        key?: string;
        deadlineS?: number;
        maxFeeBps?: number;
    }): Promise<TradeView>;
    /** Market sell: `amount` of `token` for the quote token, or `pctBps` (1..10000) of the wallet's balance. */
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
    }): Promise<TradeView>;
    private sellAmount;
    private trade;
    /** One trade by its idempotency key. */
    trade_(key: string): TradeView | undefined;
    /** Recent trades of this account (all origins: manual, order, bulk, twap, snipe, copy), newest first. */
    trades(opts?: {
        limit?: number;
        origin?: string;
        walletId?: string;
    }): TradeView[];
    /** Drive a trade that is waiting on the chain (confirmations, resubmission) one more time. Safe to repeat. */
    advance(key: string): Promise<TradeView>;
    /** Replace a stuck transaction's nonce with a no-op so later trades are not blocked (the engine's reconcile-first rules apply). */
    cancelStuck(walletId: string, opts?: {
        force?: boolean;
    }): Promise<import("../../core/src/engine.ts").CancelResult>;
    private record;
    private orderBase;
    private put;
    /** Buy `amount` (quote budget) when the price falls to `priceE18` (quote per token x1e18) or lower. */
    limitBuy(p: PriceOrderInput): Promise<Order>;
    /** Sell `amount` tokens when the price reaches `priceE18` or higher. */
    limitSell(p: PriceOrderInput): Promise<Order>;
    takeProfit(p: PriceOrderInput): Promise<Order>;
    stopLoss(p: PriceOrderInput): Promise<Order>;
    /** Sell when the price has fallen `trailBps` from the highest price seen since the order was placed. */
    trailingStop(p: Omit<PriceOrderInput, 'priceE18'> & {
        trailBps: number;
    }): Promise<Order>;
    /** Take profit and/or stop loss (and/or trailing stop) on ONE position: when one fires the others are cancelled and the tokens are reserved once. */
    bracket(p: Omit<PriceOrderInput, 'priceE18'> & {
        takeProfitE18?: Amount;
        stopLossE18?: Amount;
        trailBps?: number;
    }): Promise<Order[]>;
    private trigger;
    cancelOrder(orderId: string): Order;
    getOrder(orderId: string): Order | undefined;
    listOrders(opts?: {
        status?: Order['status'];
        token?: string;
    }): Order[];
    /** Why an active order has not fired (or could not be evaluated), straight from the runner. */
    orderStatus(orderId: string): {
        status: "active" | "cancelled" | "disabled" | "expired" | "failed" | "fired";
        reason: string | undefined;
        attempts: number;
        peakE18: bigint | undefined;
        notEvaluated: string | undefined;
    } | undefined;
    /** One request, up to 10 wallets, each leg an ordinary trade from ITS OWN wallet (own policy, nonce, idempotency). Not atomic: the result says which legs landed. */
    bulkBuy(p: BulkInput): Promise<BulkSummary>;
    bulkSell(p: BulkInput & {
        pctBps?: number;
    }): Promise<BulkSummary>;
    private bulk;
    bulkStatus(bid: string): BulkSummary;
    /** Trade `total` in `slices` equal parts, one every `intervalS` seconds from ONE wallet. A slice that cannot go in its window is skipped and reported, never made up later. */
    twap(p: TwapInput): Promise<TwapSummary>;
    twapStatus(tid: string): TwapSummary;
    cancelTwap(tid: string): TwapSummary;
    /** Start sniping new launches with a bounded budget. You supply the launch source (an EVM log scanner, the Solana launch stream, or a test double). Exits become price orders. */
    addSnipe(sid: string, p: {
        cfg: Omit<SnipeConfig, 'userId' | 'chain' | 'quoteToken' | 'venues'> & Partial<Pick<SnipeConfig, 'quoteToken' | 'venues'>>;
        source: LaunchSource;
        inspect?: (l: Launch) => Promise<void>;
    }): SnipeRunner;
    removeSnipe(sid: string): boolean;
    /** Mirror one or more leader wallets. Same rules as the Copy Trading page: caps, cooldown, exit following, track-only, checks. */
    addCopy(cid: string, p: {
        cfgs: (Omit<CopyConfig, 'userId' | 'chain' | 'quoteToken' | 'venues'> & Partial<Pick<CopyConfig, 'quoteToken' | 'venues'>>)[];
        source: LeaderSource;
        info?: ConstructorParameters<typeof CopyRunner>[0]['info'];
        probeAmount?: bigint;
    }): CopyRunner;
    removeCopy(cid: string): boolean;
    /** Alert when the best venue price of `token` crosses `threshold` (quote units per token, as a plain number). Fires as an `alert` event. */
    addPriceAlert(p: {
        id?: string;
        token: string;
        direction: 'above' | 'below';
        threshold: number;
        oneShot?: boolean;
    }): string;
    cancelPriceAlert(aid: string): boolean;
    positions(): import("../../core/src/portfolio.ts").PositionView[];
    history(token?: string): import("../../core/src/portfolio.ts").TradeRecord[];
    /** Best venue spot price of `token` in the quote token, x1e18, or undefined when no authorized venue can report one. */
    spotE18(token: string): bigint | undefined;
    /** Pause NEW automated buys (orders, bulk, TWAP, snipe, copy). Sells, stop losses and manual sells are unaffected. Buys through buy() are refused with a clear message too. */
    pauseEntries(): void;
    resumeEntries(): void;
    get entriesPaused(): boolean;
    /** Everything still unfinished, for a dashboard. */
    overview(): {
        userId: string;
        chain: string;
        quoteToken: string;
        entriesPaused: boolean;
        block: number;
        time: number;
        orders: {
            active: number;
            total: number;
        };
        bulks: number;
        twaps: number;
        snipes: number;
        copies: number;
    };
    /** One pass of every runner. Safe to call by hand (tests, cron) or let start() call it. */
    tick(): Promise<void>;
    start(everyMs?: number): void;
    stop(): void;
    /** After a restart with the same persistDir and engine store: finish what was in flight. Orders and runners must be re-created by id first (same ids reuse the same keys, so nothing trades twice). */
    resume(): Promise<void>;
    private fireAlerts;
    private diff;
}
export interface PriceOrderInput {
    id?: string;
    walletId: string;
    token: string;
    /** buy: quote-token budget. sell: token amount. Raw base units. */
    amount: Amount;
    /** Quote units per token, x1e18. Use priceE18() from wire.ts to convert a human price. */
    priceE18?: Amount;
    /** Instead of a price: trigger at a market cap (quote units). Needs the supply; with no supply the order is disabled with a reason, never guessed. */
    marketCap?: {
        target: Amount;
        basis?: 'circulating' | 'fdv';
        circulating?: Amount;
        total?: Amount;
        supplySource: string;
    };
    slippageBps?: number;
    ttlS?: number;
    maxDeviationBps?: number;
    maxAttempts?: number;
    maxQuoteAgeMs?: number;
    minLiquidity?: Amount;
}
export interface BulkInput {
    id?: string;
    token: string;
    slippageBps?: number;
    /** Explicit amount per wallet, or `wallets` + `total` for an equal split. */
    legs?: {
        walletId: string;
        amount: Amount;
    }[];
    wallets?: string[];
    total?: Amount;
    maxTotal?: Amount;
    maxImpactBps?: number;
    onFailure?: 'continue' | 'stop';
    mode?: 'sequential' | 'parallel';
    perTick?: number;
}
export interface TwapInput {
    id?: string;
    walletId: string;
    token: string;
    side: 'buy' | 'sell';
    total: Amount;
    slices: number;
    intervalS: number;
    startAt?: number;
    windowS?: number;
    slippageBps?: number;
    limitPriceE18?: Amount;
    maxSliceImpactBps?: number;
    jitterPct?: number;
    onFailure?: 'continue' | 'stop';
}
