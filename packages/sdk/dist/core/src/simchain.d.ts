import type { Venue } from './types.ts';
import { CpAmm } from './venues.ts';
import type { ChainPort } from './port.ts';
/** LOCAL SIMULATED CHAIN (fixture). Not a real network. Models nonces, mempool, receipts, reverts, tax tokens, ack loss. */
export interface SimTx {
    hash: string;
    wallet: string;
    nonce: number;
    venue: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minOut: bigint;
    deadline: number;
    platformFeeBps: number;
    raw?: string;
    /** Private sending (MEV protection): undefined = the chain's default. A chain that sent it privately records true here, so a resend after a restart takes the same path. */
    mev?: boolean;
    kind?: 'swap' | 'noop' | 'approve';
    spender?: string;
}
export interface Receipt {
    hash: string;
    status: 'success' | 'reverted';
    reason?: string;
    block: number;
    deltas: Record<string, bigint>;
    network: bigint;
    platformFee: bigint;
    venueFee: bigint;
}
export interface TokenBehavior {
    buyTaxBps?: number;
    sellTaxBps?: number;
    honeypot?: boolean;
    maxTxAmount?: bigint;
    tradingOpenBlock?: number;
}
interface State {
    bal: Map<string, bigint>;
    venues: Map<string, Venue>;
}
export declare class RpcError extends Error {
}
export declare class SimChain implements ChainPort {
    id: string;
    family: string;
    block: number;
    time: number;
    finalityDepth: number;
    gasFee: bigint;
    state: State;
    tokens: Map<string, TokenBehavior>;
    mempool: Map<string, SimTx>;
    receipts: Map<string, Receipt>;
    nextNonceMap: Map<string, number>;
    failNextSubmitAck: number;
    rpcDown: boolean;
    private journal;
    constructor(id?: string, family?: string);
    credit(w: string, t: string, a: bigint): void;
    balance(w: string, t: string): bigint;
    addVenue(v: Venue): void;
    venues(): Venue[];
    balanceOf(w: string, t: string): bigint;
    confirmedNonce(w: string): number;
    /** Graduate a curve into a CP pool; token identity (address) is unchanged, venue successor recorded. */
    migrate(curveId: string): CpAmm;
    private exec;
    private cloneState;
    /** Dry run against current state; reports block it ran at (limitation: state may change before inclusion). */
    simulate(tx: SimTx): {
        block: number;
        receipt: Receipt;
    };
    submit(tx: SimTx): string;
    /** Atomically remove a still-pending tx from the mempool (replace-by-nonce step). False if it is not pending (e.g. already included). */
    evict(hash: string): boolean;
    lookup(hash: string): 'pending' | 'included' | 'none';
    receipt(hash: string): Receipt | undefined;
    confirmations(hash: string): number;
    mine(n?: number): void;
    /** Fixture: simulate a reorg dropping an included tx back to the mempool. */
    reorgDrop(hash: string): void;
    /**
     * Fixture: real reorg. Rolls state/nonces back to just before `hash` was included and puts it AND every tx included after it
     * back into the mempool (their receipts vanish). Re-mining re-executes them against the rolled-back state, so receipts may differ.
     */
    reorgReinclude(hash: string): boolean;
}
export {};
