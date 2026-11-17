/** PRIORITY-FEE ESTIMATION. A Solana transaction's priority fee is compute-unit price (micro-lamports per unit) x compute-unit limit. Validators order by that price, so
 *  under load a transaction with no or a low price waits or drops. We read what transactions touching the SAME accounts paid recently (`getRecentPrioritizationFees`,
 *  the last ~150 slots, a standard JSON-RPC method), take a percentile, and clamp the total to a cap so a fee spike can never cost more than you allowed.
 *  The limit is set separately from a simulation (units used x 1.2, as Jupiter's compute-unit guide recommends), so the price is paid on what the trade needs,
 *  not on the 200,000-units-per-instruction default. */
export interface PriorityConfig {
  /** Percentile of recent fees on the trade's accounts (0..100). Default 75. Higher lands faster under load and costs more. */
  percentile?: number;
  /** Floor for the price, so a quiet moment still pays something. Default 10,000 micro-lamports per unit. */
  minMicroLamports?: bigint;
  /** Hard cap on the priority fee of one transaction (price x limit), in lamports. Default 100,000 (0.0001 SOL). */
  maxLamports?: bigint;
  /** How long one estimate is reused for the same accounts. Default 10 s. */
  cacheMs?: number;
}
export const PRIORITY_DEFAULTS = { percentile: 75, minMicroLamports: 10_000n, maxLamports: 100_000n, cacheMs: 10_000 };
export interface FeeRpc { call<T = any>(method: string, params?: unknown[]): Promise<T> }

/** The `p`th percentile (nearest rank) of a list of fees. Empty: 0. */
export function percentile(values: bigint[], p: number): bigint {
  if (!values.length) return 0n; const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
/** Compute-unit limit from a simulation: units used x 1.2, rounded up, within 1,000 .. 1,400,000. */
export const limitFromSimulation = (unitsConsumed: number) => Math.min(1_400_000, Math.max(1_000, Math.ceil(unitsConsumed * 1.2)));

export class PriorityFees {
  private cache = new Map<string, { at: number; v: bigint }>();
  constructor(private rpc: FeeRpc, private c: PriorityConfig = {}, private now: () => number = Date.now) {}
  /** Price in micro-lamports per compute unit for a transaction that writes `accounts`, before the cap. */
  async estimate(accounts: string[]): Promise<bigint> {
    const keys = [...new Set(accounts)].slice(0, 128), k = keys.join(','), hit = this.cache.get(k), ttl = this.c.cacheMs ?? PRIORITY_DEFAULTS.cacheMs;
    if (hit && this.now() - hit.at < ttl) return hit.v;
    const rows = await this.rpc.call<{ slot: number; prioritizationFee: number }[]>('getRecentPrioritizationFees', [keys]);
    const v = percentile((rows ?? []).map(r => BigInt(r.prioritizationFee)), this.c.percentile ?? PRIORITY_DEFAULTS.percentile);
    this.cache.set(k, { at: this.now(), v }); if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return v;
  }
  /** The price to set for this transaction: the estimate, at least the floor, and low enough that price x limit stays within the cap. */
  async price(accounts: string[], computeUnitLimit: number): Promise<bigint> {
    const est = await this.estimate(accounts), floor = this.c.minMicroLamports ?? PRIORITY_DEFAULTS.minMicroLamports, cap = this.c.maxLamports ?? PRIORITY_DEFAULTS.maxLamports;
    return clampPrice(est > floor ? est : floor, computeUnitLimit, cap);
  }
}
/** Lower `microLamports` so that microLamports x limit / 1e6 <= capLamports. */
export function clampPrice(microLamports: bigint, computeUnitLimit: number, capLamports: bigint): bigint {
  const max = capLamports * 1_000_000n / BigInt(Math.max(1, computeUnitLimit)); return microLamports > max ? max : microLamports;
}
