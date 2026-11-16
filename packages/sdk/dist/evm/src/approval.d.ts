import { type TxRequest } from './calldata.ts';
export declare const MAX_UINT256: bigint;
export interface ApprovalOpts {
    allowUnlimited?: boolean;
    resetFirst?: boolean;
}
/**
 * Returns the approve txs needed (in order), possibly empty. Approves exactly `amount` (never unlimited unless
 * explicitly allowed). `resetFirst` adds approve(0) before a non-zero top-up for USDT-style tokens.
 */
export declare function planApproval(token: string, spender: string, amount: bigint, currentAllowance: bigint, o?: ApprovalOpts): TxRequest[];
