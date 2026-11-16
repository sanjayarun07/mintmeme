import { rep, rev } from './store.js';
import { toBackend } from './durable.js';
/** BULK BUY and BULK SELL (Maestro "Multi-Wallet": buy the same token from several of your wallets at once). One request, up to 10 wallets, each leg an ordinary Engine intent from ITS OWN wallet,
 *  so every wallet keeps its own policy, limits, nonce and idempotency. What this is NOT: an atomic basket. Legs are independent transactions; any can fail while others land, and the
 *  report says exactly which. The legs trade the same pool one after another, so each moves the price for the next: `maxImpactBps` bounds the price impact of the WHOLE amount up front
 *  (each leg's own slippage guard only protects against price movement since that leg was quoted, not against the earlier legs moving it). */
export const MAX_BULK_WALLETS = 10;
export function validateBulk(s) {
    if (!s.id)
        throw new Error('bulk order needs an id');
    if (s.token === s.quoteToken)
        throw new Error('token and quote token are the same');
    const cap = Math.min(s.maxWallets ?? MAX_BULK_WALLETS, MAX_BULK_WALLETS);
    if (!s.legs.length)
        throw new Error('bulk buy needs at least one wallet');
    if (s.legs.length > cap)
        throw new Error(`bulk buy supports at most ${cap} wallets, got ${s.legs.length}`);
    if (new Set(s.legs.map(l => l.walletId)).size !== s.legs.length)
        throw new Error('the same wallet appears twice');
    for (const l of s.legs)
        if (l.amount <= 0n)
            throw new Error(`wallet ${l.walletId}: amount must be positive`);
    const total = s.legs.reduce((a, l) => a + l.amount, 0n);
    if (s.maxTotal !== undefined && total > s.maxTotal)
        throw new Error(`total ${total} exceeds maxTotal ${s.maxTotal}`);
    if (!Number.isInteger(s.slippageBps) || s.slippageBps < 0 || s.slippageBps > 10_000)
        throw new Error('slippageBps must be a whole number 0..10000');
    if (s.perTick !== undefined && (!Number.isInteger(s.perTick) || s.perTick < 1))
        throw new Error('perTick must be a positive whole number');
}
/** Split `total` equally; the remainder (one unit each) goes to the first wallets so the legs sum to exactly `total`. */
export function splitEqual(wallets, total) {
    if (!wallets.length)
        throw new Error('no wallets');
    const n = BigInt(wallets.length), each = total / n, extra = Number(total % n);
    return wallets.map((walletId, i) => ({ walletId, amount: each + (i < extra ? 1n : 0n) }));
}
/** Each wallet spends `pctBps` of its own balance (10_000 = all of it). Wallets with a zero result are left out. */
export function splitByBalance(balances, pctBps) {
    if (!Number.isInteger(pctBps) || pctBps < 1 || pctBps > 10_000)
        throw new Error('pctBps must be 1..10000');
    return [...balances].map(([walletId, b]) => ({ walletId, amount: b * BigInt(pctBps) / 10000n })).filter(l => l.amount > 0n);
}
const TERMINAL = new Set(['finalized', 'failed', 'expired']);
/** Durable like the other runners: a write-ahead checkpoint of the leg table, outbox and in-flight keys, so a crash re-submits the same idempotency keys and never buys a wallet twice. */
export class BulkRunner {
    d;
    legs;
    outbox = [];
    inflight = new Set();
    planned = false;
    refused;
    lastError;
    backend;
    constructor(d) {
        this.d = d;
        validateBulk(d.spec);
        this.legs = d.spec.legs.map(l => ({ walletId: l.walletId, amount: l.amount, key: `bulk:${d.spec.id}:${l.walletId}`, status: 'pending' }));
        this.backend = d.persistPath === undefined ? undefined : toBackend(d.persistPath);
        const saved = this.backend?.read();
        if (saved) {
            const o = JSON.parse(saved, rev);
            if (o.v !== 1)
                throw new Error(`unsupported bulk state version ${o.v}`);
            if (o.id !== d.spec.id)
                throw new Error(`state file belongs to bulk buy ${o.id}, not ${d.spec.id}`);
            this.legs = o.legs;
            this.outbox = o.outbox;
            this.inflight = new Set(o.inflight);
            this.planned = o.planned;
            this.refused = o.refused;
        }
    }
    get spec() { return this.d.spec; }
    checkpoint() { this.backend?.write(JSON.stringify({ v: 1, id: this.d.spec.id, legs: this.legs, outbox: this.outbox, inflight: [...this.inflight], planned: this.planned, refused: this.refused }, rep)); }
    leg(key) { return this.legs.find(l => l.key === key); }
    /** Once: check every wallet can fund its leg, and that the whole amount stays within the impact limit. Nothing is sent here. */
    async preflight() {
        const { chain, spec } = this.d;
        const refuseAll = (why) => { this.refused = why; for (const l of this.legs)
            if (l.status === 'pending') {
                l.status = 'skipped';
                l.reason = why;
            } };
        await chain.refresh?.('venues');
        if (spec.maxImpactBps !== undefined) {
            const total = this.legs.reduce((a, l) => a + l.amount, 0n);
            let best;
            const sell = spec.side === 'sell', tin = sell ? spec.token : spec.quoteToken, tout = sell ? spec.quoteToken : spec.token;
            for (const v of chain.venues()) {
                if (v.status !== 'active' || !(spec.venues.includes(v.id) || spec.venues.includes(v.family)) || !v.supports(tin, tout))
                    continue;
                try {
                    const imp = v.quote(tin, tout, total).priceImpactBps;
                    if (best === undefined || imp < best)
                        best = imp;
                }
                catch { /* unquotable here */ }
            }
            if (best === undefined)
                return refuseAll('no authorized venue can quote the total amount');
            if (best > spec.maxImpactBps)
                return refuseAll(`${spec.side === 'sell' ? 'selling' : 'buying'} the total would move the price ${best} bps, above the ${spec.maxImpactBps} bps limit`);
        }
        if (!chain.balanceOf)
            return refuseAll('this chain cannot report balances');
        for (const l of this.legs) {
            if (l.status !== 'pending')
                continue;
            const bal = BigInt(await chain.balanceOf(l.walletId, spec.side === 'sell' ? spec.token : spec.quoteToken));
            if (bal < l.amount) {
                l.status = 'skipped';
                l.reason = `balance ${bal} is below the ${l.amount} this leg needs`;
            }
        }
        this.planned = true;
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
        await this.settle(); // a leg that finished since the last tick frees the next one and moves the price
        const stopped = spec.onFailure === 'stop' && this.legs.some(l => l.status === 'failed');
        if (stopped)
            for (const l of this.legs)
                if (l.status === 'pending') {
                    l.status = 'skipped';
                    l.reason = 'stopped after an earlier leg failed';
                }
        const room = spec.perTick ?? this.legs.length, n = this.legs.filter(l => l.status === 'inflight').length, one = (spec.mode ?? 'sequential') === 'sequential' || spec.onFailure === 'stop';
        let budget = one ? Math.max(0, Math.min(room, 1 - n)) : room; // one at a time: later legs are priced after earlier ones, and 'stop' can still stop the rest
        if (budget > 0 && one && this.legs.some(l => l.status === 'pending')) {
            try {
                await chain.refresh?.('venues');
            }
            catch (e) {
                this.lastError = `pool refresh failed: ${e.message}`;
                return { submitted: [], error: this.lastError };
            }
        }
        for (const l of this.legs) {
            if (l.status !== 'pending' || budget <= 0)
                continue;
            budget--;
            l.status = 'inflight';
            this.outbox.push({ idempotencyKey: l.key, userId: spec.userId, walletId: l.walletId, chain: spec.chain, tokenIn: spec.side === 'sell' ? spec.token : spec.quoteToken, tokenOut: spec.side === 'sell' ? spec.quoteToken : spec.token, amountIn: l.amount, minOut: 0n,
                slippageBps: spec.slippageBps, deadline: chain.time + (spec.deadlineS ?? 120), maxFeeBps: spec.maxFeeBps ?? 200, venues: spec.venues, origin: 'bulk' });
        }
        this.checkpoint(); // write-ahead: every leg's decision is on disk before anything is submitted
        const submitted = await this.flushOutbox();
        await this.settle();
        return { submitted };
    }
    async flushOutbox() {
        const done = [];
        for (const i of [...this.outbox]) {
            try {
                await this.d.engine.submit(i);
            }
            catch (e) {
                const l = this.leg(i.idempotencyKey);
                if (l) {
                    l.status = 'failed';
                    l.reason = e.message;
                }
                this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey);
                this.checkpoint();
                continue;
            } // refused before sending (policy, limits): this leg only
            this.inflight.add(i.idempotencyKey);
            this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey);
            done.push(i.idempotencyKey);
            this.checkpoint();
        }
        return done;
    }
    /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach to engine records, settle. */
    async resume() { await this.flushOutbox(); for (const [k, r] of this.d.engine.d.store.records)
        if (k.startsWith(`bulk:${this.d.spec.id}:`) && !TERMINAL.has(r.state) && !k.endsWith(':approve') && !this.inflight.has(k) && this.leg(k))
            this.inflight.add(k); this.checkpoint(); await this.settle(); }
    async settle() {
        for (const key of [...this.inflight]) {
            const r = await this.d.engine.advance(key);
            if (!TERMINAL.has(r.state))
                continue;
            const l = this.leg(key);
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
    /** Run ticks until every leg is settled (or `maxTicks`). Convenience for callers that do not drive their own loop. */
    async run(opts = {}) {
        for (let i = 0; i < (opts.maxTicks ?? 60); i++) {
            await this.tick();
            if (this.summary().done)
                break;
            if (opts.waitMs)
                await new Promise(r => setTimeout(r, opts.waitMs));
        }
        return this.summary();
    }
    summary() {
        const c = (s) => this.legs.filter(l => l.status === s).length;
        return { id: this.d.spec.id, legs: this.legs.map(l => ({ ...l })), filled: c('filled'), failed: c('failed'), skipped: c('skipped'), open: c('pending') + c('inflight'),
            spent: this.legs.reduce((a, l) => a + (l.spent ?? 0n), 0n), received: this.legs.reduce((a, l) => a + (l.received ?? 0n), 0n), done: c('pending') + c('inflight') === 0 && this.outbox.length === 0, refused: this.refused };
    }
}
