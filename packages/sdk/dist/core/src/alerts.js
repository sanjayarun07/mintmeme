/**
 * Alerts, community bot decision logic, and trending. Pure logic: no network, no clock (callers pass time).
 * Delivery is injected; nothing here posts anywhere except through an explicit, authorization-gated sink.
 */
// ---------- watchlists ----------
export class Watchlists {
    maxPerUser;
    m = new Map();
    constructor(maxPerUser = 100) {
        this.maxPerUser = maxPerUser;
    }
    add(userId, tokenKey) {
        const s = this.m.get(userId) ?? new Set();
        this.m.set(userId, s);
        if (!s.has(tokenKey) && s.size >= this.maxPerUser)
            return false;
        s.add(tokenKey);
        return true;
    }
    remove(userId, tokenKey) { return this.m.get(userId)?.delete(tokenKey) ?? false; }
    list(userId) { return [...(this.m.get(userId) ?? [])].sort(); }
    watchers(tokenKey) { return [...this.m].filter(([, s]) => s.has(tokenKey)).map(([u]) => u).sort(); }
}
/** Fires on cross. One-shot by default. Repeating alerts re-arm only after price retreats past threshold by hysteresis (no flapping). */
export class PriceAlerts {
    alerts = new Map();
    seenTicks = new Set();
    add(spec) {
        if (!(spec.threshold > 0) || this.alerts.has(spec.id))
            return false;
        this.alerts.set(spec.id, { oneShot: true, hysteresisBps: 100, ...spec, armed: true, active: true });
        return true;
    }
    cancel(id) { const a = this.alerts.get(id); if (!a)
        return false; a.active = false; return true; }
    evaluate(token, price, tickId) {
        const dk = `${token}:${tickId}`;
        if (this.seenTicks.has(dk))
            return []; // same tick delivered twice (provider retry) => no double fire
        this.seenTicks.add(dk);
        if (this.seenTicks.size > 10_000)
            this.seenTicks.delete(this.seenTicks.values().next().value);
        const out = [];
        for (const a of this.alerts.values()) {
            if (!a.active || a.token !== token)
                continue;
            const h = (a.hysteresisBps ?? 0) / 10_000;
            const hit = a.direction === 'above' ? price >= a.threshold : price <= a.threshold;
            if (!a.armed) {
                const retreated = a.direction === 'above' ? price <= a.threshold * (1 - h) : price >= a.threshold * (1 + h);
                if (retreated)
                    a.armed = true;
                continue;
            }
            if (hit) {
                out.push({ alertId: a.id, userId: a.userId, token, direction: a.direction, threshold: a.threshold, price, tickId });
                a.armed = false;
                if (a.oneShot)
                    a.active = false;
            }
        }
        return out;
    }
    isActive(id) { return this.alerts.get(id)?.active ?? false; }
    /** Durable state: every alert with whether it is armed and active, so a restart neither re-fires a one-shot alert nor forgets a live one. */
    snapshot() { return [...this.alerts.values()].map(a => ({ ...a })); }
    load(list) { this.alerts = new Map(list.map(a => [a.id, { ...a }])); }
}
export const eventKey = (e) => `${e.chain}:${e.txHash}:${e.logIndex}`;
export function classify(e) {
    if (e.counterpartyIsBridge)
        return 'bridge';
    const ins = e.legs.filter(l => l.delta > 0n), outs = e.legs.filter(l => l.delta < 0n);
    if (ins.length && outs.length && ins.some(i => outs.every(o => o.token !== i.token)))
        return 'swap';
    if (ins.length && !outs.length && e.fromKnownDistributor)
        return 'airdrop';
    return 'transfer';
}
export class WalletAlerts {
    cfg;
    watched = new Map(); // wallet -> minValueUsd override
    sent = new Map(); // key -> alert currently standing
    constructor(cfg) {
        this.cfg = cfg;
    }
    watch(wallet, minValueUsd) { this.watched.set(wallet, minValueUsd ?? this.cfg.minValueUsd); }
    unwatch(wallet) { this.watched.delete(wallet); }
    /** Dedupe by chain:tx:logIndex. A key revoked by reorg may alert again when re-included. */
    ingest(e) {
        const min = this.watched.get(e.wallet);
        if (min === undefined)
            return null;
        if (e.valueUsd < min)
            return null;
        const key = eventKey(e);
        if (this.sent.has(key))
            return null;
        const a = { type: 'activity', key, wallet: e.wallet, kind: classify(e), whale: e.valueUsd >= this.cfg.whaleUsd, valueUsd: e.valueUsd, blockHash: e.blockHash };
        this.sent.set(key, a);
        return a;
    }
    /** Reorg: block removed. Emit revocations for every alert sent from it and forget their dedupe keys. */
    revokeBlock(chain, blockHash) {
        const out = [];
        for (const [k, a] of [...this.sent])
            if (k.startsWith(chain + ':') && a.blockHash === blockHash) {
                this.sent.delete(k);
                out.push({ type: 'revoke', key: k, wallet: a.wallet, reason: 'reorg' });
            }
        return out;
    }
}
/** Posts ONLY to groups with an explicit authorization record. No auth => never posts, regardless of other config. */
export class CommunityBot {
    o;
    auth = new Map();
    cfg = new Map();
    posts = new Map();
    seen = new Set();
    constructor(o) {
        this.o = o;
    }
    authorize(a, cfg) {
        if (!a.groupId || !a.authorizedBy || !a.evidence || !(a.authorizedAt > 0))
            return false;
        this.auth.set(a.groupId, a);
        this.cfg.set(a.groupId, { minBuyUsd: cfg.minBuyUsd, postSells: cfg.postSells ?? false });
        return true;
    }
    revoke(groupId) { this.auth.delete(groupId); this.cfg.delete(groupId); }
    isAuthorized(groupId) { return this.auth.has(groupId); }
    notify(groupId, n, now) {
        const c = this.cfg.get(groupId);
        if (!c || !this.auth.has(groupId))
            return { post: false, reason: 'group not authorized' };
        const dk = `${groupId}:${n.eventKey}`;
        if (this.seen.has(dk))
            return { post: false, reason: 'duplicate event' };
        if (n.side === 'sell' && !c.postSells)
            return { post: false, reason: 'sell notices disabled' };
        if (n.side === 'buy' && n.valueUsd < c.minBuyUsd)
            return { post: false, reason: 'below min buy' };
        const recent = (this.posts.get(groupId) ?? []).filter(t => now - t < this.o.windowS);
        if (recent.length >= this.o.maxPerWindow) {
            this.posts.set(groupId, recent);
            return { post: false, reason: 'rate limited' };
        }
        recent.push(now);
        this.posts.set(groupId, recent);
        this.seen.add(dk);
        const who = n.wallet ? ` by ${n.wallet.slice(0, 4)}...${n.wallet.slice(-4)}` : '';
        const text = `${n.side === 'buy' ? 'BUY' : 'SELL'} ${n.token} ~$${Math.round(n.valueUsd)}${who}`;
        this.o.sink?.(groupId, text);
        return { post: true, text };
    }
}
export class Trending {
    cfg;
    trades = [];
    keys = new Set();
    liq = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    setLiquidity(token, usd) { this.liq.set(token, usd); }
    ingest(t) { if (this.keys.has(t.eventKey))
        return false; this.keys.add(t.eventKey); this.trades.push(t); return true; }
    /** Wallets that bought AND sold the same token within roundTripWindow are treated as wash and excluded for that token. */
    washWallets(token, ts) {
        const wash = new Set();
        const byW = new Map();
        for (const t of ts) {
            const a = byW.get(t.wallet) ?? [];
            a.push(t);
            byW.set(t.wallet, a);
        }
        for (const [w, arr] of byW) {
            const buys = arr.filter(x => x.side === 'buy'), sells = arr.filter(x => x.side === 'sell');
            if (buys.some(b => sells.some(s => Math.abs(s.ts - b.ts) <= this.cfg.roundTripWindowS)))
                wash.add(w);
        }
        return wash;
    }
    rows(now) {
        const c = this.cfg;
        const byTok = new Map();
        for (const t of this.trades)
            if (now - t.ts <= c.windowS && t.ts <= now) {
                const a = byTok.get(t.token) ?? [];
                a.push(t);
                byTok.set(t.token, a);
            }
        const rows = [];
        for (const [token, ts] of byTok) {
            if ((this.liq.get(token) ?? 0) < c.minLiquidityUsd)
                continue;
            const wash = this.washWallets(token, ts);
            const per = new Map();
            let vol = 0;
            for (const t of ts) {
                if (t.side !== 'buy' || wash.has(t.wallet))
                    continue;
                const w = Math.pow(0.5, (now - t.ts) / c.halfLifeS);
                per.set(t.wallet, (per.get(t.wallet) ?? 0) + t.valueUsd * w);
                vol += t.valueUsd;
            }
            // each wallet contributes at most perWalletCapUsd (decayed), normalised => score is "capped wallet-equivalents" <= unique wallets
            let score = 0;
            for (const v of per.values())
                score += Math.min(v, c.perWalletCapUsd) / c.perWalletCapUsd;
            if (per.size)
                rows.push({ token, score, uniqueWallets: per.size, volumeUsd: vol, wallets: per.size });
        }
        return rows.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
    }
    /** Internal ranking (still no per-user data). */
    rank(now) { return this.rows(now).map(({ wallets, ...r }) => r); }
    /** Public aggregate: tokens with fewer than k distinct contributing wallets are omitted entirely; no wallet ids, no per-user rows. */
    publicAggregate(now) {
        return this.rows(now).filter(r => r.wallets >= this.cfg.k).map(r => ({ token: r.token, score: Math.round(r.score * 100) / 100, uniqueWallets: r.wallets }));
    }
}
