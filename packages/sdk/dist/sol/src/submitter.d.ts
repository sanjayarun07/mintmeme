import type { Ix } from './tx.ts';
export interface TxSubmitter {
    readonly name: string;
    /** Extra instruction appended to every transaction before signing (for example a Jito tip). Called once per prepare. */
    extraInstruction?(payer: string): Promise<Ix | undefined>;
    /** Send signed transaction bytes (base64) whose signature is `signature`. Return the signature the network reports. Throwing means "not accepted", never "maybe sent". */
    send(rawBase64: string, signature: string): Promise<string>;
}
export interface RpcLike {
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
export declare class RpcSubmitter implements TxSubmitter {
    private rpc;
    private o;
    readonly name = "rpc";
    constructor(rpc: RpcLike, o?: {
        skipPreflight?: boolean;
    });
    send(raw: string, signature: string): Promise<string>;
}
export declare const JITO_MAINNET_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1";
export interface JitoOptions {
    url?: string;
    tipLamports: bigint;
    maxTipLamports?: bigint;
    uuid?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    pickTip?: (accounts: string[]) => string;
    tipAccountsTtlMs?: number;
    now?: () => number;
}
export declare class JitoSubmitter implements TxSubmitter {
    private o;
    readonly name = "jito";
    private accounts?;
    constructor(o: JitoOptions);
    private rpc;
    /** Tip accounts come from the block engine (getTipAccounts), never from a hard-coded list, and are cached briefly. A tip to an address that is not one of them would simply be a donation. */
    tipAccounts(): Promise<string[]>;
    extraInstruction(payer: string): Promise<Ix>;
    send(raw: string, signature: string): Promise<string>;
}
