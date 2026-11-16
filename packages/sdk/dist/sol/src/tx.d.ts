export declare function base58(buf: Uint8Array): string;
export declare function b58decode(s: string): Uint8Array;
export declare function pubkeyBytes(a: string): Uint8Array;
export declare function isOnCurve(pk: Uint8Array): boolean;
export declare const cat: (...a: Uint8Array[]) => Uint8Array<ArrayBuffer>;
export declare function createProgramAddress(seeds: Uint8Array[], program: string): string;
export declare function findProgramAddress(seeds: Uint8Array[], program: string): {
    address: string;
    bump: number;
};
export interface Meta {
    pubkey: string;
    signer?: boolean;
    writable?: boolean;
}
export interface Ix {
    program: string;
    keys: Meta[];
    data: Uint8Array;
}
export declare const u64le: (n: bigint) => Uint8Array<ArrayBuffer>;
export declare const u32le: (n: number) => Uint8Array<ArrayBuffer>;
export declare const shortvec: (n: number) => Uint8Array<ArrayBuffer>;
/** Legacy message. Fee payer is keys[0] of the first instruction's signer set (we pass it explicitly). */
export declare function compileLegacy(payer: string, ixs: Ix[], blockhash32?: Uint8Array): Uint8Array;
/** Unsigned transaction wire bytes: one all-zero signature slot per required signer. */
export declare function unsignedTx(message: Uint8Array): Uint8Array;
export declare const PROGRAMS: {
    system: string;
    token: string;
    ata: string;
};
export declare const ataAddress: (owner: string, mint: string) => string;
export declare const createAtaIdempotent: (payer: string, owner: string, mint: string) => Ix;
export declare const systemTransfer: (from: string, to: string, lamports: bigint) => Ix;
export declare const syncNative: (account: string) => Ix;
export interface PoolKeys {
    programId: string;
    id: string;
    authority: string;
    openOrders: string;
    targetOrders: string;
    baseVault: string;
    quoteVault: string;
    marketProgram: string;
    market: string;
    bids: string;
    asks: string;
    eventQueue: string;
    marketBaseVault: string;
    marketQuoteVault: string;
    marketAuthority: string;
}
export declare function raydiumSwapBaseIn(k: PoolKeys, userIn: string, userOut: string, owner: string, amountIn: bigint, minOut: bigint): Ix;
export declare const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export declare const setComputeUnitLimit: (units: number) => Ix;
export declare const setComputeUnitPrice: (microLamports: bigint) => Ix;
/** SPL token CloseAccount: the remaining lamports (including a wrapped-SOL balance) go to `destination`. */
export declare const closeAccount: (account: string, destination: string, owner: string) => Ix;
/** Wire transaction from a compiled message and its signatures (one per required signer, in the message's signer order). */
export declare function wireTx(message: Uint8Array, signatures: Uint8Array[]): Uint8Array;
