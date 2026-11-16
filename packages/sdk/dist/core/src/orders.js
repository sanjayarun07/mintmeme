const E18 = 10n ** 18n;
export class OrderManager {
    res;
    run;
    now;
    clockMs;
    gate;
    orders = new Map();
    claimed = new Set();
    constructor(res, run, now, clockMs, 
    /** Optional plan-limit gate: called with the user's current active-order count before placing; a deny makes place() throw with the reason. */
    gate) {
        this.res = res;
        this.run = run;
        this.now = now;
        this.clockMs = clockMs;
        this.gate = gate;
    }
    /** Copy of the state worth persisting (orders incl. attempts/peaks, OCO claims). bigint values are kept as bigint: serialize with store.ts rep/rev. Reservations are snapshotted by their owner. */
    snapshot() { return { orders: [...this.orders.values()].map(o => structuredClone(o)), claimed: [...this.claimed] }; }
    load(s) { this.orders = new Map(s.orders.map(o => [o.id, structuredClone(o)])); this.claimed = new Set(s.claimed); }
    place(o) {
        if (this.gate) {
            const active = [...this.orders.values()].filter(x => x.userId === o.userId && x.status === 'active').length;
            const d = this.gate(o, active);
            if (!d.allow)
                throw new Error(`plan limit: ${d.reason}`);
        }
        if (o.mcap) {
            const s = o.mcap.supply, sup = o.mcap.basis === 'circulating' ? s.circulating : s.total;
            if (!sup || sup <= 0n || !s.source) {
                o.status = 'disabled';
                o.reason = `${o.mcap.basis} supply unavailable; trigger disabled`;
                this.orders.set(o.id, o);
                return o;
            }
            o.triggerPriceE18 = o.mcap.targetE18 / sup;
        }
        // reservation: sells reserve the token (OCO group reserves ONCE, shared); buys reserve the budget
        const sell = o.kind !== 'limit_buy', tok = sell ? o.token : o.quoteToken, owner = o.ocoGroup ? `oco:${o.ocoGroup}` : `order:${o.id}`;
        if (!(o.ocoGroup && this.res.held_(owner, o.walletId, tok) > 0n))
            this.res.reserve(owner, o.walletId, tok, o.amount);
        o.status = 'active';
        o.attempts = 0;
        this.orders.set(o.id, o);
        return o;
    }
    cancel(id) { const o = this.orders.get(id); if (!o || o.status !== 'active')
        return; o.status = 'cancelled'; this.maybeRelease(o); }
    owner(o) { return o.ocoGroup ? `oco:${o.ocoGroup}` : `order:${o.id}`; }
    maybeRelease(o) {
        const live = [...this.orders.values()].some(x => x !== o && x.status === 'active' && this.owner(x) === this.owner(o));
        if (!live)
            this.res.release(this.owner(o), o.walletId, o.kind === 'limit_buy' ? o.quoteToken : o.token);
    }
    /** Evaluate against a fresh snapshot AND an executable quote; never trigger from a stale/illiquid/unexecutable price. */
    evaluate(o, s) {
        const nowS = this.now();
        if (o.expiresAt <= nowS)
            return { fire: false, why: 'expired' };
        if (this.clockMs() - s.ts > o.maxQuoteAgeMs)
            return { fire: false, why: 'stale quote' };
        if (s.liquidity < o.minLiquidity)
            return { fire: false, why: 'liquidity below minimum' };
        const t = o.triggerPriceE18;
        let hit = false;
        if (o.kind === 'trailing_stop') {
            o.peakE18 = o.peakE18 && o.peakE18 > s.priceE18 ? o.peakE18 : s.priceE18;
            hit = s.priceE18 <= o.peakE18 * BigInt(10_000 - (o.trailBps ?? 0)) / 10000n;
        }
        else if (t === undefined)
            return { fire: false, why: 'no trigger price' };
        else if (o.kind === 'limit_buy')
            hit = s.priceE18 <= t;
        else if (o.kind === 'stop_loss')
            hit = s.priceE18 <= t;
        else
            hit = s.priceE18 >= t;
        if (!hit)
            return { fire: false, why: 'trigger not met' };
        // executable-output requirement: floor = amount * ref * (1 - maxDeviation)
        const ref = o.kind === 'trailing_stop' ? s.priceE18 : t;
        const sell = o.kind !== 'limit_buy';
        const required = sell ? o.amount * ref / E18 * BigInt(10_000 - o.maxDeviationBps) / 10000n
            : o.amount * E18 / ref * BigInt(10_000 - o.maxDeviationBps) / 10000n;
        const out = s.executableOut(o);
        if (out < required)
            return { fire: false, why: `executable output ${out} < required ${required}` };
        return { fire: true, why: 'trigger met and executable' };
    }
    tick(snapOf) {
        const fired = [];
        for (const o of this.orders.values()) {
            if (o.status !== 'active')
                continue;
            if (o.expiresAt <= this.now()) {
                o.status = 'expired';
                this.maybeRelease(o);
                continue;
            }
            const snap = snapOf(o);
            if (!snap)
                continue;
            const ev = this.evaluate(o, snap);
            o.reason = ev.why;
            if (!ev.fire)
                continue;
            if (o.ocoGroup) {
                if (this.claimed.has(o.ocoGroup))
                    continue;
                this.claimed.add(o.ocoGroup);
            } // atomic claim: one leg only
            o.status = 'fired';
            fired.push(o.id);
            for (const sib of this.orders.values())
                if (sib !== o && sib.ocoGroup && sib.ocoGroup === o.ocoGroup && sib.status === 'active')
                    sib.status = 'cancelled';
            const sell = o.kind !== 'limit_buy';
            this.run({ idempotencyKey: `order:${o.id}:a${o.attempts}`, userId: o.userId, walletId: o.walletId, chain: o.chain,
                tokenIn: sell ? o.token : o.quoteToken, tokenOut: sell ? o.quoteToken : o.token, amountIn: o.amount, minOut: 0n,
                slippageBps: o.slippageBps, deadline: this.now() + 120, maxFeeBps: 200, venues: o.venues, origin: 'order' });
        }
        return fired;
    }
    /** Execution result callback: bounded retries with unchanged limits; reservation released on terminal outcome. */
    onResult(id, ok) {
        const o = this.orders.get(id);
        const key = o.kind === 'limit_buy' ? o.quoteToken : o.token;
        if (ok) {
            this.res.release(this.owner(o), o.walletId, key);
            return;
        }
        o.attempts++;
        if (o.attempts >= o.maxAttempts) {
            o.status = 'failed';
            this.res.release(this.owner(o), o.walletId, key);
            if (o.ocoGroup)
                this.claimed.delete(o.ocoGroup);
        }
        else {
            o.status = 'active';
            if (o.ocoGroup)
                this.claimed.delete(o.ocoGroup);
        } // same limits, no slippage widening
    }
}
