import type { SolSigner } from './signer.ts';
export interface PendingSign {
    id: string;
    wallet: string;
    message: Uint8Array;
    createdAt: number;
    expiresAt: number;
}
export declare class SignRequestError extends Error {
    constructor(msg: string);
}
export declare class RemoteSolSigner implements SolSigner {
    private o;
    private waiting;
    constructor(o?: {
        timeoutMs?: number;
        now?: () => number;
    });
    private now;
    sign(wallet: string, message: Uint8Array): Promise<Uint8Array>;
    pending(wallet?: string): PendingSign[];
    /** Deliver the wallet's signature for request `id`. Throws, and keeps the request open, if the signature does not verify. */
    submit(id: string, signature: Uint8Array): void;
    /** The user declined in the wallet. */
    reject(id: string, why?: string): void;
    cancelAll(why?: string): void;
}
