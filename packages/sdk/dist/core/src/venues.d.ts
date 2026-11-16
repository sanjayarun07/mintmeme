import type { Venue } from './types.ts';
/** Constant-product pool (Uniswap-V2 style). Other pool models (CL, DLMM, stable) need their own Venue impl. */
export declare class CpAmm implements Venue {
    id: string;
    family: string;
    token: string;
    quoteToken: string;
    rToken: bigint;
    rQuote: bigint;
    feeBps: bigint;
    kind: 'cpamm';
    status: 'active' | 'graduated';
    successor?: string;
    constructor(id: string, family: string, token: string, quoteToken: string, rToken: bigint, rQuote: bigint, feeBps?: bigint);
    supports(a: string, b: string): boolean;
    private reserves;
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
    clone(): CpAmm;
}
/** Linear bonding curve: price(s) = p0 + slope*s (quote units per whole token). Graduates at `target` raised. */
export declare class LinearCurve implements Venue {
    id: string;
    family: string;
    token: string;
    quoteToken: string;
    p0: bigint;
    slope: bigint;
    supply: bigint;
    raised: bigint;
    target: bigint;
    feeBps: bigint;
    kind: 'curve';
    status: 'active' | 'graduated';
    successor?: string;
    constructor(id: string, family: string, token: string, quoteToken: string, p0: bigint, slope: bigint, supply?: bigint, raised?: bigint, target?: bigint, feeBps?: bigint);
    supports(a: string, b: string): boolean;
    private cost;
    private proceeds;
    private tokensFor;
    quote(a: string, b: string, amt: bigint): {
        venue: string;
        family: string;
        amountOut: bigint;
        priceImpactBps: number;
        venueFee: bigint;
        liquidity: bigint;
    };
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    get shouldGraduate(): boolean;
    clone(): LinearCurve;
}
