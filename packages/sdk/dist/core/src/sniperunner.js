import { LaunchDetector, Sniper, exitOrders } from './snipe.js';
import { rep, rev } from './store.js';
import { toBackend } from './durable.js';
const TERMINAL = new Set(['finalized', 'failed', 'expired']);
/** The honest risk report for a networked chain: it states what was NOT checked. Taxes are measured only AFTER the buy (fill shortfall). */
export const unverifiedRisk = (launch, block, now) => ({ token: launch.token, generatedAt: now, block, verdict: 'warn',
    flags: ['no pre-trade sell or tax simulation on this port: honeypots and sell tax are NOT detected before the buy (spend is bounded by maxSpend and maxAttempts)'], notes: [],
    disclaimer: 'Only the buy was dry-run (eth_call). A passing check is not a safety certification.' });
/**
 * Launch sniping on a networked chain: LaunchSource -> LaunchDetector -> eligibility (a dry-run of the REAL buy must succeed; a revert such as "trading not enabled"
 * is waited out, never bypassed, and costs no attempt) -> Sniper limits (budget, attempts, delay, liquidity, valuation) -> Engine -> exits through OrderRunner.
 * Durable like the other runners: write-ahead checkpoint of detector, sniper, outbox, in-flight keys and the source cursor; exits are placed idempotently.
 * No mempool, no front-running: it acts only on MINED launch events and current pool state, so it is always after the launch tx.
 */
