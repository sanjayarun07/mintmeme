import type { JIx } from './jupiterswap.ts';
export declare const JUPITERZ: {
    orderUrl: string;
    executeUrl: string;
    orderEngine: string;
    /** Anchor discriminator of `fill` (idls/order_engine.json). */
    fillDiscriminator: Uint8Array<ArrayBuffer>;
    tempWsolSeed: string;
    /** Routers other than JupiterZ, excluded so `/order` answers with an RFQ quote or none. */
    others: string;
};
export interface RfqCfg {
    orderUrl?: string;
    executeUrl?: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}
export interface RfqOrder {
    requestId: string;
    maker: string;
    expireAt: number;
    inAmount: bigint;
    outAmount: bigint;
    feeBps: number; /** The unsigned wire transaction exactly as Jupiter sent it. */
    tx: Uint8Array;
    message: Uint8Array;
}
/** No RFQ quote for this request, with Jupiter's reason. Not an error: the normal route is used. */
export interface RfqNone {
    none: string;
}
/** Splits a wire transaction into its signature slots and message. */
export declare function splitWire(tx: Uint8Array): {
    sigs: Uint8Array[];
    message: Uint8Array;
};
/** A JupiterZ-only `/order` for this taker and amount. Returns { none } when JupiterZ gives no buildable quote. */
export declare function fetchRfqOrder(o: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker: string;
} & RfqCfg): Promise<RfqOrder | RfqNone>;
export interface RfqFill {
    inputAmount: bigint;
    outputAmount: bigint;
    expireAt: number;
    feeBps?: number;
}
/** Decodes an Order Engine `fill`: 8-byte discriminator, input_amount u64, output_amount u64, expire_at i64, then an optional 5-byte trailer the program does not read. */
export declare function decodeFill(data: Uint8Array): RfqFill;
export interface RfqGateCtx {
    wallet: string;
    maker: string;
    wsol: string;
    /** Mints of the trade; wSOL means native SOL on that side (the engine trades native SOL). */
    inMint: string;
    outMint: string;
    amountIn: bigint;
    minOut: bigint;
    /** Token program of each trade mint, as the CHAIN reports it. */
    tokenProgram: (mint: string) => string;
    nowSec: number;
    maxExpirySec?: number;
    maxComputeUnits?: number;
}
export interface RfqGateResult {
    fill: RfqFill;
    createdTokenAccounts: string[];
    ixs: JIx[];
}
/** Refuses every RFQ transaction that is not exactly what we asked for. `wire` is Jupiter's unsigned transaction; what is signed is its message, unchanged. */
export declare function gateRfq(wire: Uint8Array, c: RfqGateCtx): RfqGateResult;
/** The engine stores this as the transaction's raw bytes: enough to resend to `/execute` after a restart and to know when the quote can no longer land. */
export declare const encodeRfqRaw: (requestId: string, expireAt: number, wire: Uint8Array) => string;
export declare function decodeRfqRaw(raw: string): {
    requestId: string;
    expireAt: number;
    wire: string;
} | undefined;
/** Our signature into our slot of Jupiter's message; the maker's slot stays empty (the maker fills it during `/execute`). */
export declare function rfqWire(message: Uint8Array, slot: number, sig: Uint8Array): Uint8Array;
export interface ExecuteResult {
    status: 'Success' | 'Failed';
    code: number;
    signature?: string;
    error?: string;
    totalInputAmount?: string;
    totalOutputAmount?: string;
}
/** `/execute` error codes after which the maker never signed, so the transaction cannot land (still only trusted once the quote has expired, see SolanaChain). */
export declare const RFQ_NOT_SENT: Set<number>;
/** POST /execute. A transport failure throws (the caller treats it as "ack lost"); any answer is returned as is. */
export declare function executeRfq(c: RfqCfg, signedBase64: string, requestId: string): Promise<ExecuteResult>;
