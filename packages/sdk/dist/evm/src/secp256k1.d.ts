export declare const N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
type J = [bigint, bigint, bigint];
export declare const G: J;
/** k·G in affine coordinates (tests use it to make keys). */
export declare function pointOf(k: bigint): [bigint, bigint];
/** Ethereum address (lowercase 0x...) of an uncompressed public key (x, y). */
export declare function addressOf([x, y]: [bigint, bigint]): string;
/** The public key that made signature (r, s, yParity) over the 32-byte `hash`. Throws for a malformed signature. */
export declare function recoverPublicKey(hash: Uint8Array, r: bigint, s: bigint, yParity: number): [bigint, bigint];
export declare function recoverAddress(hash: Uint8Array, r: bigint, s: bigint, yParity: number): string;
/** EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + byte length + message). */
export declare function personalHash(message: string | Uint8Array): Uint8Array;
/** Who signed `message` with personal_sign. `signature` is 65 bytes hex (r ‖ s ‖ v, v = 27/28 or 0/1). */
export declare function personalSigner(message: string | Uint8Array, signature: string): string;
export {};
