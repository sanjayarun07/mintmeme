import { encodeCall, decodeParams, normAddr } from './abi.ts';

export interface TxRequest { to: string; data: string; value: bigint }

// ---- ERC20 ----
export const erc20 = {
  approve: (token: string, spender: string, amount: bigint): TxRequest =>
    ({ to: normAddr(token), data: encodeCall('approve(address,uint256)', [spender, amount]), value: 0n }),
  /** eth_call data */
  balanceOf: (token: string, owner: string) => ({ to: normAddr(token), data: encodeCall('balanceOf(address)', [owner]) }),
  allowance: (token: string, owner: string, spender: string) =>
    ({ to: normAddr(token), data: encodeCall('allowance(address,address)', [owner, spender]) }),
  decodeUint: (ret: string): bigint => decodeParams(['uint256'], ret)[0] as bigint,
};

// ---- V2 router ----
export interface SwapArgs { router: string; amountIn: bigint; amountOutMin: bigint; path: string[]; to: string; deadline: number | bigint; feeOnTransfer?: boolean }
const fot = (name: string, f?: boolean) => name + (f ? 'SupportingFeeOnTransferTokens' : '');
function checkPath(p: string[]) { if (p.length < 2) throw new Error('path needs >= 2 tokens'); p.forEach(normAddr); }

export function swapExactTokensForTokens(a: SwapArgs): TxRequest {
  checkPath(a.path);
  return { to: normAddr(a.router), value: 0n,
    data: encodeCall(`${fot('swapExactTokensForTokens', a.feeOnTransfer)}(uint256,uint256,address[],address,uint256)`, [a.amountIn, a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}
/** amountIn is sent as msg.value; path[0] must be the wrapped native token. */
export function swapExactETHForTokens(a: SwapArgs): TxRequest {
  checkPath(a.path);
  return { to: normAddr(a.router), value: a.amountIn,
    data: encodeCall(`${fot('swapExactETHForTokens', a.feeOnTransfer)}(uint256,address[],address,uint256)`, [a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}
/** path[last] must be the wrapped native token. */
export function swapExactTokensForETH(a: SwapArgs): TxRequest {
  checkPath(a.path);
  return { to: normAddr(a.router), value: 0n,
    data: encodeCall(`${fot('swapExactTokensForETH', a.feeOnTransfer)}(uint256,uint256,address[],address,uint256)`, [a.amountIn, a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}

// ---- V2 pair ----
export const pairCalls = {
  getReserves: (pair: string) => ({ to: normAddr(pair), data: encodeCall('getReserves()', []) }),
  token0: (pair: string) => ({ to: normAddr(pair), data: encodeCall('token0()', []) }),
};
