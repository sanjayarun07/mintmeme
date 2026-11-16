export interface SolSigner {
    sign(wallet: string, message: Uint8Array): Uint8Array;
}
export declare class DevSolSigner implements SolSigner {
    private keys;
    /** Create (or import from a 32-byte seed) a wallet; returns its base58 address. */
    add(seed?: Uint8Array): string;
    sign(wallet: string, message: Uint8Array): Uint8Array;
    has(wallet: string): boolean;
}
export declare function verifySignature(address: string, message: Uint8Array, signature: Uint8Array): boolean;
