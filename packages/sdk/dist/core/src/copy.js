/** Maestro's documented defaults for the settings above, for callers that want parity; spread into a config: `{ ...cfg, ...MAESTRO_COPY_DEFAULTS }`.
 *  Not applied automatically: existing callers keep their legacy behaviour. */
export const MAESTRO_COPY_DEFAULTS = { duplicateBuy: false, priceImpactAlertBps: 2000 };
/** Documented ceilings: Buy % up to 1000% (ratioBps 100_000). */
export const MAX_BUY_PCT_BPS = 100_000;
export function validateCopyConfig(c) {
    if (!Number.isInteger(c.ratioBps) || c.ratioBps < 0 || c.ratioBps > MAX_BUY_PCT_BPS)
        throw new Error(`ratioBps must be 0..${MAX_BUY_PCT_BPS} (Buy % up to 1000%)`);
    if (c.maxBuy !== undefined && c.maxBuy <= 0n)
        throw new Error('maxBuy must be positive');
    if (c.priceImpactAlertBps !== undefined && (!Number.isInteger(c.priceImpactAlertBps) || c.priceImpactAlertBps < 0))
        throw new Error('priceImpactAlertBps must be a non-negative integer');
    const k = c.checks;
    if (k) {
        if (k.minMc !== undefined && k.maxMc !== undefined && k.minMc > k.maxMc)
            throw new Error('checks: minMc is above maxMc');
        if (k.minLiq !== undefined && k.maxLiq !== undefined && k.minLiq > k.maxLiq)
            throw new Error('checks: minLiq is above maxLiq');
        for (const t of [k.maxBuyTaxBps, k.maxSellTaxBps])
            if (t !== undefined && (!Number.isInteger(t) || t < 0 || t > 10_000))
                throw new Error('checks: tax limits are whole bps 0..10000');
    }
}
/** Confirmation policy presets. fast = act on 0 confirmations (lowest latency, exposed to leader-tx reorg/drop: positions may become 'orphaned').
 *  safe = wait N confirmations (reorg-resistant, but later entry/exit and worse price). */
