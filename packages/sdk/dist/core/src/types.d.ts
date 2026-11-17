export type Family = 'evm' | 'solana' | 'ton' | 'tron';
export type TxState = 'created' | 'validated' | 'quoted' | 'simulated' | 'awaiting_authorization' | 'signed' | 'submitted' | 'observed' | 'confirmed' | 'finalized' | 'failed' | 'expired' | 'unresolved';
export type Origin = 'manual' | 'telegram' | 'copy' | 'snipe' | 'order' | 'signal' | 'dca' | 'bulk' | 'twap';
export declare const NATIVE = "NATIVE";
export interface Intent {
    idempotencyKey: string;
    userId: string;
    walletId: string;
    chain: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minOut: bigint;
    slippageBps: number;
    deadline: number;
    maxFeeBps: number;
    venues: string[];
    origin: Origin;
    /** Send this trade privately (MEV protection) when the chain supports it; undefined: the account's default. */
    mev?: boolean;
}
export interface Quote {
    venue: string;
    family: string;
    source: 'direct' | 'aggregator';
    amountOut: bigint;
    priceImpactBps: number;
    venueFee: bigint;
    liquidity: bigint;
    block: number;
}
export interface Venue {
    id: string;
    family: string;
    kind: 'cpamm' | 'curve';
    status: 'active' | 'graduated';
    successor?: string;
    supports(a: string, b: string): boolean;
    quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    /** Optional: marginal price, units of `b` per unit of `a`, x1e18, BEFORE fee and price impact. Needed to evaluate price-triggered orders. */
    spotPriceE18?(a: string, b: string): bigint;
    clone(): Venue;
}
export interface Fill {
    spent: bigint;
    received: bigint;
    platformFee: bigint;
    venueFee: bigint;
    networkFee: bigint;
    quotedOut: bigint;
    shortfall: bigint;
}
