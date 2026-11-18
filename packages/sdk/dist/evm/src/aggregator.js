import { NATIVE } from '../../core/src/index.js';
export const KYBER = { router: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', swapSelector: '0xe21fd0e9', native: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const lc = (s) => s.toLowerCase();
/** Thrown when a gate or a check refuses an aggregator transaction. Never retried: the caller treats it as a hard stop. */
export class AggRefused extends Error {
}
/** The swap description inside KyberSwap's `swap(SwapExecutionParams)` calldata: (callTarget, approveTarget, targetData, desc, clientData), desc = (srcToken, dstToken,
 *  srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[], dstReceiver, amount, minReturnAmount, flags, permit). Throws on anything that does not parse. */
export function decodeKyberSwap(data) {
    if (!/^0x[0-9a-fA-F]*$/.test(data) || data.slice(0, 10).toLowerCase() !== KYBER.swapSelector)
        throw new AggRefused(`not a KyberSwap swap call (selector ${data.slice(0, 10)})`);
    const body = data.slice(10), words = body.length / 64;
    if (!Number.isInteger(words) || words < 16)
        throw new AggRefused('swap calldata is too short');
    const w = (i) => { if (i < 0n || i >= BigInt(words))
        throw new AggRefused('swap calldata offset out of range'); const n = Number(i); return BigInt('0x' + body.slice(n * 64, n * 64 + 64)); };
    const at = (byteOff, k) => { if (byteOff % 32n)
        throw new AggRefused('misaligned offset in swap calldata'); return w(byteOff / 32n + BigInt(k)); };
    const addr = (x) => { if (x >> 160n)
        throw new AggRefused('a malformed address in swap calldata'); return '0x' + x.toString(16).padStart(40, '0'); };
    const exec = w(0n), desc = exec + at(exec, 3), fees = desc + at(desc, 4);
    return { callTarget: addr(at(exec, 0)), srcToken: addr(at(desc, 0)), dstToken: addr(at(desc, 1)), feeReceivers: Number(at(fees, 0)), dstReceiver: addr(at(desc, 6)), amount: at(desc, 7), minReturnAmount: at(desc, 8) };
}
/** Simulates calls in order from `wallet` with eth_simulateV1 (transfer tracing) and returns each call's status and gas, and the wallet's net balance change per token
 *  (NATIVE for ETH value transfers; gas is not included). Throws if the node cannot simulate. */
export async function simulateCalls(rpc, wallet, calls) {
    const w = lc(wallet), hex = (n) => '0x' + n.toString(16);
    const r = await rpc.call('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(c => ({ from: w, to: lc(c.to), data: c.data, value: hex(c.value) })) }], traceTransfers: true, validation: false }, 'latest']);
    const res = (r?.[0]?.calls ?? []);
    if (res.length !== calls.length)
        throw new Error('eth_simulateV1 returned an unexpected shape');
    const deltas = {}, add = (k, v) => { deltas[k] = (deltas[k] ?? 0n) + v; }, pad = w.slice(2);
    for (const c of res)
        for (const l of (c.logs ?? [])) {
            if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3)
                continue;
            const token = lc(l.address) === KYBER.native ? NATIVE : lc(l.address), amt = BigInt(l.data);
            if (l.topics[1].endsWith(pad))
                add(token, -amt);
            if (l.topics[2].endsWith(pad))
                add(token, amt);
        }
    return { calls: res.map(c => ({ ok: c.status === '0x1', gasUsed: BigInt(c.gasUsed ?? '0x0'), error: c.error?.message })), deltas };
}
/** An aggregator route for ONE direction of ONE pair, as a reference snapshot: quote(amount) scales it linearly (optimistic for large sizes). The real route is quoted
 *  again at the exact amount when the transaction is made, gated and simulated, and refused if it cannot meet the engine's minOut. */
export class AggVenue {
    id;
    tokenIn;
    tokenOut;
    refIn;
    refOut;
    block;
    family;
    kind = 'cpamm';
    status = 'active';
    constructor(id, tokenIn, tokenOut, refIn, refOut, block = 0, family = 'relay') {
        this.id = id;
        this.tokenIn = tokenIn;
        this.tokenOut = tokenOut;
        this.refIn = refIn;
        this.refOut = refOut;
        this.block = block;
        this.family = family;
    }
    supports(a, b) { return a === this.tokenIn && b === this.tokenOut; }
    quote(a, b, amt) { if (!this.supports(a, b))
        throw new Error('unsupported pair'); return { venue: this.id, family: this.family, amountOut: this.refOut * amt / this.refIn, priceImpactBps: 0, venueFee: 0n, liquidity: this.refOut }; }
    spotPriceE18(a, b) { if (!this.supports(a, b))
        throw new Error('unsupported pair'); return this.refOut * 10n ** 18n / this.refIn; }
    swap(a, b, amt) { return { amountOut: this.quote(a, b, amt).amountOut, venueFee: 0n }; }
    clone() { return new AggVenue(this.id, this.tokenIn, this.tokenOut, this.refIn, this.refOut, this.block, this.family); }
}
