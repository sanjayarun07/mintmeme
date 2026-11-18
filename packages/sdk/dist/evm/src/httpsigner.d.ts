import type { Eip1559Request, RawSigner } from './rpcchain.ts';
/** Minimal RLP decoder, just enough to read an EIP-1559 transaction. */
export type Rlp = Uint8Array | Rlp[];
/** Reads the signed fields of a type-2 transaction. Throws if it is not a well-formed, signed EIP-1559 transaction. */
export declare function decodeEip1559(raw: string): {
    chainId: bigint;
    nonce: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    gasLimit: bigint;
    to: string;
    value: bigint;
    data: string;
};
/** RLP encoding of bytes and nested lists (canonical). */
export declare function rlpEncode(x: Rlp): Uint8Array;
/** The address that signed a type-2 transaction: recovered from its signature over keccak256(0x02 ‖ rlp(the nine unsigned fields)). */
export declare function signerOf(raw: string): string;
/** Compares what the signing service returned with what we asked it to sign. Returns the first difference, or undefined when they agree. */
export declare function mismatch(raw: string, q: Eip1559Request): string | undefined;
export interface HttpSignerOpts {
    url: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Signs through an external custody service (HSM gateway, MPC cluster, KMS wrapper): `POST <url>` with
 *   { wallet, to, data, value, nonce, chainId, gasLimit, maxFeePerGas, maxPriorityFeePerGas }  (numbers that can exceed 2^53 are decimal strings)
 * and expects { raw: "0x02..." } back. Before the transaction is used it is decoded and every field is compared with the request, so a faulty or
 * compromised service cannot change the destination, value, data, nonce or fees. It cannot be checked here WHO signed it (no signature recovery in this
 * package); the node rejects a bad signature, and a signature from the wrong key would spend from a different address.
 * The service decides whether to sign: our PolicySigner has already approved the intent, but the service should enforce its own limits too.
 */
export declare class HttpSigner implements RawSigner {
    private o;
    constructor(o: HttpSignerOpts);
    sign(q: Eip1559Request): Promise<string>;
}
