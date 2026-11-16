import type { Venue } from './types.ts';
import type { SimTx, Receipt } from './simchain.ts';

export type MaybeAsync<T> = T | Promise<T>;
/**
 * What the engine needs from a chain. SimChain implements it synchronously; a real-node adapter implements it over JSON-RPC.
 * `time`, `block` and `venues()` are READ SYNCHRONOUSLY by the engine and router, so a networked port must keep them fresh via `refresh()`,
 * which the engine awaits before each step. Everything else may return a Promise.
 */
export interface ChainPort {
  id: string; family: string;
  time: number; block: number; finalityDepth: number;
  state: { venues: Map<string, Venue> };
  venues(): Venue[];
  /** Networked ports: update head (time/block) and, for 'venues', reload pool state. Optional. */
  refresh?(what: 'head' | 'venues'): Promise<void>;
  confirmedNonce(wallet: string): MaybeAsync<number>;
  /** Current balance of `token` (or NATIVE) held by `wallet`. Needed by order reservations. */
  balanceOf?(wallet: string, token: string): MaybeAsync<bigint>;
  simulate(tx: SimTx): MaybeAsync<{ block: number; receipt: Receipt }>;
  /** Networked ports: build and sign the real transaction. Called after the policy signer approved, BEFORE the write-ahead persist; returns the real hash and raw bytes. */
  prepare?(tx: SimTx): Promise<{ hash: string; raw: string }>;
  /** Networked ports: does this tx (a sell) need a token allowance first? Returns the EXACT allowance to grant, or undefined. */
  needsApproval?(tx: SimTx): Promise<{ token: string; spender: string; amount: bigint } | undefined>;
  submit(tx: SimTx): MaybeAsync<string>;
  /** Atomically drop a still-pending tx. Omit when the chain cannot (a real node: the tx may be mined at any moment). */
  evict?(hash: string): MaybeAsync<boolean>;
  /** True when a pending tx can be superseded by sending a higher-fee tx with the SAME nonce (replace-by-fee). Not atomic: either the original or the replacement lands. */
  replaceByFee?: boolean;
  lookup(hash: string): MaybeAsync<'pending' | 'included' | 'none'>;
  receipt(hash: string): MaybeAsync<Receipt | undefined>;
  confirmations(hash: string): MaybeAsync<number>;
}
