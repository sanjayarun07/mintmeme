/** EvmRpcChain: a ChainPort over JSON-RPC for an EVM node, trading on Uniswap-V2-style pools through a V2 router.
 *  Intents use LOWERCASE token addresses (or 'NATIVE'); walletId is the lowercase 0x address of the signing wallet.
 *  Scope and honesty:
 *   - Platform fees are collected on-chain ONLY through a configured FeeRouter contract (contracts/FeeRouter.sol, unaudited): the fee is a share of the input, taken atomically. Without `feeRouter` any tx with platformFeeBps > 0 is refused rather than booked as if collected.
 *   - A sell (token -> NATIVE/token) first runs an exact-amount approve(router, amountIn) as its own tracked child transaction when the allowance is too low (never unlimited).
 *     Tokens that need the allowance reset to 0 first (USDT-style) are handled when `resetApprovalFirst` is set: approve(0), then the exact amount. Without it their approve fails visibly.
 *   - Cancelling a PENDING tx is replace-by-fee (`replaceByFee`, no `evict`): a higher-fee no-op with the same nonce is sent; either the original or the no-op lands, and the engine reconciles both.
 *   - Signing is injected (RawSigner). In this repo it is a dev-only signer for throwaway local keys; custody/HSM is out of scope. */
import type { ChainPort, SimTx, Receipt, Venue } from '../../core/src/index.ts';
import type { FeeSpec } from './v2.ts';
/** Thrown by an RpcLike when the node answered with a JSON-RPC error object. Anything else thrown is treated as a transport failure (ack may be lost). */
export declare class JsonRpcError extends Error {
}
export interface RpcLike {
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
export interface Eip1559Request {
    wallet: string;
    to: string;
    data: string;
    value: bigint;
    nonce: number;
    chainId: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}
/** Signs a prepared transaction. May be async so a custody service, HSM or MPC cluster can sit behind it (see HttpSigner). */
export interface RawSigner {
    sign(req: Eip1559Request): string | Promise<string>;
}
export interface EvmRpcConfig {
    id: string;
    chainId: number;
    router: string;
    weth: string;
    pools: {
        id: string;
        pair: string;
    }[];
    finalityDepth?: number;
    family?: string; /** pool fee as num/den of the input kept (default 997/1000 = 0.3%); PancakeSwap V2 differs, so set it from the router's own getAmountsOut */
    fee?: FeeSpec;
    feeOnTransfer?: boolean; /** Tokens like USDT refuse to change a non-zero allowance: approve(0) first, then the exact amount (two tracked child transactions). */
    resetApprovalFirst?: boolean;
    /** On-chain platform fee: trades with platformFeeBps > 0 go through this FeeRouter (see contracts/FeeRouter.sol). `bps` must equal the contract's immutable feeBps. Native <-> token trades only. */
    feeRouter?: {
        address: string;
        bps: number;
    };
}
export declare function decodeRevert(data: string | undefined): string | undefined;
export declare class EvmRpcChain implements ChainPort {
    private cfg;
    private rpc;
    private signer;
    id: string;
    family: string;
    time: number;
    block: number;
    finalityDepth: number;
    replaceByFee: boolean;
    state: {
        venues: Map<string, Venue>;
    };
    constructor(cfg: EvmRpcConfig, rpc: RpcLike, signer: RawSigner);
    venues(): Venue[];
    /** Register another pool (e.g. a freshly created launch pair). Loaded on the next refresh('venues'). Idempotent per id. */
    addPool(p: {
        id: string;
        pair: string;
    }): void;
    /** Forget a pool (e.g. a launch pair whose creation was reorged out: loading it would fail every refresh). */
    removePool(id: string): void;
    private ethCall;
    /** a pair's tokens never change, so after the first load a pool reload is one eth_call (reserves), not three */
    private pairTokens;
    refresh(what: 'head' | 'venues'): Promise<void>;
    balanceOf(wallet: string, token: string): Promise<bigint>;
    confirmedNonce(wallet: string): Promise<number>;
    /** Calldata for a SimTx (swap or noop). */
    private request;
    private zero;
    /** A sell needs `router` allowance >= amountIn. Returns the EXACT amount to approve (unlimited is refused by planApproval), or undefined when already enough. */
    needsApproval(tx: SimTx): Promise<{
        token: string;
        spender: string;
        amount: bigint;
    } | undefined>;
    simulate(tx: SimTx): Promise<{
        block: number;
        receipt: Receipt;
    }>;
    prepare(tx: SimTx): Promise<{
        raw: string;
        hash: string;
    }>;
    submit(tx: SimTx): Promise<string>;
    lookup(hash: string): Promise<"included" | "none" | "pending">;
    confirmations(hash: string): Promise<number>;
    /** Receipt -> balance deltas for the wallet: ERC-20 Transfer logs, WETH Withdrawal logs from the router (native out), tx value and gas (native). */
    receipt(hash: string): Promise<Receipt | undefined>;
}