export class SnipeRunner {
    d;
    detector = new LaunchDetector();
    sniper;
    outbox = [];
    inflight = new Set();
    /** why each launch was not bought (last evaluation) and what each filled attempt measured */
    status = new Map();
    pools = new Map();
    results = new Map();
    /** launches that FILLED but whose exit orders could not be placed (position is open without exits: needs the user's attention) */
    exitErrors = new Map();
    lastError;
    backend;
    constructor(d) {
        this.d = d;
        const view = { get block() { return d.chain.block; }, get time() { return d.chain.time; }, balance: () => 0n, tokens: new Map(), state: d.chain.state };
        this.sniper = new Sniper(view, { ...d.cfg, riskCheck: d.cfg.riskCheck ?? ((l, _a) => unverifiedRisk(l, d.chain.block, d.chain.time)) });
        this.backend = d.persistPath === undefined ? undefined : toBackend(d.persistPath);
        const saved = this.backend?.read();
        if (saved) {
            const o = JSON.parse(saved, rev);
            if (o.v !== 1)
                throw new Error(`unsupported snipe state version ${o.v}`);
            this.detector.load(o.detector);
            this.sniper.load(o.sniper);
            this.outbox = o.outbox;
            this.inflight = new Set(o.inflight);
            this.results = new Map(o.results);
            d.source.load(o.source);
        }
    }
    checkpoint() {
        this.backend?.write(JSON.stringify({ v: 1, detector: this.detector.snapshot(), sniper: this.sniper.snapshot(), outbox: this.outbox, inflight: [...this.inflight], results: [...this.results], source: this.d.source.snapshot() }, rep));
    }
    launchKeyOf(attemptKey) { for (const [lk, st] of this.sniper.states)
        if (st.attempts.some(a => a.key === attemptKey))
            return lk; }
    async tick() {
        const { chain, source, cfg } = this.d;
        try {
            await chain.refresh?.('head');
        }
        catch (e) {
            this.lastError = `node unreachable: ${e.message}`;
            await this.settle().catch(() => { });
            return { events: 0, submitted: [], error: this.lastError };
        }
        let r;
        try {
            r = await source.poll();
        }
        catch (e) {
            this.lastError = `launch scan failed: ${e.message}`;
            await this.settle();
            return { events: 0, submitted: [], error: this.lastError };
        }
        this.lastError = undefined;
        for (const x of r.reorged)
            this.detector.revoke(x.chain, x.txHash);
        for (const e of r.events)
            this.detector.onEvent(e);
        for (const l of this.detector.launches()) {
            const p = l.venueId && source.pairs.get(l.token);
            if (p && l.venueId) {
                chain.addPool?.({ id: l.venueId, pair: p.pair });
                this.pools.set(l.key, l.venueId);
            }
            else if (l.status === 'revoked' && this.pools.has(l.key)) {
                chain.removePool?.(this.pools.get(l.key));
                this.pools.delete(l.key);
            } // a reorged-out pool must not break every later refresh
        }
        try {
            await chain.refresh?.('venues');
        }
        catch (e) {
            this.lastError = `pool refresh failed: ${e.message}`;
            return { events: r.events.length, submitted: [], error: this.lastError };
        }
        for (const l of this.detector.launches()) {
            if (l.chain !== cfg.chain || (l.status !== 'tradable' && l.status !== 'graduated')) {
                this.status.set(l.key, `launch ${l.status}`);
                continue;
            }
            const st = this.sniper.state(l.key), remaining = cfg.maxSpend - st.committed;
            if (st.done || st.attempts.some(a => a.status === 'inflight') || remaining <= 0n) {
                this.status.set(l.key, st.done ? 'filled' : remaining <= 0n ? 'budget committed' : 'attempt in flight');
                continue;
            }
            if (l.venueId && !chain.venues().some(v => v.id === l.venueId)) {
                this.status.set(l.key, 'pool not loaded yet');
                continue;
            }
            // eligibility: dry-run the real buy. A revert (e.g. "trading not enabled") means "not yet": wait, never bypass, no attempt consumed.
            if (chain.simulate) {
                const tx = { hash: 'preflight', wallet: cfg.walletId, nonce: 0, venue: l.venueId, tokenIn: cfg.quoteToken, tokenOut: l.token, amountIn: remaining, minOut: 0n, deadline: chain.time + 60, platformFeeBps: 0, kind: 'swap' };
                try {
                    const sim = await chain.simulate(tx);
                    if (sim.receipt.status === 'reverted') {
                        this.status.set(l.key, `not tradable yet: ${sim.receipt.reason ?? 'buy dry-run reverted'}`);
                        continue;
                    }
                }
                catch (e) {
                    this.status.set(l.key, `dry-run failed: ${e.message}`);
                    continue;
                }
            }
            try {
                await this.d.inspect?.(l);
            }
            catch (e) {
                this.status.set(l.key, `inspection failed: ${e.message}`);
                continue;
            }
            const dec = this.sniper.decide(l, { address: l.token, lpLockedPct: null });
            if (!dec.ok) {
                this.status.set(l.key, `${dec.code}: ${dec.reason}`);
                continue;
            }
            this.status.set(l.key, 'buy emitted');
            this.outbox.push(dec.intent);
        }
        this.checkpoint(); // write-ahead: decision (attempt counted, budget committed) hits disk before submit
        const submitted = await this.flushOutbox();
        await this.settle();
        return { events: r.events.length, submitted };
    }
    async flushOutbox() {
        const done = [];
        for (const i of [...this.outbox]) {
            await this.d.engine.submit(i);
            this.inflight.add(i.idempotencyKey);
            this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey);
            done.push(i.idempotencyKey);
            this.checkpoint();
        }
        return done;
    }
    async resume() { await this.flushOutbox(); this.adopt(); this.checkpoint(); await this.settle(); }
    adopt() { for (const [k, r] of this.d.engine.d.store.records)
        if (k.startsWith('snipe:') && !TERMINAL.has(r.state) && !k.endsWith(':approve') && !this.inflight.has(k) && this.launchKeyOf(k))
            this.inflight.add(k); }
    async settle() {
        for (const key of [...this.inflight]) {
            const r = await this.d.engine.advance(key);
            if (!TERMINAL.has(r.state))
                continue;
            const lk = this.launchKeyOf(key);
            if (lk) {
                if (r.state === 'finalized' && r.fill) {
                    this.sniper.report(lk, key, { ok: true, tokens: r.fill.received, spent: r.fill.spent });
                    const tax = r.fill.quotedOut > 0n ? Number(r.fill.shortfall * 10000n / r.fill.quotedOut) : 0;
                    this.results.set(lk, { tokens: r.fill.received, spent: r.fill.spent, buyTaxBps: tax });
                    if (this.d.orders && this.d.cfg.exit) {
                        const launch = this.detector.launches().find(l => l.key === lk);
                        try {
                            if (launch)
                                for (const o of exitOrders(this.d.cfg, launch, { tokens: r.fill.received, quoteSpent: r.fill.spent }, this.d.chain.time))
                                    if (!this.d.orders.orders.orders.has(o.id))
                                        await this.d.orders.place(o);
                            this.exitErrors.delete(lk);
                        }
                        catch (e) {
                            this.exitErrors.set(lk, e.message);
                            this.status.set(lk, `filled, but exit orders were NOT placed: ${e.message}`);
                        } // never wedge the runner on this
                    }
                }
                else
                    this.sniper.report(lk, key, { ok: false });
            }
            this.inflight.delete(key);
            this.checkpoint();
        }
    }
}
