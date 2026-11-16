/** SolLeaderWatcher: a `LeaderSource` for copy trading on Solana. It READS a leader wallet's confirmed transactions (getSignaturesForAddress + getTransaction) and turns each
 *  into a `LeaderEvent` from the leader's own balance changes: no program decoding, so it sees a swap on ANY DEX (Raydium, Jupiter routes, Pump.fun...). Whether OUR engine can
 *  then copy it depends on a venue we can execute (today: Raydium AMM v4 and the Jupiter pairs configured on SolanaChain); anything else is skipped by the copy rules (fail closed).
 *  Rules: starts from NOW (never copies history); progress moves only past signatures that were fully processed; a node error throws without losing progress;
 *  an event is released only after `minConfirmations` slots and while its signature is still known to the cluster; a signature that later disappears is reported as reorged. */
import { NATIVE } from '../../core/src/index.js';
const abs = (x) => (x < 0n ? -x : x);
export class SolLeaderWatcher {
    cfg;
    rpc;
    cursors = new Map();
    known = new Set();
    holding = [];
    tracked = [];
    seeded = new Set();
    rent;
    /** signatures seen but not parseable as a swap/transfer, and why (kept short) */
    skipped = [];
    /** history() only: signature -> slot of the transaction, so callers can look up block times. */
    slots = new Map();
    /** history() only: signature -> the quote asset of a swap ('NATIVE' for SOL, else the mint). */
    quotes = new Map();
    constructor(cfg, rpc) {
        this.cfg = cfg;
        this.rpc = rpc;
    }
    snapshot() { return { cursors: [...this.cursors], known: [...this.known], holding: this.holding, tracked: this.tracked, seeded: [...this.seeded] }; }
    load(s) { this.cursors = new Map(s.cursors); this.known = new Set(s.known); this.holding = s.holding; this.tracked = s.tracked; this.seeded = new Set(s.seeded); }
    async tokenRent() { return this.cfg.tokenAccountRent ?? (this.rent ??= BigInt(await this.rpc.call('getMinimumBalanceForRentExemption', [165]))); }
    async statusOf(sig) {
        const r = await this.rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
        return r.value[0] ?? null;
    }
    /** New signatures for one leader, OLDEST first. The first ever poll only records where "now" is. */
    async fresh(leader) {
        const until = this.cursors.get(leader), out = [];
        let before;
        for (let page = 0; page < (this.cfg.maxPages ?? 5); page++) {
            const rows = await this.rpc.call('getSignaturesForAddress', [leader, { limit: 100, commitment: 'confirmed', ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
            out.push(...rows);
            if (rows.length < 100)
                break;
            before = rows[rows.length - 1].signature;
        }
        if (!until && !this.seeded.has(leader)) {
            this.seeded.add(leader);
            if (out[0])
                this.cursors.set(leader, out[0].signature);
            return [];
        } // start from now: never copy history
        return out.filter(r => !r.err).map(r => r.signature).reverse();
    }
    async poll() {
        const head = await this.rpc.call('getSlot', [{ commitment: 'confirmed' }]), depth = this.cfg.trackDepth ?? 150, reorged = [];
        // 1. events already emitted: a signature the cluster no longer knows (or that now shows an error) was dropped/forked out
        const still = [];
        for (const t of this.tracked) {
            if (head - t.slot + 1 > depth)
                continue;
            const s = await this.statusOf(t.txHash);
            if (!s || s.err)
                reorged.push({ chain: this.cfg.chain, txHash: t.txHash });
            else
                still.push(t);
        }
        this.tracked = still;
        // 2. new signatures
        const found = [];
        for (const leader of this.cfg.leaders) {
            for (const sig of await this.fresh(leader)) {
                const ev = await this.parse(sig, leader, head);
                if (ev && !this.known.has(`${ev.txHash}:${ev.logIndex}`)) {
                    found.push(ev);
                    this.known.add(`${ev.txHash}:${ev.logIndex}`);
                }
                this.cursors.set(leader, sig); // progress only after this signature was fully processed
            }
        }
        this.holding.push(...found);
        // 3. release once deep enough and still known
        const events = [], keep = [];
        for (const h of this.holding) {
            const conf = head - h.slot + 1;
            if (conf < this.cfg.minConfirmations) {
                keep.push(h);
                continue;
            }
            const s = await this.statusOf(h.txHash);
            if (!s || s.err)
                continue; // gone before we ever acted: drop, nothing to revoke
            const { slot, ...ev } = h;
            events.push({ ...ev, confirmations: conf });
            if (!this.tracked.some(t => t.txHash === h.txHash))
                this.tracked.push({ txHash: h.txHash, slot });
        }
        this.holding = keep;
        return { events, reorged };
    }
    /** Recent history of one wallet, newest first, as pure READ: no cursor, `known`, `holding` or `tracked` is touched. Examines the latest `limit` successful signatures (max 100);
     *  signatures that are not a token swap/transfer produce no event, and one the node cannot serve is skipped (a note is kept in `skipped`). */
    /** What the last history() call saw: signatures returned, how many of them failed on chain, how many successful ones were read, how many became events. */
    lastHistory = { signatures: 0, failed: 0, read: 0, listed: 0 };
    async history(leader, limit) {
        const n = Math.max(1, Math.min(Math.floor(limit), 100)), head = await this.rpc.call('getSlot', [{ commitment: 'confirmed' }]);
        const rows = await this.rpc.call('getSignaturesForAddress', [leader, { limit: Math.min(100, n * 2), commitment: 'confirmed' }]);
        const out = [], okRows = rows.filter(x => !x.err).slice(0, n);
        this.lastHistory = { signatures: rows.length, failed: rows.filter(x => x.err).length, read: okRows.length, listed: 0 };
        for (const r of okRows) {
            try {
                const ev = await this.parse(r.signature, leader, head, q => this.quotes.set(r.signature, q));
                if (ev) {
                    const { slot, ...e } = ev;
                    this.slots.set(e.txHash, slot);
                    out.push(e);
                }
            }
            catch (e) {
                this.skipped.push(`${r.signature}: ${e.message}`);
            }
        }
        this.lastHistory.listed = out.length;
        return out;
    }
    /** Transaction -> the leader's own value movement. Undefined when nothing the leader owns moved. */
    async parse(sig, leader, head, onQuote) {
        const t = await this.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (!t)
            throw new Error(`transaction ${sig} not available yet`); // throw: the cursor stays before it, so it is retried
        const m = t.meta;
        if (!m || m.err)
            return undefined;
        const keys = t.transaction.message.accountKeys, li = keys.indexOf(leader);
        if (li < 0)
            return undefined;
        const deltas = new Map(), add = (k, d) => deltas.set(k, (deltas.get(k) ?? 0n) + d);
        const before = new Map(), after = new Map();
        let created = 0n;
        const preIdx = new Set(m.preTokenBalances.map(b => b.accountIndex));
        for (const b of m.preTokenBalances)
            if (b.owner === leader) {
                const a = BigInt(b.uiTokenAmount.amount);
                before.set(b.mint, (before.get(b.mint) ?? 0n) + a);
                add(b.mint === this.cfg.wsol ? NATIVE : b.mint, -a);
            }
        for (const b of m.postTokenBalances)
            if (b.owner === leader) {
                const a = BigInt(b.uiTokenAmount.amount);
                after.set(b.mint, (after.get(b.mint) ?? 0n) + a);
                add(b.mint === this.cfg.wsol ? NATIVE : b.mint, a);
                if (!preIdx.has(b.accountIndex) && b.mint !== this.cfg.wsol)
                    created++;
            }
        // native SOL: the leader's lamport change, without the fee it paid and without rent for token accounts it opened
        let sol = BigInt(m.postBalances[li]) - BigInt(m.preBalances[li]);
        if (li === 0)
            sol += BigInt(m.fee);
        if (created > 0n)
            sol += created * await this.tokenRent();
        add(NATIVE, sol);
        const nz = [...deltas].filter(([, d]) => d !== 0n);
        if (!nz.length)
            return undefined;
        const quotes = new Set(this.cfg.quoteMints.map(q => (q === this.cfg.wsol ? NATIVE : q)));
        quotes.add(NATIVE);
        const toks = nz.filter(([k]) => !quotes.has(k)), qs = nz.filter(([k]) => quotes.has(k));
        const slot = t.slot, base = { provider: 'rpc', chain: this.cfg.chain, txHash: sig, logIndex: 0, leader, confirmations: head - slot + 1, slot };
        const none = { quoteAmount: 0n, tokenAmount: 0n, leaderBalanceBefore: 0n, leaderBalanceAfter: 0n, leaderPriceE18: 0n };
        if (toks.length === 0)
            return undefined; // only SOL / stablecoin moved: not a token trade
        if (toks.length !== 1) {
            this.skipped.push(`${sig}: ${toks.length} non-quote tokens moved`);
            return { ...base, kind: 'transfer', side: 'buy', token: toks[0][0], ...none };
        }
        const [token, td] = toks[0], q = qs.filter(([, d]) => (d > 0n) !== (td > 0n)).sort((a, b) => (abs(b[1]) > abs(a[1]) ? 1 : -1))[0];
        if (!q)
            return { ...base, kind: 'transfer', side: td > 0n ? 'buy' : 'sell', token, ...none }; // token moved with no opposite quote leg (gift, send)
        const tokenAmount = abs(td), quoteAmount = abs(q[1]);
        onQuote?.(q[0]);
        return { ...base, kind: 'swap', side: td > 0n ? 'buy' : 'sell', token, quoteAmount, tokenAmount, leaderBalanceBefore: before.get(token) ?? 0n, leaderBalanceAfter: after.get(token) ?? 0n,
            leaderPriceE18: quoteAmount * 10n ** 18n / tokenAmount };
    }
}