export const CONFIRMATION_PRESETS = {
    fast: { minConfirmations: 0, tradeoff: 'fast: 0 conf, reorg risk' },
    safe: (n = 3) => ({ minConfirmations: Math.max(1, n), tradeoff: `safe: ${Math.max(1, n)} conf, latency` }),
};
export function withConfirmationPolicy(c, preset, n) {
    return { ...c, minConfirmations: preset === 'fast' ? CONFIRMATION_PRESETS.fast.minConfirmations : CONFIRMATION_PRESETS.safe(n).minConfirmations };
}
export class CopyEngine {
    cfgs;
    market;
    run;
    now;
    seen = new Set();
    revoked = new Set();
    /** attributed inventory: `${follower}|${leader}|${token}` -> tokens bought because of that leader */
    inv = new Map();
    /** cost basis (quote units) of currently attributed inventory; reduced proportionally on sells. Per-leader cap is NET of this. */
    costBasis = new Map();
    /** buys emitted but not yet filled (counted against caps so in-flight orders cannot oversubscribe) */
    pending = new Map();
    intents = new Map();
    fills = [];
    flags = new Map();
    last = new Map();
    daily = new Map();
    log = [];
    constructor(cfgs, market, run, now) {
        this.cfgs = cfgs;
        this.market = market;
        this.run = run;
        this.now = now;
        for (const c of cfgs)
            validateCopyConfig(c);
    }
    onReorg(chain, txHash) { this.revoked.add(`${chain}:${txHash}`); this.recordReorg(chain, txHash); }
    /** Leader signal tx reorged. Pending signals are revoked (above); fills already recorded from it are reversed out of attributed
     *  inventory and the position is flagged 'orphaned'. The tokens are still in the wallet: NO automatic sell is issued. */
    recordReorg(chain, txHash) {
        this.revoked.add(`${chain}:${txHash}`);
        const hit = [];
        for (const f of this.fills) {
            if (f.reversed || !f.signal.startsWith(`${chain}:${txHash}:`))
                continue;
            f.reversed = true;
            if (f.side === 'buy') {
                const have = this.inv.get(f.k) ?? 0n, take = f.tokens < have ? f.tokens : have;
                const basis = this.costBasis.get(f.k) ?? 0n, drop = f.quote < basis ? f.quote : basis;
                this.inv.set(f.k, have - take);
                this.costBasis.set(f.k, basis - drop);
            }
            // a reorged leader SELL that we already mirrored cannot be undone; inventory stays reduced, but flag for review
            this.flags.set(f.k, `orphaned: leader signal ${f.signal} reorged after ${f.side} fill (${f.tokens} tokens); no auto-sell`);
            hit.push(f.k);
        }
        for (const k of hit)
            this.log.push({ id: `${chain}:${txHash}`, decision: `orphaned ${k}` });
        return hit;
    }
    positionStatus(f, l, t) { const k = `${f}|${l}|${t}`; return this.flags.has(k) ? 'orphaned' : this.attributed(f, l, t) > 0n ? 'open' : 'none'; }
    orphanReason(f, l, t) { return this.flags.get(`${f}|${l}|${t}`); }
    /** Net exposure: cost basis of attributed inventory plus in-flight buys. */
    exposure(f, l, tok = null) {
        let s = 0n;
        const pre = `${f}|${l}|`;
        for (const m of [this.costBasis, this.pending])
            for (const [k, v] of m)
                if (k.startsWith(pre) && (tok === null || k === `${pre}${tok}`))
                    s += v;
        return s;
    }
    /** Auto Buy Checks. Returns a skip reason, or undefined when every configured check passes. */
    checkBuy(k, m) {
        if (k.minLiq !== undefined && m.liquidity < k.minLiq)
            return 'check: liquidity below minimum';
        if (k.maxLiq !== undefined && m.liquidity > k.maxLiq)
            return 'check: liquidity above maximum';
        if (k.minMc !== undefined || k.maxMc !== undefined) {
            if (m.marketCap === undefined)
                return 'check: market cap unavailable (a market-cap check is set, so the buy is skipped)';
            if (k.minMc !== undefined && m.marketCap < k.minMc)
                return 'check: market cap below minimum';
            if (k.maxMc !== undefined && m.marketCap > k.maxMc)
                return 'check: market cap above maximum';
        }
        if (k.maxBuyTaxBps !== undefined) {
            if (m.buyTaxBps === undefined)
                return 'check: buy tax unavailable (a tax check is set, so the buy is skipped)';
            if (m.buyTaxBps > k.maxBuyTaxBps)
                return `check: buy tax ${m.buyTaxBps} bps is above ${k.maxBuyTaxBps}`;
        }
        if (k.maxSellTaxBps !== undefined) {
            if (m.sellTaxBps === undefined)
                return 'check: sell tax unavailable (a tax check is set, so the buy is skipped)';
            if (m.sellTaxBps > k.maxSellTaxBps)
                return `check: sell tax ${m.sellTaxBps} bps is above ${k.maxSellTaxBps}`;
        }
        return undefined;
    }
    skip(id, why) { this.log.push({ id, decision: `skip: ${why}` }); }
    attributed(f, l, t) { return this.inv.get(`${f}|${l}|${t}`) ?? 0n; }
    onEvent(e) {
        const id = `${e.chain}:${e.txHash}:${e.logIndex}`;
        if (this.seen.has(id))
            return this.skip(id, 'duplicate across providers'); // dedup regardless of provider
        this.seen.add(id);
        if (e.kind !== 'swap')
            return this.skip(id, `not an economic swap (${e.kind})`);
        for (const c of this.cfgs.filter(c => c.leader === e.leader && c.chain === e.chain))
            this.handle(c, e, id);
    }
    handle(c, e, id) {
        if (this.revoked.has(`${e.chain}:${e.txHash}`))
            return this.skip(id, 'reorged out');
        if (e.confirmations < c.minConfirmations)
            return this.skip(id, `needs ${c.minConfirmations} confirmations`);
        if (c.stablecoins?.includes(e.token))
            return this.skip(id, 'stablecoin trade not copied');
        if (c.block?.includes(e.token) || (c.allow && !c.allow.includes(e.token)))
            return this.skip(id, 'token filtered');
        if (c.sides !== 'both' && c.sides !== e.side)
            return this.skip(id, 'side disabled');
        const m = this.market(e.chain, e.token);
        if (m.liquidity < c.minLiquidity)
            return this.skip(id, 'liquidity below minimum');
        if (e.side === 'buy' && c.checks) {
            const why = this.checkBuy(c.checks, m);
            if (why)
                return this.skip(id, why);
        }
        const dev = e.leaderPriceE18 === 0n ? 0n : (m.priceE18 > e.leaderPriceE18 ? m.priceE18 - e.leaderPriceE18 : e.leaderPriceE18 - m.priceE18) * 10000n / e.leaderPriceE18;
        if (dev > BigInt(c.maxDeviationBps))
            return this.skip(id, 'price moved beyond deviation limit');
        const k = `${c.follower}|${c.leader}|${e.token}`;
        if (e.side === 'buy') {
            const t = this.last.get(k) ?? -Infinity;
            if (this.now() - t < c.cooldownS)
                return this.skip(id, 'cooldown');
            let amt = c.mode === 'fixed' ? c.fixed : e.quoteAmount * BigInt(c.ratioBps) / 10000n;
            const spentLeader = this.exposure(c.follower, c.leader), spentTok = this.exposure(c.follower, c.leader, e.token);
            if (c.maxBuy !== undefined)
                amt = min(amt, c.maxBuy);
            amt = min(amt, c.maxPerLeader - spentLeader, c.maxPerToken - spentTok);
            const dk = `${c.follower}:${Math.floor(this.now() / 86400)}`;
            amt = min(amt, c.dailyLimit - (this.daily.get(dk) ?? 0n));
            if (amt <= 0n)
                return this.skip(id, 'allocation/daily limit exhausted');
            const open = [...this.inv].filter(([kk, v]) => kk.startsWith(`${c.follower}|`) && v > 0n).length;
            if (this.attributed(c.follower, c.leader, e.token) === 0n && open >= c.maxPositions)
                return this.skip(id, 'max concurrent positions');
            if (c.duplicateBuy === false && (this.attributed(c.follower, c.leader, e.token) > 0n || (this.pending.get(k) ?? 0n) > 0n))
                return this.skip(id, 'duplicate buy blocked (token already held or being bought)');
            if (c.priceImpactAlertBps !== undefined) {
                const imp = m.impactBps?.(amt);
                if (imp === undefined)
                    return this.skip(id, 'price impact unavailable (alert is set, so the buy is skipped)');
                if (imp > c.priceImpactAlertBps)
                    return this.skip(id, `price impact ${imp} bps is above the ${c.priceImpactAlertBps} bps alert`);
            }
            if (c.trackOnly) {
                this.log.push({ id, decision: `track-only: would buy ${amt} of ${e.token}` });
                return;
            }
            this.last.set(k, this.now());
            this.daily.set(dk, (this.daily.get(dk) ?? 0n) + amt);
            this.pending.set(k, (this.pending.get(k) ?? 0n) + amt);
            this.emit(c, id, c.quoteToken, e.token, amt, e.token, 'buy', `${e.chain}:${e.txHash}:${e.logIndex}`);
        }
        else {
            const mine = this.attributed(c.follower, c.leader, e.token);
            if (mine === 0n)
                return this.skip(id, 'no leader-attributed inventory; unrelated holdings untouched');
            const mode = c.exitMode ?? (c.followLeaderExit ? 'full-on-exit' : 'proportional');
            if (mode === 'ignore')
                return this.skip(id, 'leader sells not followed (exitMode=ignore)');
            let amt;
            if (mode === 'full-on-any-sell' || (mode === 'full-on-exit' && e.leaderBalanceAfter === 0n))
                amt = mine;
            else {
                // floor(mine * sold / before): rounding is always DOWN, sold is clamped to the leader's prior balance, result clamped to attributed inventory
                const sold = e.tokenAmount > e.leaderBalanceBefore ? e.leaderBalanceBefore : e.tokenAmount;
                amt = e.leaderBalanceBefore === 0n ? 0n : mine * sold / e.leaderBalanceBefore;
                if (c.dustTokens !== undefined && amt > 0n && mine - amt < c.dustTokens)
                    amt = mine;
            }
            amt = min(amt, mine);
            if (amt <= 0n)
                return this.skip(id, 'sell fraction rounds to zero');
            if (c.trackOnly) {
                this.log.push({ id, decision: `track-only: would sell ${amt} of ${e.token}` });
                return;
            }
            this.emit(c, id, e.token, c.quoteToken, amt, e.token, 'sell', `${e.chain}:${e.txHash}:${e.logIndex}`);
        }
    }
    emit(c, id, tin, tout, amt, token = '', side = 'buy', signal = id) {
        this.log.push({ id, decision: 'emit' });
        const key = `copy:${c.follower}:${id}`;
        this.intents.set(key, { c, token, side, amt, signal });
        this.run({ idempotencyKey: key, userId: c.userId, walletId: c.walletId, chain: c.chain, tokenIn: tin, tokenOut: tout,
            amountIn: amt, minOut: 0n, slippageBps: c.slippageBps, deadline: this.now() + 60, maxFeeBps: 200, venues: c.venues, origin: 'copy' });
    }
    /** Call with confirmed fill only: attributes inventory to the leader. `signal` (chain:txHash:logIndex) enables reorg reversal.
     *  Buy: inventory += tokens, cost basis += quoteSpent. Sell: tokens clamped to attributed inventory, cost basis reduced proportionally. */
    recordFill(c, token, side, tokens, quoteSpent, signal = '', intentKey) {
        const k = `${c.follower}|${c.leader}|${token}`;
        const have = this.attributed(c.follower, c.leader, token);
        const it = intentKey ? this.intents.get(intentKey) : undefined;
        const sig = signal || it?.signal || '';
        if (side === 'buy') {
            this.inv.set(k, have + tokens);
            this.costBasis.set(k, (this.costBasis.get(k) ?? 0n) + quoteSpent);
            const p = this.pending.get(k) ?? 0n;
            const rel = it ? it.amt : quoteSpent; // release the reservation
            this.pending.set(k, p > rel ? p - rel : 0n);
            this.fills.push({ k, token, side, tokens, quote: quoteSpent, signal: sig, reversed: false });
        }
        else {
            const sold = tokens > have ? have : tokens, basis = this.costBasis.get(k) ?? 0n;
            this.inv.set(k, have - sold);
            this.costBasis.set(k, have === 0n ? 0n : basis - basis * sold / have);
            this.fills.push({ k, token, side, tokens: sold, quote: quoteSpent, signal: sig, reversed: false });
        }
    }
    /** Failed/expired buy: release its in-flight reservation. */
    recordFailure(intentKey) {
        const it = this.intents.get(intentKey);
        if (!it || it.side !== 'buy')
            return;
        const k = `${it.c.follower}|${it.c.leader}|${it.token}`;
        const p = this.pending.get(k) ?? 0n;
        this.pending.set(k, p > it.amt ? p - it.amt : 0n);
    }
    /** Plain-data copy of ALL mutable state (bigints preserved; serialise with rep/rev). Used for durable persistence. */
    snapshot() {
        return { seen: [...this.seen], revoked: [...this.revoked], inv: [...this.inv], costBasis: [...this.costBasis], pending: [...this.pending], intents: [...this.intents],
            fills: this.fills, flags: [...this.flags], last: [...this.last], daily: [...this.daily], log: this.log };
    }
    load(s) {
        this.seen = new Set(s.seen);
        this.revoked = new Set(s.revoked);
        this.inv = new Map(s.inv);
        this.costBasis = new Map(s.costBasis);
        this.pending = new Map(s.pending);
        this.intents = new Map(s.intents);
        this.fills = s.fills;
        this.flags = new Map(s.flags);
        this.last = new Map(s.last);
        this.daily = new Map(s.daily);
        this.log = s.log;
    }
    /** Config an emitted intent was created under (so a runner can attribute its outcome after a restart). */
    intentInfo(key) { return this.intents.get(key); }
}
const min = (...a) => a.reduce((x, y) => (y < x ? y : x));
