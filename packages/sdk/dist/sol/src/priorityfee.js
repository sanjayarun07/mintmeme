export const PRIORITY_DEFAULTS = { percentile: 75, minMicroLamports: 10000n, maxLamports: 100000n, cacheMs: 10_000 };
/** The `p`th percentile (nearest rank) of a list of fees. Empty: 0. */
export function percentile(values, p) {
    if (!values.length)
        return 0n;
    const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
/** Compute-unit limit from a simulation: units used x 1.2, rounded up, within 1,000 .. 1,400,000. */
export const limitFromSimulation = (unitsConsumed) => Math.min(1_400_000, Math.max(1_000, Math.ceil(unitsConsumed * 1.2)));
export class PriorityFees {
    rpc;
    c;
    now;
    cache = new Map();
    constructor(rpc, c = {}, now = Date.now) {
        this.rpc = rpc;
        this.c = c;
        this.now = now;
    }
    /** Price in micro-lamports per compute unit for a transaction that writes `accounts`, before the cap. */
    async estimate(accounts) {
        const keys = [...new Set(accounts)].slice(0, 128), k = keys.join(','), hit = this.cache.get(k), ttl = this.c.cacheMs ?? PRIORITY_DEFAULTS.cacheMs;
        if (hit && this.now() - hit.at < ttl)
            return hit.v;
        const rows = await this.rpc.call('getRecentPrioritizationFees', [keys]);
        const v = percentile((rows ?? []).map(r => BigInt(r.prioritizationFee)), this.c.percentile ?? PRIORITY_DEFAULTS.percentile);
        this.cache.set(k, { at: this.now(), v });
        if (this.cache.size > 500)
            this.cache.delete(this.cache.keys().next().value);
        return v;
    }
    /** The price to set for this transaction: the estimate, at least the floor, and low enough that price x limit stays within the cap. */
    async price(accounts, computeUnitLimit) {
        const est = await this.estimate(accounts), floor = this.c.minMicroLamports ?? PRIORITY_DEFAULTS.minMicroLamports, cap = this.c.maxLamports ?? PRIORITY_DEFAULTS.maxLamports;
        return clampPrice(est > floor ? est : floor, computeUnitLimit, cap);
    }
}
/** Lower `microLamports` so that microLamports x limit / 1e6 <= capLamports. */
export function clampPrice(microLamports, computeUnitLimit, capLamports) {
    const max = capLamports * 1000000n / BigInt(Math.max(1, computeUnitLimit));
    return microLamports > max ? max : microLamports;
}
export function feeTransfers(side, amountIn, minOut, bps, recipients) {
    if (bps <= 0)
        return { net: amountIn, total: 0n, each: [] };
    const rs = recipients.filter(r => r.bps > 0);
    if (!rs.length)
        throw new Error('a platform fee is set but no fee wallet is configured');
    const total = (side === 'buy' ? amountIn : minOut) * BigInt(bps) / 10000n, weight = rs.reduce((s, r) => s + r.bps, 0);
    const each = [];
    let given = 0n;
    rs.forEach((r, i) => { const l = i === rs.length - 1 ? total - given : total * BigInt(r.bps) / BigInt(weight); given += l; if (l > 0n)
        each.push({ to: r.address, lamports: l }); });
    return { net: side === 'buy' ? amountIn - total : amountIn, total, each };
}
