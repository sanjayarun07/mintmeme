const E18 = 10n ** 18n;
/** Slippage for the order's next attempt: the original value, or with chase, original + attempts x step, capped at the chase maximum (and never below the original). */
export function slippageFor(o) {
    if (!o.chase)
        return o.slippageBps;
    return Math.max(o.slippageBps, Math.min(o.slippageBps + o.attempts * o.chase.stepBps, o.chase.maxBps));
}
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
    /** Move an active order's trigger price. The reservation, amount, attempts and OCO link are kept. A bracket's take profit must stay above its stop loss.
     *  Trailing stops have no fixed trigger, and market-cap orders keep their cap target, so neither can be edited this way. */
    retrigger(id, priceE18) {
        const o = this.orders.get(id);
        if (!o)
            throw new Error(`no order ${id}`);
        if (o.status !== 'active')
            throw new Error(`only an active order can be edited (this one is ${o.status})`);
        if (o.kind === 'trailing_stop')
            throw new Error('a trailing stop has no fixed trigger price: cancel it and place a new one');
        if (o.mcap)
            throw new Error('this order triggers on market cap: cancel it and place a new one');
        if (priceE18 <= 0n)
            throw new Error('the trigger price must be above zero');
        if (o.ocoGroup)
            for (const s of this.orders.values()) {
                if (s === o || s.ocoGroup !== o.ocoGroup || s.status !== 'active' || s.triggerPriceE18 === undefined)
                    continue;
                if (o.kind === 'take_profit' && s.kind === 'stop_loss' && priceE18 <= s.triggerPriceE18)
                    throw new Error('the take profit must stay above the stop loss of the same bracket');
                if (o.kind === 'stop_loss' && s.kind === 'take_profit' && priceE18 >= s.triggerPriceE18)
                    throw new Error('the stop loss must stay below the take profit of the same bracket');
            }
        o.triggerPriceE18 = priceE18;
        o.reason = 'trigger price edited';
        return o;
    }
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
                if (this.claimed.has(o.ocoGroup)) {
                    o.reason = 'another leg of this bracket is executing';
                    continue;
                }
                this.claimed.add(o.ocoGroup);
            } // atomic claim: one leg at a time
            o.status = 'fired';
            fired.push(o.id); // the other legs stay active until this fill succeeds: a failed fill must not leave the position unprotected
            const sell = o.kind !== 'limit_buy';
            this.run({ idempotencyKey: `order:${o.id}:a${o.attempts}`, userId: o.userId, walletId: o.walletId, chain: o.chain,
                tokenIn: sell ? o.token : o.quoteToken, tokenOut: sell ? o.quoteToken : o.token, amountIn: o.amount, minOut: 0n,
                slippageBps: slippageFor(o), deadline: this.now() + 120, maxFeeBps: 200, venues: o.venues, origin: 'order' });
        }
        return fired;
    }
    /** Execution result callback. Filled: the other legs of its bracket are cancelled and the reservation released. Failed: retried (same limits, or wider slippage with chase)
     *  until maxAttempts; a leg that fails for good leaves the other legs active and releases the shared reservation only when no leg is left. */
    onResult(id, ok) {
        const o = this.orders.get(id);
        if (o.ocoGroup)
            this.claimed.delete(o.ocoGroup);
        if (ok) {
            for (const sib of this.orders.values())
                if (sib !== o && sib.ocoGroup === o.ocoGroup && o.ocoGroup && sib.status === 'active')
                    sib.status = 'cancelled';
            this.res.release(this.owner(o), o.walletId, o.kind === 'limit_buy' ? o.quoteToken : o.token);
            return;
        }
        o.attempts++;
        if (o.attempts >= o.maxAttempts) {
            o.status = 'failed';
            this.maybeRelease(o);
        }
        else
            o.status = 'active';
    }
}
