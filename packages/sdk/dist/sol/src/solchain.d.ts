/** SolanaChain: a `ChainPort` over Solana JSON-RPC, so the SAME Engine, Router, OrderRunner, CopyRunner and SnipeRunner can drive Solana.
 *  What differs from the EVM port, and how it is mapped:
 *   - No nonce. Replay protection is the recent blockhash plus a unique signature. `confirmedNonce` returns 0, so the engine's nonce is only a LOCAL sequence
 *     (it is never compared with the chain). The transaction id is its first signature (base58); resubmitting identical bytes is idempotent at the node.
 *   - Validity is a blockhash window. A tx that is absent after its blockhash expired can never land: resubmitting it is rejected by the node and the engine fails
 *     the record (and releases its limit charge). The engine does NOT rebuild with a fresh blockhash; a new intent is needed. Fails closed.
 *   - No allowances: `needsApproval` is always undefined. Wrapped SOL is created, synced and closed inside the swap transaction, so a wallet's native SOL is spent and
 *     received directly. Associated token accounts for the output token are created inside the same transaction (their rent is reported as network cost).
 *   - Finality is Solana's own: `confirmations` reports the finalityDepth when the signature is `finalized`, else the node's confirmation count (capped below it).
 *   - Fills come from the transaction's pre/post balances for the wallet (lamports and token balances), never from the quote.
 *   - Platform fees are paid in SOL to the configured fee wallets inside the swap's own transaction (cfg.fees, priorityfee.ts feeTransfers). Pending-tx cancellation is not offered (no `evict`).
 *   - Signing is injected (`SolSigner`); the repo ships a dev-only ed25519 signer for throwaway keys. Custody is out of scope.
 *   - Only Raydium AMM v4 pools (constant-product) are supported; no CLMM/CPMM/Orca/Meteora, pump.fun bonding curves only through the `pump` option (SOL <-> token, curve not complete, no mayhem or cashback coins), no routing across pools, no Token-2022 transfer-fee accounting. */
