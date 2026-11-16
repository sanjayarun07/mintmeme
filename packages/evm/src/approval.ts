import { erc20, type TxRequest } from './calldata.ts';

export const MAX_UINT256 = (1n << 256n) - 1n;
export interface ApprovalOpts { allowUnlimited?: boolean; resetFirst?: boolean }

/**
 * Returns the approve txs needed (in order), possibly empty. Approves exactly `amount` (never unlimited unless
 * explicitly allowed). `resetFirst` adds approve(0) before a non-zero top-up for USDT-style tokens.
 */
export function planApproval(token: string, spender: string, amount: bigint, currentAllowance: bigint, o: ApprovalOpts = {}): TxRequest[] {
  if (amount <= 0n) throw new Error('amount must be positive');
  if (amount >= MAX_UINT256 && !o.allowUnlimited) throw new Error('unlimited approval refused');
  if (currentAllowance >= amount) return [];
  const txs: TxRequest[] = [];
  if (o.resetFirst && currentAllowance > 0n) txs.push(erc20.approve(token, spender, 0n));
  txs.push(erc20.approve(token, spender, amount));
  return txs;
}
