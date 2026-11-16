import { rep, rev } from './store.js';
import { toBackend } from './durable.js';
/** TWAP ORDER (time-weighted average price): buy or sell one token from ONE wallet in `slices` equal parts, one part every `intervalS` seconds, so a large order does not move the pool
 *  in one go. Each slice is an ordinary Engine intent (own policy check, nonce, idempotency key `twap:<id>:<n>`), so a restart can never send a slice twice.
 *  What this is NOT: a guarantee of the average price. A TWAP spreads the timing; it does not promise a price. Slices go out one at a time (each is quoted after the previous one has settled),
 *  and a slice that cannot go within its window (price beyond your limit, too much impact, thin liquidity, node down) is SKIPPED and reported, never silently made up later. */
export const MAX_TWAP_SLICES = 100;
export function validateTwap(s) {
    if (!s.id)
        throw new Error('twap order needs an id');
    if (s.token === s.quoteToken)
        throw new Error('token and quote token are the same');
    if (s.side !== 'buy' && s.side !== 'sell')
        throw new Error("side must be 'buy' or 'sell'");
    const cap = Math.min(s.maxSlices ?? MAX_TWAP_SLICES, MAX_TWAP_SLICES);
    if (!Number.isInteger(s.slices) || s.slices < 2)
        throw new Error('a twap order needs at least 2 slices (use a normal order for one)');
    if (s.slices > cap)
        throw new Error(`a twap order supports at most ${cap} slices, got ${s.slices}`);
    if (!Number.isInteger(s.intervalS) || s.intervalS < 1)
        throw new Error('intervalS must be a positive whole number of seconds');
    if (s.total <= 0n)
        throw new Error('total must be positive');
    if (s.total < BigInt(s.slices))
        throw new Error(`total ${s.total} is too small to give each of ${s.slices} slices at least 1 unit`);
    if (!Number.isInteger(s.slippageBps) || s.slippageBps < 0 || s.slippageBps > 10_000)
        throw new Error('slippageBps must be a whole number 0..10000');
    if (s.windowS !== undefined && (!Number.isInteger(s.windowS) || s.windowS < 1))
        throw new Error('windowS must be a positive whole number of seconds');
    if (s.limitPriceE18 !== undefined && s.limitPriceE18 <= 0n)
        throw new Error('limitPriceE18 must be positive');
    if (s.maxSliceImpactBps !== undefined && (!Number.isInteger(s.maxSliceImpactBps) || s.maxSliceImpactBps < 0))
        throw new Error('maxSliceImpactBps must be a whole number >= 0');
    if (s.jitterPct !== undefined && (!Number.isInteger(s.jitterPct) || s.jitterPct < 0 || s.jitterPct > 50))
        throw new Error('jitterPct must be a whole number 0..50');
}
/** Split `total` into `n` parts that sum exactly; the remainder (one unit each) goes to the first slices. */
export function splitSlices(total, n) { const b = BigInt(n), each = total / b, extra = Number(total % b); return Array.from({ length: n }, (_, i) => each + (i < extra ? 1n : 0n)); }
/** Deterministic 0..1 value from text (FNV-1a), so jitter needs no randomness and a restart recomputes the same schedule. */
function unit(text) { let h = 0x811c9dc5; for (const c of text) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
} return h / 0x100000000; }
/** Due time of every slice. Slice 0 never goes before `startAt`; jitter is at most a quarter interval each way, so slices always stay in order. */
export function twapSchedule(s, startAt) {
    return Array.from({ length: s.slices }, (_, i) => { const j = Math.round((unit(`${s.id}:${i}`) * 2 - 1) * ((s.jitterPct ?? 0) / 100) * s.intervalS / 2); return Math.max(startAt, startAt + i * s.intervalS + j); });
}
const TERMINAL = new Set(['finalized', 'failed', 'expired']);
/** Durable like the other runners: a write-ahead checkpoint of the slice table, outbox and in-flight keys, so a crash re-submits the same idempotency keys and never trades a slice twice. */
export class TwapRunner {
    d;
    slices;
    outbox = [];
    inflight = new Set();
    planned = false;
    cancelled = false;
    startAt;
    refused;
    lastError;
    backend;
    constructor(d) {
        this.d = d;
        validateTwap(d.spec);
        const s = d.spec;
        this.slices = splitSlices(s.total, s.slices).map((amount, n) => ({ n, key: `twap:${s.id}:${n}`, amount, dueAt: 0, status: 'pending' }));
        this.backend = d.persistPath === undefined ? undefined : toBackend(d.persistPath);
        const saved = this.backend?.read();
        if (saved) {
            const o = JSON.parse(saved, rev);
            if (o.v !== 1)
                throw new Error(`unsupported twap state version ${o.v}`);
            if (o.id !== s.id)
                throw new Error(`state file belongs to twap order ${o.id}, not ${s.id}`);
            this.slices = o.slices;
            this.outbox = o.outbox;
            this.inflight = new Set(o.inflight);
            this.planned = o.planned;
            this.cancelled = o.cancelled;
            this.startAt = o.startAt;
            this.refused = o.refused;
        }
    }
    get spec() { return this.d.spec; }
    checkpoint() { this.backend?.write(JSON.stringify({ v: 1, id: this.d.spec.id, slices: this.slices, outbox: this.outbox, inflight: [...this.inflight], planned: this.planned, cancelled: this.cancelled, startAt: this.startAt, refused: this.refused }, rep)); }
    slice(key) { return this.slices.find(l => l.key === key); }
    get tin() { return this.d.spec.side === 'buy' ? this.d.spec.quoteToken : this.d.spec.token; }
    get tout() { return this.d.spec.side === 'buy' ? this.d.spec.token : this.d.spec.quoteToken; }
    /** Stop the schedule: slices not yet sent are skipped. A slice already in flight finishes (it is on the chain or about to be). */
    cancel() { this.cancelled = true; for (const l of this.slices)
        if (l.status === 'pending') {
            l.status = 'skipped';
            l.reason = 'cancelled';
        } this.checkpoint(); }
    /** Once: the wallet must hold the WHOLE amount now, and the schedule is fixed. Nothing is sent here. */
    async preflight() {
        const { chain, spec } = this.d;
        if (!chain.balanceOf) {
            this.refused = 'this chain cannot report balances';
        }
        else {
            const bal = BigInt(await chain.balanceOf(spec.walletId, this.tin));
            if (bal < spec.total)
                this.refused = `balance ${bal} is below the ${spec.total} this order needs`;
        }
        if (this.refused)
            for (const l of this.slices) {
                l.status = 'skipped';
                l.reason = this.refused;
            }
        this.startAt = spec.startAt ?? chain.time;
        const due = twapSchedule(spec, this.startAt);
        this.slices.forEach((l, i) => { l.dueAt = due[i]; });
        this.planned = true;
    }
    /** Best authorized venue for this slice: the one that pays the most. Undefined (with a reason) when none can quote. */
    best(amount) {
        const { spec, chain } = this.d;
        let best;
        for (const v of chain.venues()) {
            if (v.status !== 'active' || !(spec.venues.includes(v.id) || spec.venues.includes(v.family)) || !v.supports(this.tin, this.tout))
                continue;
            try {
                const q = v.quote(this.tin, this.tout, amount);
                if (!best || q.amountOut > best.out)
                    best = { v, out: q.amountOut, impact: q.priceImpactBps };
            }
            catch { /* unquotable here */ }
        }
        return best ? { v: best.v, impact: best.impact } : 'no authorized venue can quote this slice';
    }
    async tick() {
        const { chain, spec } = this.d;
        try {
            await chain.refresh?.('head');
            if (!this.planned) {
                await this.preflight();
                this.checkpoint();
            }
        }
        catch (e) {
            this.lastError = `node unreachable: ${e.message}`;
            await this.settle().catch(() => { });
            return { submitted: [], error: this.lastError };
        }
        this.lastError = undefined;
        await this.settle(); // the previous slice must be settled (and the pool must show it) before the next is quoted
        if (spec.onFailure === 'stop' && this.slices.some(l => l.status === 'failed'))
            for (const l of this.slices)
                if (l.status === 'pending') {
                    l.status = 'skipped';
                    l.reason = 'stopped after an earlier slice failed';
                }
        if (!this.cancelled && !this.refused && !this.slices.some(l => l.status === 'inflight') && this.outbox.length === 0)
            await this.next();
        this.checkpoint(); // write-ahead: the decision is on disk before anything is submitted
        const submitted = await this.flushOutbox();
        await this.settle();
        return { submitted, error: this.lastError };
    }
    /** Decide the next slice that is due: skip ones whose window has passed, hold ones the limits block, send the first that is clear. */
    async next() {
        const { chain, spec } = this.d;
        const window = spec.windowS ?? spec.intervalS;
        for (const l of this.slices) {
            if (l.status !== 'pending')
                continue;
            if (chain.time < l.dueAt)
                return; // not due yet (and neither is anything after it)
            if (chain.time > l.dueAt + window) {
                l.status = 'skipped';
                l.reason = `window passed${l.waiting ? ` (was waiting: ${l.waiting})` : ' (not sent in time)'}`;
                l.waiting = undefined;
                continue;
            }
            try {
                await chain.refresh?.('venues');
            }
            catch (e) {
                this.lastError = `pool refresh failed: ${e.message}`;
                l.waiting = 'pool data unavailable';
                return;
            }
            if (chain.balanceOf) {
                const bal = BigInt(await chain.balanceOf(spec.walletId, this.tin));
                if (bal < l.amount) {
                    l.waiting = `balance ${bal} is below the ${l.amount} this slice needs`;
                    return;
                }
            }
            const b = this.best(l.amount);
            if (typeof b === 'string') {
                l.waiting = b;
                return;
            }
            if (spec.maxSliceImpactBps !== undefined && b.impact > spec.maxSliceImpactBps) {
                l.waiting = `this slice would move the price ${b.impact} bps, above the ${spec.maxSliceImpactBps} bps limit`;
                return;
            }
            if (spec.limitPriceE18 !== undefined) {
                if (!b.v.spotPriceE18) {
                    l.waiting = `venue ${b.v.id} cannot report a spot price, so the price limit cannot be checked`;
                    return;
                }
                const px = b.v.spotPriceE18(spec.token, spec.quoteToken);
                if (spec.side === 'buy' && px > spec.limitPriceE18) {
                    l.waiting = `price ${px} is above your limit ${spec.limitPriceE18}`;
                    return;
                }
                if (spec.side === 'sell' && px < spec.limitPriceE18) {
                    l.waiting = `price ${px} is below your limit ${spec.limitPriceE18}`;
                    return;
                }
            }
            l.waiting = undefined;
            l.status = 'inflight';
            this.outbox.push({ idempotencyKey: l.key, userId: spec.userId, walletId: spec.walletId, chain: spec.chain, tokenIn: this.tin, tokenOut: this.tout, amountIn: l.amount, minOut: 0n,
                slippageBps: spec.slippageBps, deadline: chain.time + (spec.deadlineS ?? 120), maxFeeBps: spec.maxFeeBps ?? 200, venues: spec.venues, origin: 'twap' });
            return; // one slice at a time
        }
    }
    async flushOutbox() {
        const done = [];
        for (const i of [...this.outbox]) {
            try {
                await this.d.engine.submit(i);
            }
            catch (e) {
                const l = this.slice(i.idempotencyKey);
                if (l) {
                    l.status = 'failed';
                    l.reason = e.message;
                }
                this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey);
                this.checkpoint();
                continue;
            }
            this.inflight.add(i.idempotencyKey);
            this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey);
            done.push(i.idempotencyKey);
            this.checkpoint();
        }
        return done;
    }
    /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach to engine records, settle. */
    async resume() { await this.flushOutbox(); for (const [k, r] of this.d.engine.d.store.records)
        if (k.startsWith(`twap:${this.d.spec.id}:`) && !TERMINAL.has(r.state) && !k.endsWith(':approve') && !this.inflight.has(k) && this.slice(k))
            this.inflight.add(k); this.checkpoint(); await this.settle(); }
    async settle() {
        for (const key of [...this.inflight]) {
            const r = await this.d.engine.advance(key);
            if (!TERMINAL.has(r.state))
                continue;
            const l = this.slice(key);
            if (l) {
                if (r.state === 'finalized' && r.fill) {
                    l.status = 'filled';
                    l.spent = r.fill.spent;
                    l.received = r.fill.received;
                    l.reason = undefined;
                }
                else {
                    l.status = 'failed';
                    l.reason = r.history.at(-1)?.note ?? r.state;
                }
            }
            this.inflight.delete(key);
            this.checkpoint();
        }
    }
    summary() {
        const c = (s) => this.slices.filter(l => l.status === s).length, spent = this.slices.reduce((a, l) => a + (l.spent ?? 0n), 0n), received = this.slices.reduce((a, l) => a + (l.received ?? 0n), 0n);
        const quote = this.d.spec.side === 'buy' ? spent : received, tok = this.d.spec.side === 'buy' ? received : spent;
        return { id: this.d.spec.id, side: this.d.spec.side, slices: this.slices.map(l => ({ ...l })), filled: c('filled'), failed: c('failed'), skipped: c('skipped'), open: c('pending') + c('inflight'), spent, received,
            avgPriceE18: tok > 0n ? quote * 10n ** 18n / tok : undefined, nextDueAt: this.slices.find(l => l.status === 'pending')?.dueAt, done: c('pending') + c('inflight') === 0 && this.outbox.length === 0, cancelled: this.cancelled, refused: this.refused };
    }
}
