import { decodeParams, normAddr } from './abi.js';
import { pairCalls } from './calldata.js';
const BPS = 10000n;
export const V2_FEE = { num: 997n, den: 1000n };
/** Exact UniswapV2Library.getAmountOut. */
export function getAmountOut(amountIn, rIn, rOut, fee = V2_FEE) {
    if (amountIn <= 0n)
        throw new Error('INSUFFICIENT_INPUT_AMOUNT');
    if (rIn <= 0n || rOut <= 0n)
        throw new Error('INSUFFICIENT_LIQUIDITY');
    const inFee = amountIn * fee.num;
    return inFee * rOut / (rIn * fee.den + inFee);
}
/** Exact UniswapV2Library.getAmountIn. */
export function getAmountIn(amountOut, rIn, rOut, fee = V2_FEE) {
    if (amountOut <= 0n)
        throw new Error('INSUFFICIENT_OUTPUT_AMOUNT');
    if (rIn <= 0n || rOut <= 0n || amountOut >= rOut)
        throw new Error('INSUFFICIENT_LIQUIDITY');
    return rIn * amountOut * fee.den / ((rOut - amountOut) * fee.num) + 1n;
}
export function decodeReserves(ret) {
    const [r0, r1, ts] = decodeParams(['uint112', 'uint112', 'uint32'], ret);
    return { reserve0: r0, reserve1: r1, blockTimestampLast: ts };
}
export class V2Venue {
    kind = 'cpamm';
    status = 'active';
    successor;
    id;
    family;
    pair;
    token0;
    token1;
    reserve0;
    reserve1;
    fee;
    wrappedNative;
    block;
    constructor(c) {
        this.id = c.id;
        this.family = c.family ?? 'evm';
        this.pair = normAddr(c.pair);
        this.token0 = normAddr(c.token0);
        this.token1 = normAddr(c.token1);
        if (this.token0 >= this.token1)
            throw new Error('token0 must sort below token1');
        this.reserve0 = c.reserve0;
        this.reserve1 = c.reserve1;
        this.fee = c.fee ?? V2_FEE;
        this.wrappedNative = c.wrappedNative && normAddr(c.wrappedNative);
        this.block = c.block ?? 0;
    }
    /** Load state via injected eth_call (token0 from chain; reserves pinned to `block` when given). */
    static async load(call, o) {
        const blk = o.block ?? 'latest';
        const t0 = o.tokens?.token0 ?? decodeParams(['address'], await call(pairCalls.token0(o.pair), blk))[0];
        const t1 = o.tokens?.token1 ?? decodeParams(['address'], await call({ to: o.pair, data: '0xd21220a7' }, blk))[0]; // token1()
        const r = decodeReserves(await call(pairCalls.getReserves(o.pair), blk));
        return new V2Venue({ ...o, token0: t0, token1: t1, reserve0: r.reserve0, reserve1: r.reserve1 });
    }
    res(t) {
        if (t === 'NATIVE' && this.wrappedNative)
            t = this.wrappedNative;
        return t.toLowerCase();
    }
    supports(a, b) {
        const x = this.res(a), y = this.res(b);
        return (x === this.token0 && y === this.token1) || (x === this.token1 && y === this.token0);
    }
    io(a, b) {
        if (!this.supports(a, b))
            throw new Error('unsupported pair');
        return this.res(a) === this.token0 ? [this.reserve0, this.reserve1] : [this.reserve1, this.reserve0];
    }
    quote(a, b, amt) {
        const [rIn, rOut] = this.io(a, b);
        const out = getAmountOut(amt, rIn, rOut, this.fee);
        const spot = amt * rOut / rIn;
        const impact = spot === 0n ? 0 : Math.max(0, Number((spot - out) * BPS / spot));
        const venueFee = amt - amt * this.fee.num / this.fee.den;
        const liquidity = this.wrappedNative && this.token0 === this.wrappedNative ? this.reserve0 : this.wrappedNative && this.token1 === this.wrappedNative ? this.reserve1 : rOut;
        return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: impact, venueFee, liquidity };
    }
    spotPriceE18(a, b) { const [rIn, rOut] = this.io(a, b); return rOut * 10n ** 18n / rIn; }
    swap(a, b, amt) {
        const q = this.quote(a, b, amt);
        if (this.res(a) === this.token0) {
            this.reserve0 += amt;
            this.reserve1 -= q.amountOut;
        }
        else {
            this.reserve1 += amt;
            this.reserve0 -= q.amountOut;
        }
        return { amountOut: q.amountOut, venueFee: q.venueFee };
    }
    clone() { const c = new V2Venue({ id: this.id, family: this.family, pair: this.pair, token0: this.token0, token1: this.token1, reserve0: this.reserve0, reserve1: this.reserve1, fee: this.fee, wrappedNative: this.wrappedNative, block: this.block }); c.status = this.status; c.successor = this.successor; return c; }
}
