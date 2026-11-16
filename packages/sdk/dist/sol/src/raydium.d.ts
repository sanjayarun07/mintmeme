/** Raydium AMM v4 (constant product, order-book-backed) pool: layout decode, quote, key loading, and a `Venue` for the engine.
 *  Layout offsets from raydium-io/raydium-sdk-V2 (liquidity/layout.ts, serum/layout.ts); every derived key is cross-checked against on-chain data at load time.
 *  Known gap: the pool's open-orders balances are NOT added to the reserves (that layout is not sourced), so quotes are slightly conservative on pools with resting orders. */
import type { Venue, Quote } from '../../core/src/index.ts';
import type { PoolKeys } from './tx.ts';
export declare const AMM_V4_LAYOUT: {
    readonly size: 752;
    readonly baseDecimal: 32;
    readonly quoteDecimal: 40;
    readonly status: 0;
    readonly swapFeeNumerator: 176;
    readonly swapFeeDenominator: 184;
    readonly baseNeedTakePnl: 192;
    readonly quoteNeedTakePnl: 200;
    readonly poolOpenTime: 224;
    readonly baseVault: 336;
    readonly quoteVault: 368;
    readonly baseMint: 400;
    readonly quoteMint: 432;
    readonly lpMint: 464;
    readonly openOrders: 496;
};
export declare const AMM_STATUS_SWAP = 6n;
export interface PoolState {
    status: bigint;
    baseDecimal: number;
    quoteDecimal: number;
    swapFeeNum: bigint;
    swapFeeDen: bigint;
    baseNeedTakePnl: bigint;
    quoteNeedTakePnl: bigint;
    baseVault: string;
    quoteVault: string;
    baseMint: string;
    quoteMint: string;
    lpMint: string;
    openOrders: string;
    openTime: bigint;
}
export declare function decodePoolState(data: Buffer): PoolState;
/** Constant-product with the pool's own fee fraction (fee taken from input). */
export declare function quoteOut(amountIn: bigint, rIn: bigint, rOut: bigint, feeNum: bigint, feeDen: bigint): bigint;
export interface SolRpc {
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
/** Reads the pool and its serum market, derives and CHECKS every account the swap instruction needs. Throws with the failing check. */
export declare function loadPoolKeys(rpc: SolRpc, poolId: string, programId: string): Promise<{
    keys: PoolKeys;
    state: PoolState;
}>;
/** Engine venue for one Raydium AMM v4 pool. Token ids are mint addresses (case-sensitive base58); 'NATIVE' is mapped to the wrapped-SOL mint. */
export declare class RaydiumVenue implements Venue {
    id: string;
    keys: PoolKeys;
    baseMint: string;
    quoteMint: string;
    baseReserve: bigint;
    quoteReserve: bigint;
    feeNum: bigint;
    feeDen: bigint;
    wsol: string;
    tradable: boolean;
    slot: number;
    kind: 'cpamm';
    status: 'active' | 'graduated';
    successor?: string;
    family: string;
    constructor(id: string, keys: PoolKeys, baseMint: string, quoteMint: string, baseReserve: bigint, quoteReserve: bigint, feeNum: bigint, feeDen: bigint, wsol: string, tradable: boolean, slot?: number);
    private res;
    supports(a: string, b: string): boolean;
    private io;
    quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
    spotPriceE18(a: string, b: string): bigint;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    clone(): RaydiumVenue;
}
