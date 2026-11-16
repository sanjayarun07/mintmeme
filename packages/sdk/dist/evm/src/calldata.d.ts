export interface TxRequest {
    to: string;
    data: string;
    value: bigint;
}
export declare const erc20: {
    approve: (token: string, spender: string, amount: bigint) => TxRequest;
    /** eth_call data */
    balanceOf: (token: string, owner: string) => {
        to: string;
        data: string;
    };
    allowance: (token: string, owner: string, spender: string) => {
        to: string;
        data: string;
    };
    decodeUint: (ret: string) => bigint;
};
export interface SwapArgs {
    router: string;
    amountIn: bigint;
    amountOutMin: bigint;
    path: string[];
    to: string;
    deadline: number | bigint;
    feeOnTransfer?: boolean;
}
export declare function swapExactTokensForTokens(a: SwapArgs): TxRequest;
/** amountIn is sent as msg.value; path[0] must be the wrapped native token. */
export declare function swapExactETHForTokens(a: SwapArgs): TxRequest;
/** path[last] must be the wrapped native token. */
export declare function swapExactTokensForETH(a: SwapArgs): TxRequest;
export declare const pairCalls: {
    getReserves: (pair: string) => {
        to: string;
        data: string;
    };
    token0: (pair: string) => {
        to: string;
        data: string;
    };
};
