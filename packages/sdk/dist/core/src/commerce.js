export const DAY_MS = 86_400_000;
export function defaultTierConfig() {
    return { freeTier: 'free', periodMs: 30 * DAY_MS, asset: 'USD',
        tiers: {
            free: { id: 'free', priceUnits: 0n, limits: { walletsPerChain: 1, monitors: 1, copyWallets: 1, snipes: 1, limitOrders: 3 } },
            premium: { id: 'premium', priceUnits: 1000000n, limits: { walletsPerChain: 5, monitors: 20, copyWallets: 10, snipes: 10, limitOrders: 50 } },
        } };
}
export function enforce(cfg, tier, kind, currentCount) {
    const t = cfg.tiers[tier];
    if (!t)
        return { allow: false, reason: `unknown tier ${tier}` };
    const max = t.limits[kind];
    if (!Number.isInteger(currentCount) || currentCount < 0)
        return { allow: false, reason: 'invalid count' };
    return currentCount < max ? { allow: true } : { allow: false, reason: `${kind} limit ${max} reached on ${tier}` };
}
/** Subscription state is derived by replaying non-refunded payments, so refund/renewal ordering cannot corrupt it. */
export class Subscriptions {
    l;
    cfg;
    payments = [];
    constructor(l, cfg) {
        this.l = l;
        this.cfg = cfg;
    }
    /** Purchase or renew. Idempotent per paymentId. A renewal while active extends from the current expiry. */
    purchase(paymentId, user, tier, now) {
        const t = this.cfg.tiers[tier];
        if (!t || tier === this.cfg.freeTier)
            throw new Error('not a paid tier');
        if (this.payments.some(p => p.id === paymentId))
            return false;
        if (!this.l.post(`sub:${paymentId}`, paymentId, this.cfg.asset, [[`cash:${user}`, -t.priceUnits], ['revenue:subscriptions', t.priceUnits]]))
            return false;
        this.payments.push({ id: paymentId, user, tier, at: now, price: t.priceUnits, asset: this.cfg.asset, refunded: false });
        return true;
    }
    /** Refund reverses the ledger posting and removes the paid period (idempotent). */
    refund(paymentId) {
        const p = this.payments.find(x => x.id === paymentId);
        if (!p || p.refunded)
            return false;
        p.refunded = true;
        this.l.reverse(`sub:${paymentId}`);
        return true;
    }
    state(user) {
        let exp = 0, tier = this.cfg.freeTier;
        for (const p of this.payments.filter(x => x.user === user && !x.refunded).sort((a, b) => a.at - b.at)) {
            exp = Math.max(p.at, exp) + this.cfg.periodMs;
            tier = p.tier;
        }
        return { exp, tier };
    }
    expiresAt(user) { return this.state(user).exp; }
    /** Effective tier at `now`; falls back to free after expiry. */
    tierOf(user, now) { const s = this.state(user); return now < s.exp ? s.tier : this.cfg.freeTier; }
    enforce(user, kind, currentCount, now) { return enforce(this.cfg, this.tierOf(user, now), kind, currentCount); }
}
export function feeBps(s, chain, tier) {
    const c = s.chains[chain];
    if (!c)
        throw new Error(`no fee config for ${chain}`);
    const b = c.bps[tier] ?? c.bps.default;
    if (b < 0 || b > 10_000)
        throw new Error('bad fee bps');
    return b;
}
export class FeeCollector {
    l;
    sched;
    sweeps = new Map();
    constructor(l, sched) {
        this.l = l;
        this.sched = sched;
    }
    /** Computes and books the fee for a trade. in-tx: straight to revenue. accrued: held in fees:accrued:<chain> until swept. Returns the fee. */
    charge(tradeId, chain, user, tier, notional, asset) {
        const fee = notional * BigInt(feeBps(this.sched, chain, tier)) / 10000n;
        const c = this.sched.chains[chain];
        if (fee > 0n)
            this.l.post(`fee:${tradeId}`, tradeId, asset, [[`customer:${user}`, -fee], [c.mode === 'in-tx' ? 'revenue' : `fees:accrued:${chain}`, fee]]);
        return fee;
    }
    /** Reorg: undo a fee booking. If already swept the accrued account goes negative (a visible clawback, never silent). */
    reverseCharge(tradeId) { return this.l.reverse(`fee:${tradeId}`); }
    /** Move accrued fees to revenue. Debits exactly once per sweepId; below per-chain minimum nothing happens and the id stays usable. */
    sweep(sweepId, chain, asset) {
        const c = this.sched.chains[chain];
        if (!c)
            throw new Error(`no fee config for ${chain}`);
        if (c.mode !== 'accrued-then-swept')
            return { swept: 0n, reason: 'chain collects in-tx' };
        if (this.sweeps.has(sweepId))
            return { swept: 0n, reason: 'already swept' };
        const bal = this.l.balance(`fees:accrued:${chain}`, asset);
        if (bal <= 0n || bal < c.sweepMin)
            return { swept: 0n, reason: 'below sweep minimum' };
        this.sweeps.set(sweepId, bal);
        this.l.post(`sweep:${sweepId}`, sweepId, asset, [[`fees:accrued:${chain}`, -bal], ['revenue', bal]]);
        return { swept: bal };
    }
}
export class ReferralBook {
    cfg;
    sticky = new Map();
    tokenLinks = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    /** First valid referrer wins and is immutable. Invalid: self, or a cycle (referrer is already downstream of user). Token links on an already-referred user only add a per-token split. */
    attribute(user, referrer, token) {
        if (!referrer || user === referrer || this.wouldCycle(user, referrer))
            return 'ignored';
        const existing = this.sticky.get(user);
        if (!existing) {
            this.sticky.set(user, referrer);
            return 'sticky';
        }
        if (token && referrer !== existing && !this.tokenLinks.has(`${user}|${token}`)) {
            this.tokenLinks.set(`${user}|${token}`, referrer);
            return 'token-split';
        }
        return 'ignored';
    }
    wouldCycle(user, referrer) { let r = referrer; for (let i = 0; r && i < 1000; i++) {
        if (r === user)
            return true;
        r = this.sticky.get(r);
    } return false; }
    referrerOf(user) { return this.sticky.get(user); }
    /** Referrals to pass to accrue() for a trade in `token`: the original referrer, split with the token-link referrer if one exists. */
    referralsFor(user, token) {
        const orig = this.sticky.get(user);
        if (!orig)
            return [];
        const tl = token ? this.tokenLinks.get(`${user}|${token}`) : undefined;
        const total = this.cfg.commissionBps;
        if (!tl)
            return [{ referrer: orig, commissionBps: total }];
        const toToken = Math.floor(total * this.cfg.tokenSplitBps / 10_000);
        return [{ referrer: orig, commissionBps: total - toToken }, { referrer: tl, commissionBps: toToken }];
    }
}
/** Reorg: reverse a trade's accrual (commission, cashback, revenue). */
export function reverseAccrual(l, tradeId) { return l.reverse(`accrue:${tradeId}`); }
/** Base cashback plus the single largest active boost (boosts do not stack), capped. */
export function effectiveCashbackBps(base, campaigns, now, token, capBps = 10_000) {
    const boost = campaigns.filter(c => now >= c.start && now < c.end && (!c.tokens || (token !== undefined && c.tokens.includes(token)))).reduce((m, c) => Math.max(m, c.boostBps), 0);
    return Math.min(capBps, base + boost);
}
/** Leaderboard by OUR platform volume only. Volume is credited solely from recorded, confirmed, unflagged platform trades; nothing is ever synthesized. */
export class Competition {
    l;
    cfg;
    credited = new Map();
    paid = false;
    constructor(l, cfg) {
        this.l = l;
        this.cfg = cfg;
    }
    record(t) {
        if (this.paid)
            return { counted: 0n, reason: 'finalized' };
        if (t.source !== 'platform')
            return { counted: 0n, reason: 'not platform volume' };
        if (!t.confirmed)
            return { counted: 0n, reason: 'unconfirmed' };
        if (t.flagged || this.l.isFlagged(t.id))
            return { counted: 0n, reason: 'flagged' };
        if (t.t < this.cfg.start || t.t >= this.cfg.end)
            return { counted: 0n, reason: 'outside window' };
        if (t.notional < this.cfg.minTradeNotional || t.notional <= 0n)
            return { counted: 0n, reason: 'below min trade size' };
        if (this.credited.has(t.id))
            return { counted: 0n, reason: 'duplicate' };
        const room = this.cfg.perUserTokenCap - this.userToken(t.user, t.token);
        const amount = room <= 0n ? 0n : t.notional < room ? t.notional : room;
        this.credited.set(t.id, { user: t.user, token: t.token, amount });
        return amount ? { counted: amount } : { counted: 0n, reason: 'per-token cap reached' };
    }
    /** Reorg: remove a trade's volume. Not allowed after prizes were paid. */
    reverse(tradeId) { if (this.paid)
        return false; return this.credited.delete(tradeId); }
    userToken(user, token) { let s = 0n; for (const c of this.credited.values())
        if (c.user === user && c.token === token)
            s += c.amount; return s; }
    volume(user) { let s = 0n; for (const c of this.credited.values())
        if (c.user === user)
            s += c.amount; return s; }
    /** Volume desc; ties broken by user id ascending (deterministic, input-order independent). */
    leaderboard() {
        const v = new Map();
        for (const c of this.credited.values())
            if (c.amount > 0n)
                v.set(c.user, (v.get(c.user) ?? 0n) + c.amount);
        return [...v].map(([user, volume]) => ({ user, volume })).sort((a, b) => (a.volume === b.volume ? (a.user < b.user ? -1 : 1) : a.volume > b.volume ? -1 : 1)).map((r, i) => ({ rank: i + 1, ...r }));
    }
    /** Pay prizes from the prize pool into reward balances; one payout per rank, idempotent. Requires the window to have ended. */
    payPrizes(now) {
        if (now < this.cfg.end)
            throw new Error('competition still running');
        const board = this.leaderboard();
        let n = 0;
        this.cfg.prizes.forEach((amt, i) => { const r = board[i]; if (!r || amt <= 0n)
            return; if (this.l.post(`prize:${this.cfg.id}:${r.rank}`, this.cfg.id, this.cfg.asset, [['prize:pool', -amt], [`rewards:${r.user}`, amt]]))
            n++; });
        this.paid = true;
        return n;
    }
}
