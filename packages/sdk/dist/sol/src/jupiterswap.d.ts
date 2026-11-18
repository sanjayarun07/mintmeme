/** Jupiter swap EXECUTION for the Solana engine. Jupiter is a THIRD-PARTY service, so nothing it returns is signed blindly:
 *   1. We ask Jupiter's Swap API V2 `GET /swap/v2/build` for RAW INSTRUCTIONS (not a finished transaction) and compile the v0 message ourselves, with the
 *      address lookup tables read from the chain (the tables Jupiter claims must match the chain or we refuse).
 *   2. `gateInstructions` refuses anything outside a strict allowlist BEFORE signing (see below).
 *   3. The compiled transaction is SIMULATED against the chain and the wallet's balances are checked: output >= the engine's minOut, input <= the intent.
 *  Sources (read 2026-11-14, not recalled):
 *   - Swap API V2 base URL, `/build` request/response shape, keyless limit 0.5 requests/s, `x-api-key` header: https://developers.jup.ag/docs/swap/build/index.md and https://developers.jup.ag/docs/swap/index.md
 *   - DEX program ids Jupiter can route through (112 on the day): `GET https://api.jup.ag/swap/v2/program-id-to-label` (https://developers.jup.ag/docs/api-reference/swap/program-id-to-label.md). Fetched live and cached; if it cannot be fetched we REFUSE to trade.
 *   - Jupiter v6 swap aggregator program `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`: named in https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming.md ("the Jupiter v6 swap aggregator program"), and it is what `/build` returned as `swapInstruction.programId`.
 *  What is NOT done: no Jito/tips (tipInstruction is refused), Token-2022 associated token accounts only for mints the chain says are Token-2022, no platform fee, priority fee: the compute-unit limit is set from our simulation and the price from priorityfee.ts (or Jupiter's, capped) by SolanaChain, no `/execute` or `/submit` (we send through our own node).
 *  The gate cannot read the aggregator's instruction data, so protection for the swap itself is (a) the on-chain slippage we pass, set so Jupiter's own minimum output is >= the engine's minOut, and (b) the simulated balance check. */
import { u64le, u32le } from './tx.ts';
import type { Venue, Quote } from '../../core/src/index.ts';
export declare const JUPITER: {
    buildUrl: string;
    labelsUrl: string;
    v6: string;
    source: string;
    v6Source: string;
    labelsSource: string;
};
/** Thrown when the safety gate or a check refuses a Jupiter transaction. Never retried: the caller must treat it as a hard stop. */
export declare class JupiterRefused extends Error {
}
export interface JAccount {
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
}
export interface JIx {
    programId: string;
    accounts: JAccount[];
    data: Uint8Array;
}
export interface Table {
    key: string;
    addresses: string[];
}
/** Compile a v0 message. `tables` come from the CHAIN. Signers and program ids stay static; any other account found in a table is loaded through it. */
export declare function compileV0(payer: string, ixs: JIx[], blockhash: Uint8Array, tables: Table[]): Uint8Array;
export interface ParsedMessage {
    version: 'legacy' | 0;
    signers: number;
    readonlySigned: number;
    readonlyUnsigned: number;
    staticKeys: string[];
    blockhash: string;
    ixs: {
        programIdIndex: number;
        accountIndexes: number[];
        data: Uint8Array;
    }[];
    lookups: {
        table: string;
        writable: number[];
        readonly: number[];
    }[];
}
export declare function parseMessage(m: Uint8Array): ParsedMessage;
/** Back to instructions with flags, resolving lookup-table accounts from `tables` (chain data). */
export declare function resolveMessage(pm: ParsedMessage, tables: Table[]): JIx[];
export declare const unsignedV0: (message: Uint8Array) => Uint8Array<ArrayBuffer>;
export declare const wireV0: (message: Uint8Array, sigs: Uint8Array[]) => Uint8Array<ArrayBuffer>;
/** Address lookup table account: 56-byte header, then 32-byte addresses. A table being deactivated cannot be trusted to keep its contents. */
export declare function decodeTable(key: string, data: Buffer): Table;
export interface JupCfg {
    buildUrl?: string;
    labelsUrl?: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    maxPriorityLamports?: bigint;
    maxComputeUnits?: number;
    dexes?: string[];
    maxAccounts?: number;
}
export interface BuildResponse {
    inAmount: bigint;
    outAmount: bigint;
    minOut: bigint;
    slippageBps: number;
    priceImpactPct: number;
    ixs: JIx[];
    swapIndex: number;
    claimedTables: Table[];
    routeLabels: string[];
}
/** Program ids Jupiter's own endpoint lists as routable DEXes. */
export declare function fetchRoutableProgramIds(c?: JupCfg): Promise<Set<string>>;
export declare function fetchBuild(o: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker: string;
    slippageBps: number;
} & JupCfg): Promise<BuildResponse>;
export interface GateCtx {
    wallet: string;
    wsol: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    allowedPrograms: Set<string>;
    maxPriorityLamports: bigint;
    maxComputeUnits: number; /** The one tip transfer we added ourselves (Jito): exactly this destination and at most this amount. */
    tip?: {
        to: string;
        maxLamports: bigint;
    }; /** Fee transfers we added ourselves (fee sharing): exactly these destinations and amounts. */
    fees?: {
        to: string;
        lamports: bigint;
    }[];
    /** Mints whose account the chain says is owned by Token-2022: their associated token account is created with that program. */ token2022?: Set<string>;
}
export interface GateResult {
    createdTokenAccounts: string[];
    createdNonWsol: number;
    computeUnitLimit: number;
    priorityLamports: bigint;
    swapIndex: number;
}
/** Refuses every instruction that is not one of the few shapes a swap legitimately needs. `ixs` is what will be SIGNED (resolved from the final message), in order. */
export declare function gateInstructions(ixs: JIx[], c: GateCtx): GateResult;
/** Accounts the route instruction writes that might be the wallet's token accounts: the chain is asked who owns them. */
export declare function walletTokenAccountsAtRisk(route: JIx, wallet: string, allowed: Set<string>, owned: (addr: string) => boolean): string[];
/** A Jupiter route for ONE direction of ONE pair, as a reference snapshot: quote(amount) scales the snapshot linearly (optimistic for large sizes). The REAL route is re-quoted at the exact
 *  amount when the transaction is built, and refused if it cannot meet the engine's minOut, so a stale or optimistic snapshot can cost a retry but never a worse fill. */
export declare class JupiterVenue implements Venue {
    id: string;
    inMint: string;
    outMint: string;
    wsol: string;
    refIn: bigint;
    refOut: bigint;
    impactBps: number;
    slot: number;
    kind: 'cpamm';
    status: 'active' | 'graduated';
    successor?: string;
    family: string;
    constructor(id: string, inMint: string, outMint: string, wsol: string, refIn: bigint, refOut: bigint, impactBps: number, slot?: number);
    private res;
    supports(a: string, b: string): boolean;
    quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
    spotPriceE18(a: string, b: string): bigint;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    clone(): JupiterVenue;
}
export { u64le, u32le };
