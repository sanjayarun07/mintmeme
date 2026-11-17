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
/** Jito's documented block engine host (https://docs.jito.wtf/lowlatencytxnsend/). Regional hosts such as https://ny.mainnet.block-engine.jito.wtf can replace it. */
export declare const JITO_MAINNET_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf";
export declare const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
/** Jito's sandwich-mitigation flag: any valid public key starting with "jitodontfront", added read-only to an instruction. The block engine then rejects a bundle unless this
 *  transaction is first in it. Jito: "may help reduce sandwich attacks but is not guaranteed to do so". It does not need to exist on chain. */
export declare const JITO_DONT_FRONT = "jitodontfront111111111111111111111111111111";
export declare const JITO_MIN_TIP = 1000n;
export interface JitoOptions {
    url?: string;
    /** A fixed tip in lamports, or 'auto' (default): the tip floor's landed-tip percentile now (`tipPercentile`, default 75), within [JITO_MIN_TIP, maxTipLamports]. */
    tip?: bigint | 'auto';
    tipPercentile?: 25 | 50 | 75 | 95 | 99;
    /** @deprecated use `tip` */ tipLamports?: bigint;
    /** Hard cap on one tip. Default 100,000 lamports (0.0001 SOL). */
    maxTipLamports?: bigint;
    /** Add the jitodontfront flag to the tip instruction. Default true. */
    dontFront?: boolean;
    uuid?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    pickTip?: (accounts: string[]) => string;
    tipAccountsTtlMs?: number;
    tipFloorTtlMs?: number;
    tipFloorUrl?: string;
    now?: () => number;
    /** Spacing between block-engine calls in this process (Jito default limit: 1 per second per IP). Default 1,000 ms; raise only with a custom limit from Jito. */
    minIntervalMs?: number;
}
/** Sends each transaction privately to the Jito block engine: `sendTransaction` with `bundleOnly=true`, i.e. as a one-transaction bundle that is never broadcast publicly
 *  by Jito and lands all-or-nothing (a failing transaction is not included and pays no tip). The tip is a SOL transfer to one of Jito's tip accounts inside the same transaction
 *  (Jito: tips only work with Jito-Solana leaders; not through address lookup tables). Limits (Jito docs): 1 request per second per IP per region without a custom limit;
 *  a block that is skipped and rebroadcast can expose the transaction to the normal path ("uncled blocks"). */
export declare class JitoSubmitter implements TxSubmitter {
    private o;
    readonly name = "jito";
    private accounts?;
    private floor?;
    constructor(o?: JitoOptions);
    /** Jito allows 1 request per second per IP per region by default: every block-engine call in this process waits its turn (shared by all users on a node). */
    private static queues;
    private paced;
    private rpc;
    private call;
    /** Tip accounts come from the block engine (getTipAccounts), never from a hard-coded list, and are cached briefly. A tip to an address that is not one of them would simply be a donation. */
    tipAccounts(): Promise<string[]>;
    /** The tip for the next transaction, in lamports. 'auto': the tip floor's landed-tip percentile (reported in SOL), cached 30 s; if the floor cannot be read, the cap's tenth. */
    tipNow(): Promise<bigint>;
    extraInstruction(payer: string): Promise<Ix>;
    send(raw: string, signature: string): Promise<string>;
}
