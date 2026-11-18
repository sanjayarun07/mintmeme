/** SHARED PIECES for aggregator venues on EVM chains (relay.ts uses them): a reference-quote venue, the exact balance-change simulation, and the KyberSwap swap decoder
 *  (Relay routes some same-chain swaps through KyberSwap; the decoder reads that inner swap's on-chain minimum).
 *   - `simulateCalls` runs the exact transactions (with an exact approve before them when the allowance is short) through `eth_simulateV1` with transfer tracing, so the
 *     wallet's real balance changes can be checked before signing: at most the input spent, at least the minimum received, and no other token leaving the wallet.
 *     `eth_simulateV1` with `traceTransfers` (native ETH shows as transfers from 0xeeee...eeee) answered on https://mainnet.base.org (2026-11-18).
 *   - KyberSwap's router `MetaAggregationRouterV2` 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 (code on Base, 18,312 bytes): selector 0xe21fd0e9 and the description layout
 *     were decoded from real builds (ETH -> NVDAc and back) and matched what the API reported (amount, receiver, minimum = quote - slippage).
 *  Coinbase's stock tokens on Base are B20 precompiles: an anvil fork cannot execute them (OpcodeNotFound), so these routes are checked against a real Base node, read-only. */
import type { Venue, Quote } from '../../core/src/index.ts';
export declare const KYBER: {
    readonly router: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
    readonly swapSelector: '0xe21fd0e9';
    readonly native: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
};
/** Thrown when a gate or a check refuses an aggregator transaction. Never retried: the caller treats it as a hard stop. */
export declare class AggRefused extends Error {
}
/** The swap description inside KyberSwap's `swap(SwapExecutionParams)` calldata: (callTarget, approveTarget, targetData, desc, clientData), desc = (srcToken, dstToken,
 *  srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[], dstReceiver, amount, minReturnAmount, flags, permit). Throws on anything that does not parse. */
export declare function decodeKyberSwap(data: string): {
    callTarget: string;
    srcToken: string;
    dstToken: string;
    feeReceivers: number;
    dstReceiver: string;
    amount: bigint;
    minReturnAmount: bigint;
};
/** Simulates calls in order from `wallet` with eth_simulateV1 (transfer tracing) and returns each call's status and gas, and the wallet's net balance change per token
 *  (NATIVE for ETH value transfers; gas is not included). Throws if the node cannot simulate. */
export declare function simulateCalls(rpc: {
    call<T = any>(m: string, p?: unknown[]): Promise<T>;
}, wallet: string, calls: {
    to: string;
    data: string;
    value: bigint;
}[]): Promise<{
    calls: {
        ok: boolean;
        gasUsed: bigint;
        error: string | undefined;
    }[];
    deltas: Record<string, bigint>;
}>;
/** An aggregator route for ONE direction of ONE pair, as a reference snapshot: quote(amount) scales it linearly (optimistic for large sizes). The real route is quoted
 *  again at the exact amount when the transaction is made, gated and simulated, and refused if it cannot meet the engine's minOut. */
export declare class AggVenue implements Venue {
    id: string;
    tokenIn: string;
    tokenOut: string;
    refIn: bigint;
    refOut: bigint;
    block: number;
    family: string;
    kind: 'cpamm';
    status: 'active' | 'graduated';
    constructor(id: string, tokenIn: string, tokenOut: string, refIn: bigint, refOut: bigint, block?: number, family?: string);
    supports(a: string, b: string): boolean;
    quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
    spotPriceE18(a: string, b: string): bigint;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    clone(): AggVenue;
}
