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
import type { RelayClient, RelayContracts } from './relay.ts';
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
    /** Relay same-chain routes (relay.ts): tokens without a V2 pool (Base: Coinbase stocks on Aerodrome Slipstream / Uniswap V3-V4). Every transaction is gated against
     *  the pinned Relay contracts (`contracts`, default RELAY_BASE) and simulated with eth_simulateV1 before it is signed. `refreshMs` (default 15 s): reference quote age.
     *  `refWallet`: the address quotes are asked for when no trade is being built (Relay wants a user; quotes are read-only). */
    relay?: {
        client: RelayClient;
        contracts?: RelayContracts;
        refreshMs?: number;
        refWallet?: string;
        pairs?: {
            tokenIn: string;
            tokenOut: string;
            refAmount: bigint;
        }[];
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
    aggError?: string;
    private aggAt;
    private settler?;
    private relayK;
    /** The contract that must be approved for a token-in Relay swap (its approval proxy). */
    private aggRouter;
    private aggId;
    /** Reference quotes for the configured pairs, at most every `refreshMs`. A pair that cannot be quoted has no venue until it can (orders on it wait). */
    private refreshAgg;
    /** Make a token tradable through Relay: ETH -> token for `refWei`, and back for what that returned. Read-only (quotes). Returns false when there is no route. */
    addAggToken(token: string, refWei?: bigint): Promise<boolean>;
    /** Quote the Relay swap for `tx`, gate it, check any 0x Settler against 0x's registry, and simulate it (with an exact approve first if the allowance is short). */
    private aggBuild;
    private aggVenue;
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
        receipt: {
            hash: string;
            status: 'success' | 'reverted';
            reason?: string;
            block: number;
            network: bigint;
            platformFee: bigint;
            venueFee: bigint;
            deltas: {
                [tx.tokenOut]: bigint;
            };
        };
    }>;
    prepare(tx: SimTx): Promise<{
        raw: string;
        hash: string;
    }>;
    submit(tx: SimTx): Promise<string>;
    lookup(hash: string): Promise<"included" | "none" | "pending">;
    confirmations(hash: string): Promise<number>;
    /** Receipt -> balance deltas for the wallet: ERC-20 Transfer logs, WETH Withdrawal logs from the router (native out), tx value and gas (native). */
    /** What the wallet's OTHER transactions in block `n` cost it in ETH, when each can only have cost ETH (gas and L1 fee; a self-send gets its value back): an ERC-20 approve, or a self-send
     *  (the engine's cancel). Any other transaction might have paid ETH in internally, so the Relay swap's ETH change cannot be separated: RpcError (looked at again later). */
    private otherTxsCost;
    receipt(hash: string): Promise<Receipt | undefined>;
}
