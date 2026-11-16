import type { Family } from './types.ts';
/**
 * Chain-family adapter seam + FIXTURE SIMULATORS.
 * *** EVERYTHING BELOW THE INTERFACE IS SIMULATED. No RPC, no real chain ids, addresses or endpoints. ***
 * Numeric parameters (windows, depths, prices) are fixture assumptions chosen to exercise semantics, not protocol constants.
 */
export type Landing = 'unknown' | 'pending' | 'processed' | 'confirmed' | 'finalized' | 'failed' | 'expired';
export type ReconcileAction = 'already_landed' | 'wait' | 'rebroadcast_same' | 'safe_to_rebuild' | 'investigate';
export interface ReconcileAdvice {
    action: ReconcileAction;
    reasons: string[];
    checks: string[];
}
export interface SubmitResult {
    accepted: boolean;
    id: string;
    error?: string;
    duplicate?: boolean;
}
export interface ModelDescription {
    account: string;
    validity: string;
    fee: string;
    finality: string;
    asyncDelivery: boolean;
}
/** What differs per family, behind one seam. `reconcile` = what to check BEFORE rebuilding after an uncertain submission. */
export interface ChainAdapter<Tx> {
    readonly family: Family;
    readonly simulated: true;
    readonly model: ModelDescription;
    now(): number;
    isExpired(tx: Tx): boolean;
    submit(tx: Tx): SubmitResult;
    status(id: string): {
        landing: Landing;
        native: string;
        note?: string;
    };
    reconcile(tx: Tx): ReconcileAdvice;
}
export declare class SimRpcError extends Error {
}
export type SolCommitment = 'processed' | 'confirmed' | 'finalized';
export interface SolTx {
    signature: string;
    payer: string;
    payload: string;
    blockhash: string;
    lastValidBlockHeight: number;
    computeUnits: number;
    priorityMicroLamportsPerCu: number;
}
export declare class SimulatedSolana implements ChainAdapter<SolTx> {
    readonly family: 'solana';
    readonly simulated: true;
    readonly model: {
        account: string;
        validity: string;
        fee: string;
        finality: string;
        asyncDelivery: boolean;
    };
    height: number;
    blockhashWindow: number;
    confirmDepth: number;
    finalizeDepth: number;
    baseFee: number;
    blockCapacity: number;
    rpcDown: boolean;
    dropAcks: number;
    private bhIssued;
    private pending;
    private landed;
    now(): number;
    latestBlockhash(): {
        blockhash: string;
        lastValidBlockHeight: number;
    };
    /** Signature is content-addressed: identical content+blockhash => identical signature (dedup). Changing fee/blockhash => NEW signature. */
    build(o: {
        payer: string;
        payload: string;
        blockhash?: {
            blockhash: string;
            lastValidBlockHeight: number;
        };
        computeUnits?: number;
        priority?: number;
    }): SolTx;
    fee(tx: SolTx): number;
    isExpired(tx: SolTx): boolean;
    submit(tx: SolTx): SubmitResult;
    /** Produce n blocks; leader includes up to blockCapacity pending txs by priority fee; expired ones are dropped, never land. */
    advance(n?: number): void;
    landedWithPayload(payload: string): string[];
    status(sig: string): {
        landing: Landing;
        native: string;
        note?: string;
    };
    meets(sig: string, c: SolCommitment): boolean;
    reconcile(tx: SolTx): ReconcileAdvice;
}
export interface TonExt {
    msgHash: string;
    wallet: string;
    seqno: number;
    validUntil: number;
    dest: string;
    amount: number;
    destFails?: boolean;
}
export type TonNative = 'not_accepted' | 'accepted_by_wallet' | 'executed' | 'bounced';
export declare class SimulatedTon implements ChainAdapter<TonExt> {
    readonly family: 'ton';
    readonly simulated: true;
    readonly model: {
        account: string;
        validity: string;
        fee: string;
        finality: string;
        asyncDelivery: boolean;
    };
    time: number;
    executionDelayS: number;
    finalitySeconds: number;
    rpcDown: boolean;
    dropAcks: number;
    private seqno;
    private accepted;
    now(): number;
    walletSeqno(w: string): number;
    build(o: {
        wallet: string;
        dest: string;
        amount: number;
        validForS?: number;
        destFails?: boolean;
        seqno?: number;
    }): TonExt;
    isExpired(m: TonExt): boolean;
    submit(m: TonExt): SubmitResult;
    advance(seconds?: number): void;
    native(id: string): TonNative;
    status(id: string): {
        landing: Landing;
        native: string;
        note?: string;
    };
    reconcile(m: TonExt): ReconcileAdvice;
}
export interface TronTx {
    txId: string;
    owner: string;
    payload: string;
    bytes: number;
    energyRequired: number;
    feeLimitSun: number;
    expiration: number;
    refBlock: number;
}
export type TronNative = 'not_found' | 'pending' | 'in_block' | 'solidified' | 'out_of_energy';
export declare class SimulatedTron implements ChainAdapter<TronTx> {
    readonly family: 'tron';
    readonly simulated: true;
    readonly model: {
        account: string;
        validity: string;
        fee: string;
        finality: string;
        asyncDelivery: boolean;
    };
    block: number;
    time: number;
    blockTimeS: number;
    solidifyDepth: number;
    refBlockWindow: number;
    energyPriceSun: number;
    bandwidthPriceSun: number;
    rpcDown: boolean;
    dropAcks: number;
    private res;
    private pending;
    private incl;
    now(): number;
    setResources(owner: string, freeBandwidth: number, energy: number): void;
    build(o: {
        owner: string;
        payload: string;
        bytes?: number;
        energyRequired?: number;
        feeLimitSun?: number;
        validForS?: number;
    }): TronTx;
    isExpired(t: TronTx): boolean;
    submit(t: TronTx): SubmitResult;
    advance(n?: number): void;
    private execute;
    receipt(id: string): {
        block: number;
        ok: boolean;
        burnedSun: number;
        energyUsed: number;
        bandwidthUsed: number;
    } | undefined;
    native(id: string): TronNative;
    status(id: string): {
        landing: Landing;
        native: string;
        note?: string;
    };
    reconcile(t: TronTx): ReconcileAdvice;
}
