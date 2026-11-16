import { encodeCall, decodeParams, normAddr } from './abi.js';
// ---- ERC20 ----
export const erc20 = {
    approve: (token, spender, amount) => ({ to: normAddr(token), data: encodeCall('approve(address,uint256)', [spender, amount]), value: 0n }),
    /** eth_call data */
    balanceOf: (token, owner) => ({ to: normAddr(token), data: encodeCall('balanceOf(address)', [owner]) }),
    allowance: (token, owner, spender) => ({ to: normAddr(token), data: encodeCall('allowance(address,address)', [owner, spender]) }),
    decodeUint: (ret) => decodeParams(['uint256'], ret)[0],
};
const fot = (name, f) => name + (f ? 'SupportingFeeOnTransferTokens' : '');
function checkPath(p) { if (p.length < 2)
    throw new Error('path needs >= 2 tokens'); p.forEach(normAddr); }
export function swapExactTokensForTokens(a) {
    checkPath(a.path);
    return { to: normAddr(a.router), value: 0n,
        data: encodeCall(`${fot('swapExactTokensForTokens', a.feeOnTransfer)}(uint256,uint256,address[],address,uint256)`, [a.amountIn, a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}
/** amountIn is sent as msg.value; path[0] must be the wrapped native token. */
export function swapExactETHForTokens(a) {
    checkPath(a.path);
    return { to: normAddr(a.router), value: a.amountIn,
        data: encodeCall(`${fot('swapExactETHForTokens', a.feeOnTransfer)}(uint256,address[],address,uint256)`, [a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}
/** path[last] must be the wrapped native token. */
export function swapExactTokensForETH(a) {
    checkPath(a.path);
    return { to: normAddr(a.router), value: 0n,
        data: encodeCall(`${fot('swapExactTokensForETH', a.feeOnTransfer)}(uint256,uint256,address[],address,uint256)`, [a.amountIn, a.amountOutMin, a.path, a.to, BigInt(a.deadline)]) };
}
// ---- V2 pair ----
export const pairCalls = {
    getReserves: (pair) => ({ to: normAddr(pair), data: encodeCall('getReserves()', []) }),
    token0: (pair) => ({ to: normAddr(pair), data: encodeCall('token0()', []) }),
};
