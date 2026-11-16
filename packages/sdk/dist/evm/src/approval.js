import { erc20 } from './calldata.js';
export const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Returns the approve txs needed (in order), possibly empty. Approves exactly `amount` (never unlimited unless
 * explicitly allowed). `resetFirst` adds approve(0) before a non-zero top-up for USDT-style tokens.
 */
export function planApproval(token, spender, amount, currentAllowance, o = {}) {
    if (amount <= 0n)
        throw new Error('amount must be positive');
    if (amount >= MAX_UINT256 && !o.allowUnlimited)
        throw new Error('unlimited approval refused');
    if (currentAllowance >= amount)
        return [];
    const txs = [];
    if (o.resetFirst && currentAllowance > 0n)
        txs.push(erc20.approve(token, spender, 0n));
    txs.push(erc20.approve(token, spender, amount));
    return txs;
}
