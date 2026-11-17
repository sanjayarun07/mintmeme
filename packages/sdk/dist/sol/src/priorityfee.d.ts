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
export declare const PRIORITY_DEFAULTS: {
    percentile: number;
    minMicroLamports: bigint;
    maxLamports: bigint;
    cacheMs: number;
};
export interface FeeRpc {
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
/** The `p`th percentile (nearest rank) of a list of fees. Empty: 0. */
export declare function percentile(values: bigint[], p: number): bigint;
/** Compute-unit limit from a simulation: units used x 1.2, rounded up, within 1,000 .. 1,400,000. */
export declare const limitFromSimulation: (unitsConsumed: number) => number;
export declare class PriorityFees {
    private rpc;
    private c;
    private now;
    private cache;
    constructor(rpc: FeeRpc, c?: PriorityConfig, now?: () => number);
    /** Price in micro-lamports per compute unit for a transaction that writes `accounts`, before the cap. */
    estimate(accounts: string[]): Promise<bigint>;
    /** The price to set for this transaction: the estimate, at least the floor, and low enough that price x limit stays within the cap. */
    price(accounts: string[], computeUnitLimit: number): Promise<bigint>;
}
/** Lower `microLamports` so that microLamports x limit / 1e6 <= capLamports. */
export declare function clampPrice(microLamports: bigint, computeUnitLimit: number, capLamports: bigint): bigint;
