const BPS = 10000n;
/** Constant-product pool (Uniswap-V2 style). Other pool models (CL, DLMM, stable) need their own Venue impl. */
export class CpAmm {
    id;
    family;
    token;
    quoteToken;
    rToken;
    rQuote;
    feeBps;
    kind = 'cpamm';
    status = 'active';
    successor;
    constructor(id, family, token, quoteToken, rToken, rQuote, feeBps = 30n) {
        this.id = id;
        this.family = family;
        this.token = token;
        this.quoteToken = quoteToken;
        this.rToken = rToken;
        this.rQuote = rQuote;
        this.feeBps = feeBps;
    }
    supports(a, b) { return (a === this.token && b === this.quoteToken) || (a === this.quoteToken && b === this.token); }
    reserves(a) { return a === this.token ? [this.rToken, this.rQuote] : [this.rQuote, this.rToken]; }
    quote(a, b, amt) {
        const [rIn, rOut] = this.reserves(a);
        const inF = amt * (BPS - this.feeBps) / BPS;
        const out = rOut * inF / (rIn + inF);
        const spot = amt * rOut / rIn;
        const impact = spot === 0n ? 0 : Number((spot - out) * BPS / spot);
        return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: impact, venueFee: amt - inF, liquidity: this.rQuote };
    }
    spotPriceE18(a, b) { const [rIn, rOut] = this.reserves(a); return rOut * 10n ** 18n / rIn; }
    swap(a, b, amt) {
        const q = this.quote(a, b, amt);
        if (a === this.token) {
            this.rToken += amt;
            this.rQuote -= q.amountOut;
        }
        else {
            this.rQuote += amt;
            this.rToken -= q.amountOut;
        }
        return { amountOut: q.amountOut, venueFee: q.venueFee };
    }
    clone() { const c = new CpAmm(this.id, this.family, this.token, this.quoteToken, this.rToken, this.rQuote, this.feeBps); c.status = this.status; c.successor = this.successor; return c; }
}
/** Linear bonding curve: price(s) = p0 + slope*s (quote units per whole token). Graduates at `target` raised. */
export class LinearCurve {
    id;
    family;
    token;
    quoteToken;
    p0;
    slope;
    supply;
    raised;
    target;
    feeBps;
    kind = 'curve';
    status = 'active';
    successor;
    constructor(id, family, token, quoteToken, p0, slope, supply = 0n, raised = 0n, target = 1000000n, feeBps = 100n) {
        this.id = id;
        this.family = family;
        this.token = token;
        this.quoteToken = quoteToken;
        this.p0 = p0;
        this.slope = slope;
        this.supply = supply;
        this.raised = raised;
        this.target = target;
        this.feeBps = feeBps;
    }
    supports(a, b) { return this.status === 'active' && ((a === this.quoteToken && b === this.token) || (a === this.token && b === this.quoteToken)); }
    cost(dx, s) { return this.p0 * dx + this.slope * dx * (2n * s + dx) / 2n; }
    proceeds(dx, s) { return this.p0 * dx + this.slope * dx * (2n * s - dx) / 2n; }
    tokensFor(budget) {
        let lo = 0n, hi = budget / (this.p0 || 1n) + 1n;
        while (lo < hi) {
            const mid = (lo + hi + 1n) / 2n;
            if (this.cost(mid, this.supply) <= budget)
                lo = mid;
            else
                hi = mid - 1n;
        }
        return lo;
    }
    quote(a, b, amt) {
        const fee = amt * this.feeBps / BPS;
        let out;
        if (a === this.quoteToken)
            out = this.tokensFor(amt - fee);
        else {
            const dx = amt > this.supply ? this.supply : amt;
            const p = this.proceeds(dx, this.supply);
            out = p - p * this.feeBps / BPS;
        }
        const spotOut = a === this.quoteToken ? (amt - fee) / (this.p0 + this.slope * this.supply || 1n) : amt * (this.p0 + this.slope * this.supply);
        const impact = spotOut === 0n ? 0 : Number((spotOut - out) * BPS / spotOut);
        return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: Math.max(0, impact), venueFee: fee, liquidity: this.raised };
    }
    swap(a, b, amt) {
        if (this.status !== 'active')
            throw new Error('curve graduated');
        const q = this.quote(a, b, amt);
        if (a === this.quoteToken) {
            this.supply += q.amountOut;
            this.raised += amt - q.venueFee;
        }
        else {
            this.supply -= amt;
            this.raised -= q.amountOut + q.venueFee;
        }
        return { amountOut: q.amountOut, venueFee: q.venueFee };
    }
    get shouldGraduate() { return this.status === 'active' && this.raised >= this.target; }
    clone() { const c = new LinearCurve(this.id, this.family, this.token, this.quoteToken, this.p0, this.slope, this.supply, this.raised, this.target, this.feeBps); c.status = this.status; c.successor = this.successor; return c; }
}