import type { ChainPort, SimTx, Receipt, Venue } from '../../core/src/index.ts';
import type { SolRpc } from './raydium.ts';
import type { SolSigner } from './signer.ts';
import type { JupCfg } from './jupiterswap.ts';
import type { RfqCfg } from './jupiterz.ts';
import type { TxSubmitter } from './submitter.ts';
import type { PriorityConfig, FeeRecipient } from './priorityfee.ts';
/** Thrown by an RPC when the node ANSWERED with a JSON-RPC error object. Anything else thrown is a transport failure (the ack may be lost). */
export declare class SolJsonRpcError extends Error {
    data?: any;
    constructor(message: string, data?: any);
}
/** Plain fetch JSON-RPC client (no read-only allowlist: use only against a node you control, e.g. a local test validator). */
export declare class SolJsonRpc implements SolRpc {
    private url;
    private fetchFn;
    n: number;
    constructor(url: string, fetchFn?: typeof fetch);
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
export interface SolChainConfig {
    id: string;
    wsol: string; /** Raydium AMM v4 program for pools added later (sniping); defaults to the first configured pool's program */
    program?: string;
    pools: {
        id: string;
        program: string;
    }[];
    computeUnitLimit?: number;
    priorityMicroLamports?: bigint;
    finalityDepth?: number;
    /** Automatic priority fees (priorityfee.ts): price from recent fees on the trade's accounts, limit from simulation, total capped. Unset: the fixed `priorityMicroLamports` (default none) and Jupiter's own price. */
    priority?: PriorityConfig;
    /** With a tipping submitter (Jito): send privately unless a trade says otherwise. Default true. */
    mevDefault?: boolean;
    /** Fee sharing: who receives the platform fee (priorityfee.ts feeTransfers). Read at every trade. Fee wallets must already exist on chain (hold SOL). */
    fees?: () => FeeRecipient[];
    /** Jupiter routes the engine may use. `pairs` are directions (a pair needs one entry per direction); `refAmount` is the size of the quote snapshot used for estimates. */
    /** pump.fun bonding curves to track, by mint. Only curves we can trade (not complete, not mayhem or cashback) become tradable venues; the rest are loaded with the reason they are not. */
    pump?: {
        mints: string[];
    };
    jupiter?: JupCfg & {
        quoteUrl?: string;
        pairs: {
            inMint: string;
            outMint: string;
            refAmount: bigint;
        }[];
    };
    /** How signed transactions are sent (default: the node's sendTransaction). A tip-paying submitter such as Jito adds its tip instruction to curve and Raydium transactions; Jupiter-built transactions are sent through the plain node instead (their instruction list is Jupiter's). */
    submitter?: TxSubmitter;
    /** JupiterZ RFQ fills for large orders (jupiterz.ts, docs/JUPITERZ.md). Off unless set. Chosen per trade only when one side of the trade is SOL (at least `minLamports`)
     *  or a quote asset listed in `minQuote` (mint -> smallest raw amount on that side, for example USDC: market makers quote stocks closest against USDC), the trade
     *  carries no platform fee, and the maker's output beats Jupiter's /build route by `marginBps`. `checkFill` may refuse the RFQ output (the stock share-price check). */
    jupiterz?: RfqCfg & {
        minLamports: bigint;
        minQuote?: Record<string, bigint>;
        marginBps: number;
        maxExpirySec?: number;
        checkFill?: (tx: SimTx, outAmount: bigint) => Promise<string | undefined>;
        log?: (m: string) => void;
    };
}
/** Solana's limit on a signed transaction, and how a too-large Jupiter route is retried with fewer accounts. */
export declare const TX_MAX_BYTES = 1232;
export declare class SolanaChain implements ChainPort {
    private rpc;
    private signer;
    id: string;
    family: string;
    time: number;
    block: number;
    finalityDepth: number;
    state: {
        venues: Map<string, Venue>;
    };
    private keys;
    private rent?;
    private cfg;
    private tipped;
    private fees?;
    /** Signatures this process sent recently. Solana has no mempool query, so a just-sent tx is not visible for a moment: report it as pending instead of absent (avoids pointless identical resends). */
    private sentAt;
    static VISIBILITY_GRACE_MS: number;
    /** Set when the last Jupiter quote refresh failed (the Jupiter venue is then absent, so routing falls back to other venues). */
    jupiterError?: string;
    /** RFQ trades by the user's own signature (the engine's hash for them): the request to resend, when the quote expires, and the landed signature once known. */
    private rfq;
    /** Why the last trade did not use JupiterZ (or that it did), for the test UI and logs. */
    rfqNote?: string;
    constructor(cfg: SolChainConfig, rpc: SolRpc, signer: SolSigner);
    venues(): Venue[];
    /** Add a pool to track. SnipeRunner passes `{ id, pair }`; the program defaults to the first configured pool's program. */
    addPool(p: {
        id: string;
        program?: string;
        pair?: string;
    }): void;
    removePool(id: string): void;
    private rpcCall;
    refresh(what: 'head' | 'venues'): Promise<void>;
    /** Add a pump.fun curve to track (for example from a launch stream). */
    addCurve(mint: string): void;
    removeCurve(mint: string): void;
    private refreshPump;
    private pumpInstructions;
    /** Make ANY token tradable: look for a live pump.fun bonding curve and for a Jupiter route, and track whichever exist. Read-only (quotes and account reads). The Router then picks the best quote among the venues.
     *  Jupiter venues are priced from one reference quote each (buy `refLamports` of SOL, and sell back what that returned), so quotes for much larger sizes are an estimate and the real route is built again at trade time. */
    addToken(mint: string, o?: {
        refLamports?: bigint;
    }): Promise<{
        pump: boolean;
        jupiter: boolean;
        notes: string[];
    }>;
    private refreshJupiter;
    /** Registered stock mints (xstocks.ts) whose issuer pause is on, read at most every 15 s. A failed read pauses nothing here: the build re-reads and refuses a paused mint. */
    private pauseRead?;
    private pausedStocks;
    private loadKeys;
    confirmedNonce(): Promise<number>;
    balanceOf(wallet: string, token: string): Promise<any>;
    needsApproval(): Promise<undefined>;
    private res;
    /** Instructions for a SimTx. Throws if it cannot be built (unknown venue, platform fee requested). */
    private instructions;
    /** The fee transfers for this trade (none without a platform fee). A sell pays from the SOL it receives, so only SOL-in or SOL-out trades can carry one. */
    private feeSplit;
    private jupVenue;
    private accountsAt;
    /** Ask Jupiter for the route, compile it ourselves, run the safety gate on the exact bytes to be signed, then SIMULATE and check the wallet's balances. Throws JupiterRefused to stop. */
    /** `maxAccounts`: set when a route came out too large for one transaction and Jupiter is asked again for a simpler one (see the size check below). */
    private buildJupiter;
    simulate(tx: SimTx): Promise<{
        block: number;
        receipt: {
            hash: string;
            status: 'success' | 'reverted';
            reason?: string;
            block: number;
            network: bigint;
            platformFee: bigint;
            venueFee: bigint;
            deltas: {
                [x: string]: bigint;
            };
        };
    }>;
    prepare(tx: SimTx): Promise<{
        raw: string;
        hash: string;
    }>;
    /** Whether this transaction goes privately through a tipping submitter (Jito): the trade's own choice, else the chain default (`mevDefault`, default on when such a
     *  submitter is configured). The choice is written on the transaction, which the engine stores with its signed bytes, so a resend after a restart uses the same path. */
    private privateSend;
    /** pump.fun and Raydium: the limit from a simulation (units used x 1.2; the configured limit if it cannot be simulated) and the price from recent fees on the accounts
     *  this trade writes, capped (priorityfee.ts). An estimate that cannot be read falls back to the floor price. */
    private withPriority;
    submit(tx: SimTx): Promise<string>;
    private status;
    lookup(hash: string): Promise<"included" | "none" | "pending">;
    confirmations(hash: string): Promise<number>;
    /** An RFQ fill for this trade if it is eligible and beats /build by the margin: gated, simulated and signed by the user's wallet (never sent here). Undefined: use /build. */
    private tryRfq;
    /** Send an RFQ trade through Jupiter's /execute. Identical bytes every time, so it lands at most once. A failure is final only once the quote can no longer land
     *  (chain time past expireAt) and the transaction is not on chain; before that it is treated like a lost ack (RpcError), so the engine looks again instead of failing it. */
    private submitRfq;
    /** The landed signature for a hash: the hash itself for ordinary transactions; for RFQ trades /execute's signature, or the wallet's recent transaction that carries our signature. */
    private resolve;
    /** Forget RFQ trades whose quote expired over a day ago: the engine has booked or failed them long since. */
    private pruneRfq;
    /** The token program that owns each mint (classic Token unless the chain says Token-2022). Cached: a mint never changes program. */
    private tokenPrograms;
    private mintProgram;
    private rentExempt;
    private rentBySize;
    private rentFor;
    /** Receipt -> the wallet's balance deltas. NATIVE = lamports, so it includes the fee and any rent paid; `network` = fee + rent of token accounts the tx created and left open. */
    receipt(hash: string): Promise<Receipt | undefined>;
}
