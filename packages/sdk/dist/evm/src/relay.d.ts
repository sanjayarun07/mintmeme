export interface RelayContracts {
    router: string;
    approvalProxy: string;
    solver: string;
}
/** Base mainnet (chain 8453), Relay v3.2 contracts as Relay's chains API lists them. */
export declare const RELAY_BASE: RelayContracts;
export declare const RELAY_SEL: {
    readonly multicall: '0xcd6e13f7';
    readonly transferAndMulticall: '0xf9e4bab4';
    readonly cleanupNative: '0xa6bd8c96';
    readonly cleanupErc20s: '0x9bb43718';
    readonly approve: '0x095ea7b3';
};
/** Engine token ('NATIVE' or 0x address) as Relay writes it. */
export declare const rAddr: (t: string) => string;
/** Relay could not answer right now (rate limited, a server error, unreachable): transient, so a trade waits and retries instead of failing. Other quote errors are final. */
export declare class RelayUnavailable extends Error {
}
export interface RelayStep {
    id: string;
    to: string;
    data: string;
    value: bigint;
}
export interface RelayQuote {
    requestId: string;
    amountOut: bigint;
    minimumOut: bigint;
    relayerFeeWei: bigint;
    steps: RelayStep[];
}
export declare class RelayClient {
    private o;
    constructor(o: {
        chainId: number;
        apiKey?: string;
        baseUrl?: string;
        fetchFn?: typeof fetch;
        timeoutMs?: number; /** Retries after HTTP 429 (default 3, waiting 2, 4 and 8 s). Keyless use is rate limited; pass an API key in production. */
        retries429?: number;
    });
    /** A same-chain EXACT_INPUT quote for `wallet` (sender and recipient). Read-only. */
    quote(wallet: string, tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps?: number): Promise<RelayQuote>;
}
interface Call {
    target: string;
    value: bigint;
    data: string;
}
/** The router's multicall, or the approval proxy's transferAndMulticall: pulled tokens and amounts (none for multicall), the inner calls, the refund address. */
export declare function decodeRelaySwap(data: string): {
    kind: 'multicall';
    tokens: string[];
    amounts: bigint[];
    calls: Call[];
    refundTo: string;
    nftRecipient: string;
} | {
    kind: 'transferAndMulticall';
    tokens: string[];
    amounts: bigint[];
    calls: Call[];
    refundTo: string;
    nftRecipient: string;
};
/** 0x as an inner route: `AllowanceHolder.exec(operator, token, amount, target, data)` into a 0x Settler, whose `execute((recipient, buyToken, minAmountOut), actions[], zid)`
 *  carries the on-chain minimum. Settlers are redeployed over time; the current one is `ownerOf(2)` (feature 2, taker-submitted) on 0x's Deployer registry, which the chain
 *  checks before signing (`verifySettler`). On Base, 2026-11-18, ownerOf(2) = 0x1035...21a8, the Settler Relay's routes used. */
export declare const ZEROX: {
    readonly allowanceHolder: '0x0000000000001ff3684f28c67538d4d072c22734';
    readonly deployer: '0x00000000000004533fe15556b1e086bb1a72ceae';
    readonly feature: 2n;
    readonly exec: '0x2213bc0b';
    readonly settlerExecute: '0x1fff991f';
    readonly eth: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
};
/** IceCreamSwap's `AggregatorGuard` as an inner route (verified source on Sourcify, Base 0xc87de04e...fc3d, solc 0.8.26): `IceCreamSwap()` with PACKED calldata
 *  (after the selector: id u16 @4, executor @6, amountIn u128 @26, minAmountOut u128 @42, firstTokenReceiver @59, recipient @79, tokenIn @99, tokenOut @119). It runs the
 *  executor, then measures the RECIPIENT's balance change and reverts with "Insufficient output" below minAmountOut: an on-chain minimum we can read. */
export declare const ICECREAM_GUARD: {
    readonly address: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d';
    readonly selector: '0x3f0bde25';
};
/** The current 0x Settler from 0x's on-chain registry (ownerOf(feature)), for comparing with the one a route calls. */
export declare function currentSettler(rpc: {
    call<T = any>(m: string, p?: unknown[]): Promise<T>;
}): Promise<string>;
export interface RelayCtx {
    wallet: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    minOut: bigint;
    contracts: RelayContracts; /** Most ETH Relay may take as its fee (default: 1% of the ETH side of the trade, at least 0.0001 ETH). */
    maxFeeWei?: bigint;
}
/** Refuses a Relay quote unless its transactions are exactly the swap the engine intends. Returns the swap step (the one to sign) and the fee Relay takes. */
export declare function gateRelay(steps: RelayStep[], c: RelayCtx): {
    swap: RelayStep;
    feeWei: bigint; /** A 0x Settler the route calls: the caller must check it is the registry's current one. */
    settler?: string;
};
export {};
