import type { Origin } from './types.ts';
export interface WalletPolicy {
    userId: string;
    chains: string[];
    allowedVenues: string[];
    maxPerTx: Record<string, bigint>;
    dailyLimit: Record<string, bigint>;
    destinations: string[];
    automationRevoked?: boolean;
    deviceSecret: string;
}
export interface SignRequest {
    userId: string;
    walletId: string;
    chain: string;
    kind: 'swap' | 'transfer' | 'noop' | 'approve';
    token: string;
    amount: bigint;
    venue?: string;
    to?: string;
    digest: string;
    origin: Origin;
    approval?: string;
    day: number;
}
/** Optional persistence seam for the spend ledger (survives signer restart). Values are opaque strings. */
export interface SpentLedger {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
}
export declare class MemoryLedger implements SpentLedger {
    m: Map<string, string>;
    get(k: string): string | undefined;
    set(k: string, v: string): void;
    snapshot(): string;
    static restore(s: string): MemoryLedger;
}
export declare class PolicyRejection extends Error {
}
export interface AuditEntry {
    at: number;
    walletId: string;
    kind: string;
    decision: 'allow' | 'deny';
    reason: string;
    digest: string;
}
/** Isolated signer (in-process stand-in for HSM/MPC service). Holds keys; callers get only signatures. Audits every decision. */
export declare class PolicySigner {
    private keys;
    private policies;
    private ledger;
    audit: AuditEntry[];
    /**
     * Spend accounting (daily limit): `sign` CHARGES amount against (wallet, token, day), idempotently per digest
     * (re-signing the same digest never double-charges). `release(digest)` refunds a charge and must be called ONLY when the
     * tx can never be included (rejected / expired-and-absent / nonce consumed by another tx / cancelled-replaced).
     * A charge is KEPT once the tx was included, even if it reverted: a reverted tx spent gas and its outcome was
     * economically attempted, so we stay conservative (fail-closed) rather than refunding on revert.
     * Ledger writes order: charge = spent then marker; release = marker tombstone then spent. A crash between the two
     * writes can only leave the daily counter too HIGH (fail-closed), never too low.
     */
    constructor(keys: Map<string, string>, policies: Map<string, WalletPolicy>, ledger?: SpentLedger);
    private spentOf;
    private chargeOf;
    spentFor(walletId: string, token: string, day: number): bigint;
    /** Refund the daily-limit charge of a tx that can never be included. Returns false if nothing (more) to release. */
    release(digest: string): boolean;
    static approve(deviceSecret: string, digest: string): string;
    revokeAutomation(walletId: string): void;
    sign(r: SignRequest): string;
}
