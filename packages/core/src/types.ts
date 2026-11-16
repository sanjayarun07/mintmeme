export type Family = 'evm' | 'solana' | 'ton' | 'tron';
export type TxState =
  | 'created' | 'validated' | 'quoted' | 'simulated' | 'awaiting_authorization'
  | 'signed' | 'submitted' | 'observed' | 'confirmed' | 'finalized'
  | 'failed' | 'expired' | 'unresolved';
export type Origin = 'manual' | 'telegram' | 'copy' | 'snipe' | 'order' | 'signal' | 'dca' | 'bulk' | 'twap';

export const NATIVE = 'NATIVE';

export interface Intent {
  idempotencyKey: string;
  userId: string;
  walletId: string;
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;          // max budget (includes platform fee)
  minOut: bigint;            // 0n => derived from quote and slippageBps
  slippageBps: number;
  deadline: number;          // chain-time seconds
  maxFeeBps: number;         // cap on platform fee
  venues: string[];          // authorized venue ids or families
  origin: Origin;
}

export interface Quote {
  venue: string;
  family: string;
  source: 'direct' | 'aggregator';
  amountOut: bigint;
  priceImpactBps: number;
  venueFee: bigint;
  liquidity: bigint;
  block: number;
}

export interface Venue {
  id: string;
  family: string;
  kind: 'cpamm' | 'curve';
  status: 'active' | 'graduated';
  successor?: string;
  supports(a: string, b: string): boolean;
  quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
  swap(a: string, b: string, amt: bigint): { amountOut: bigint; venueFee: bigint };
  /** Optional: marginal price, units of `b` per unit of `a`, x1e18, BEFORE fee and price impact. Needed to evaluate price-triggered orders. */
  spotPriceE18?(a: string, b: string): bigint;
  clone(): Venue;
}

export interface Fill {
  spent: bigint;       // input token actually leaving wallet (excl. network fee)
  received: bigint;    // output token actually credited (balance delta)
  platformFee: bigint;
  venueFee: bigint;
  networkFee: bigint;
  quotedOut: bigint;
  shortfall: bigint;   // quotedOut - received: transfer tax and/or state drift (not separable on-chain without logs)
}
