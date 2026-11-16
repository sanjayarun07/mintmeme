import type { Venue } from './types.ts';

const BPS = 10_000n;

/** Constant-product pool (Uniswap-V2 style). Other pool models (CL, DLMM, stable) need their own Venue impl. */
export class CpAmm implements Venue {
  kind = 'cpamm' as const;
  status: 'active' | 'graduated' = 'active';
  successor?: string;
  constructor(public id: string, public family: string, public token: string, public quoteToken: string,
              public rToken: bigint, public rQuote: bigint, public feeBps = 30n) {}
  supports(a: string, b: string) { return (a === this.token && b === this.quoteToken) || (a === this.quoteToken && b === this.token); }
  private reserves(a: string): [bigint, bigint] { return a === this.token ? [this.rToken, this.rQuote] : [this.rQuote, this.rToken]; }
  quote(a: string, b: string, amt: bigint) {
    const [rIn, rOut] = this.reserves(a);
    const inF = amt * (BPS - this.feeBps) / BPS;
    const out = rOut * inF / (rIn + inF);
    const spot = amt * rOut / rIn;
    const impact = spot === 0n ? 0 : Number((spot - out) * BPS / spot);
    return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: impact, venueFee: amt - inF, liquidity: this.rQuote };
  }
  spotPriceE18(a: string, b: string) { const [rIn, rOut] = this.reserves(a); return rOut * 10n ** 18n / rIn; }
  swap(a: string, b: string, amt: bigint) {
    const q = this.quote(a, b, amt);
    if (a === this.token) { this.rToken += amt; this.rQuote -= q.amountOut; } else { this.rQuote += amt; this.rToken -= q.amountOut; }
    return { amountOut: q.amountOut, venueFee: q.venueFee };
  }
  clone() { const c = new CpAmm(this.id, this.family, this.token, this.quoteToken, this.rToken, this.rQuote, this.feeBps); c.status = this.status; c.successor = this.successor; return c; }
}

/** Linear bonding curve: price(s) = p0 + slope*s (quote units per whole token). Graduates at `target` raised. */
export class LinearCurve implements Venue {
  kind = 'curve' as const;
  status: 'active' | 'graduated' = 'active';
  successor?: string;
  constructor(public id: string, public family: string, public token: string, public quoteToken: string,
              public p0: bigint, public slope: bigint, public supply = 0n, public raised = 0n,
              public target = 1_000_000n, public feeBps = 100n) {}
  supports(a: string, b: string) { return this.status === 'active' && ((a === this.quoteToken && b === this.token) || (a === this.token && b === this.quoteToken)); }
  private cost(dx: bigint, s: bigint) { return this.p0 * dx + this.slope * dx * (2n * s + dx) / 2n; }
  private proceeds(dx: bigint, s: bigint) { return this.p0 * dx + this.slope * dx * (2n * s - dx) / 2n; }
  private tokensFor(budget: bigint): bigint {
    let lo = 0n, hi = budget / (this.p0 || 1n) + 1n;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (this.cost(mid, this.supply) <= budget) lo = mid; else hi = mid - 1n; }
    return lo;
  }
  quote(a: string, b: string, amt: bigint) {
    const fee = amt * this.feeBps / BPS;
    let out: bigint;
    if (a === this.quoteToken) out = this.tokensFor(amt - fee);
    else { const dx = amt > this.supply ? this.supply : amt; const p = this.proceeds(dx, this.supply); out = p - p * this.feeBps / BPS; }
    const spotOut = a === this.quoteToken ? (amt - fee) / (this.p0 + this.slope * this.supply || 1n) : amt * (this.p0 + this.slope * this.supply);
    const impact = spotOut === 0n ? 0 : Number((spotOut - out) * BPS / spotOut);
    return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: Math.max(0, impact), venueFee: fee, liquidity: this.raised };
  }
  swap(a: string, b: string, amt: bigint) {
    if (this.status !== 'active') throw new Error('curve graduated');
    const q = this.quote(a, b, amt);
    if (a === this.quoteToken) { this.supply += q.amountOut; this.raised += amt - q.venueFee; }
    else { this.supply -= amt; this.raised -= q.amountOut + q.venueFee; }
    return { amountOut: q.amountOut, venueFee: q.venueFee };
  }
  get shouldGraduate() { return this.status === 'active' && this.raised >= this.target; }
  clone() { const c = new LinearCurve(this.id, this.family, this.token, this.quoteToken, this.p0, this.slope, this.supply, this.raised, this.target, this.feeBps); c.status = this.status; c.successor = this.successor; return c; }
}
