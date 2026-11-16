import type { Venue } from '../../core/src/types.ts';
/** Injected JSON-RPC eth_call: returns 0x-hex return data. `block` pins the state. */
export type EthCall = (req: {
    to: string;
    data: string;
}, block?: number | 'latest') => Promise<string>;
export interface FeeSpec {
    num: bigint;
    den: bigint;
}
export declare const V2_FEE: FeeSpec;
/** Exact UniswapV2Library.getAmountOut. */
export declare function getAmountOut(amountIn: bigint, rIn: bigint, rOut: bigint, fee?: FeeSpec): bigint;
/** Exact UniswapV2Library.getAmountIn. */
export declare function getAmountIn(amountOut: bigint, rIn: bigint, rOut: bigint, fee?: FeeSpec): bigint;
export interface Reserves {
    reserve0: bigint;
    reserve1: bigint;
    blockTimestampLast: bigint;
}
export declare function decodeReserves(ret: string): Reserves;
export interface V2VenueConfig {
    id: string;
    family?: string;
    pair: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    fee?: FeeSpec;
    /** wrapped native token; NATIVE maps to it */
    wrappedNative?: string;
    block?: number;
}
export declare class V2Venue implements Venue {
    kind: 'cpamm';
    status: 'active' | 'graduated';
    successor?: string;
    id: string;
    family: string;
    pair: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    fee: FeeSpec;
    wrappedNative?: string;
    block: number;
    constructor(c: V2VenueConfig);
    /** Load state via injected eth_call (token0 from chain; reserves pinned to `block` when given). */
    static load(call: EthCall, o: {
        id: string;
        pair: string;
        family?: string;
        fee?: FeeSpec;
        wrappedNative?: string;
        block?: number; /** a pair's two tokens never change: pass what an earlier load returned to skip those two calls */
        tokens?: {
            token0: string;
            token1: string;
        };
    }): Promise<V2Venue>;
    private res;
    supports(a: string, b: string): boolean;
    private io;
    quote(a: string, b: string, amt: bigint): {
        venue: string;
        family: string;
        amountOut: bigint;
        priceImpactBps: number;
        venueFee: bigint;
        liquidity: bigint;
    };
    spotPriceE18(a: string, b: string): bigint;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    clone(): V2Venue;
}
