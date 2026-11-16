import type { Intent } from './types.ts';
import { Store } from './store.ts';
import type { TxRecord } from './store.ts';
import type { ChainPort } from './port.ts';
import { PolicySigner } from './signer.ts';
import { Router } from './router.ts';
import type { FeeSchedule, FeeCollector } from './commerce.ts';
export interface CancelResult {
    status: 'cancelled' | 'replacing' | 'pending' | 'included' | 'nothing' | 'rpc_down' | 'denied';
    nonce: number;
    noopKey?: string;
    reason?: string;
}
export declare const day: (t: number) => number;
export declare class Engine {
    d: {
        store: Store;
        chain: ChainPort;
        signer: PolicySigner;
        router: Router;
        platformFeeBps: number;
        fees?: {
            schedule: FeeSchedule;
            collector?: FeeCollector;
            tierOf: (userId: string) => string;
        };
    };
    private locks;
    maxResubmits: number;
    /** Optional commerce wiring: fee rate comes from the schedule by user tier; the fee is booked to the ledger once the trade is FINAL (reorg-safe, idempotent per trade). */
    constructor(d: {
        store: Store;
        chain: ChainPort;
        signer: PolicySigner;
        router: Router;
        platformFeeBps: number;
        fees?: {
            schedule: FeeSchedule;
            collector?: FeeCollector;
            tierOf: (userId: string) => string;
        };
    });
    private bps;
    private go;
    private fail;
    /** Idempotent entry: same key never creates a second economic execution. */
    submit(intent: Intent): Promise<TxRecord>;
    /** Resumable driver. Safe to call repeatedly or after restart; per-key mutex serializes in-process callers. */
    advance(key: string): Promise<TxRecord>;
    private drive;
    private step;
    /** Reconcile BEFORE rebuilding: look up the SAME signed tx; resubmit identical bytes (same nonce/hash) only if absent. */
    private send;
    /** Tx can never be included (rejected / expired-absent / nonce taken): refund its signer limit charge. Never call if it may still land. */
    private release;
    /**
     * Heal a nonce gap: if the wallet's lowest unconsumed nonce belongs to a signed tx that is failed/expired and absent from
     * the node, cancelNonce it. Returns undefined when there is nothing stuck.
     */
    healNonce(walletId: string): Promise<CancelResult | undefined>;
    /**
     * Cancel/replace the wallet's lowest unconsumed nonce with a signed noop so later nonces are not blocked forever.
     * Reconcile-first rules: the original tx is looked up on the node BEFORE anything is replaced.
     *  - included            -> nothing to replace (original advanced via normal reconciliation)
     *  - pending in mempool  -> may still be included: refused unless opts.force (evict is atomic in SimChain; a real node needs replace-by-fee)
     *  - absent              -> noop signed (policy-checked) at the SAME nonce; original marked expired with reason; its signer charge released
     * Idempotent: an in-flight noop for the same nonce is just advanced.
     */
    cancelNonce(walletId: string, opts?: {
        reason?: string;
        force?: boolean;
    }): Promise<CancelResult>;
    private build;
    private hash;
    /** Fill derived from receipt balance deltas — never from the quote. */
    private fillOf;
}
