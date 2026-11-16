/** A Solana RPC client that can only READ. Any method that could change state is refused, so code built on it cannot trade even by mistake. Used by the mainnet check and the terminal's Solana routes. */
import { SolJsonRpc } from '../../sol/src/index.ts';

export const READ_ONLY = new Set(['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSlot', 'getBlockHeight', 'getBalance', 'getTokenAccountsByOwner', 'getTokenLargestAccounts', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction', 'simulateTransaction', 'getMinimumBalanceForRentExemption', 'getGenesisHash', 'getHealth', 'getVersion', 'getRecentPrioritizationFees', 'getBlockTime', 'getEpochInfo']);
export class GuardedRpc extends SolJsonRpc {
  override async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (!READ_ONLY.has(method)) throw new Error(`read-only: RPC method "${method}" is refused`);
    return super.call<T>(method, params);
  }
}
