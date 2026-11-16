import type { Intent, TxState, Quote, Fill } from './types.ts';
import type { SimTx } from './simchain.ts';
import type { Backend, Persist } from './durable.ts';
export interface TxRecord {
    key: string;
    intent: Intent;
    state: TxState;
    history: {
        state: TxState;
        note?: string;
    }[];
    quote?: Quote;
    minOut?: bigint;
    tx?: SimTx;
    signature?: string;
    fill?: Fill;
    failure?: string;
    resubmits: number;
    simBlock?: number;
    confirmedBlock?: number;
    signDay?: number;
    authDigest?: string;
}
export declare const rep: (_: string, v: unknown) => unknown;
export declare const rev: (_: string, v: any) => any;
/** Durable-state seam. In-memory with snapshot/restore for restart tests; Postgres impl would implement the same surface. */
export declare class Store {
    records: Map<string, TxRecord>;
    nonces: Map<string, number>;
    /** When set, checkpoint() writes the whole state to this file atomically. The engine checkpoints after every step, so a signed tx is on disk BEFORE it is sent. */
    persistPath?: string;
    backend?: Backend;
    checkpoint(): void;
    /** Open (or create) a file-backed store. */
    static open(p: Persist): Store;
    snapshot(): string;
    static restore(s: string): Store;
}
