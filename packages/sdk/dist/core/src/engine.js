import { createHash } from 'node:crypto';
import { NATIVE } from './types.js';
import { RpcError } from './simchain.js';
import { PolicyRejection } from './signer.js';
import { feeBps } from './commerce.js';
// signed -> failed: the node rejected the tx outright (it was never accepted)
const NEXT = {
    created: ['validated', 'failed'], validated: ['quoted', 'failed'], quoted: ['simulated', 'failed'],
    simulated: ['awaiting_authorization', 'failed'], awaiting_authorization: ['signed', 'failed'],
    signed: ['submitted', 'unresolved', 'expired', 'failed'], submitted: ['observed', 'unresolved', 'failed', 'expired'],
    observed: ['confirmed', 'failed', 'unresolved'], confirmed: ['finalized', 'unresolved'],
    unresolved: ['submitted', 'observed', 'failed', 'expired'],
    finalized: [], failed: [], expired: [],
};
const TERMINAL = new Set(['finalized', 'failed', 'expired']);
export const day = (t) => Math.floor(t / 86400);
export class Engine {
    d;
    locks = new Map();
    maxResubmits = 3;
    /** Optional commerce wiring: fee rate comes from the schedule by user tier; the fee is booked to the ledger once the trade is FINAL (reorg-safe, idempotent per trade). */
    constructor(d) {
        this.d = d;
    }
    bps(i) { return this.d.fees ? feeBps(this.d.fees.schedule, i.chain, this.d.fees.tierOf(i.userId)) : this.d.platformFeeBps; }
    go(r, s, note) {
        if (!NEXT[r.state].includes(s))
            throw new Error(`illegal transition ${r.state} -> ${s}`);
        r.state = s;
        r.history.push({ state: s, note });
    }
    fail(r, why) { r.failure = why; this.go(r, 'failed', why); }
    /** Idempotent entry: same key never creates a second economic execution. */
    async submit(intent) {
        const { store } = this.d;
        if (!store.records.has(intent.idempotencyKey)) {
            store.records.set(intent.idempotencyKey, { key: intent.idempotencyKey, intent, state: 'created', history: [{ state: 'created' }], resubmits: 0 });
        }
        store.checkpoint(); // the intent is durable before any work on it begins
        return this.advance(intent.idempotencyKey);
    }
    /** Resumable driver. Safe to call repeatedly or after restart; per-key mutex serializes in-process callers. */
    async advance(key) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        const run = prev.then(() => this.drive(key), () => this.drive(key));
        this.locks.set(key, run.catch(() => { }));
        return run;
    }
    async drive(key) {
        const r = this.d.store.records.get(key);
        let guard = 0;
        while (!TERMINAL.has(r.state) && guard++ < 20) {
            try {
                await this.d.chain.refresh?.('head');
            }
            catch { /* node unreachable: steps below handle it */ }
            const progressed = await this.step(r);
            this.d.store.checkpoint();
            if (!progressed)
                break;
        } // checkpoint BEFORE the next step: 'signed' is on disk before the send
        return r;
    }
    async step(r) {
        const { chain, signer, router, store } = this.d;
        const i = r.intent;
        switch (r.state) {
            case 'created': {
                if (i.amountIn <= 0n)
                    this.fail(r, 'amount must be positive');
                else if (i.slippageBps < 0 || i.slippageBps > 5000)
                    this.fail(r, 'slippage out of bounds');
                else if (i.deadline <= chain.time)
                    this.fail(r, 'deadline already passed');
                else if (this.bps(i) > i.maxFeeBps)
                    this.fail(r, 'platform fee exceeds fee limit');
                else
                    this.go(r, 'validated');
                return true;
            }
            case 'validated': {
                try {
                    await chain.refresh?.('venues');
                }
                catch {
                    return false; /* node unreachable: stay validated, caller retries */
                }
                try {
                    const rt = router.route(i, this.bps(i));
                    r.quote = rt.best;
                    // never widen: minOut is the stricter of user-supplied and quote-derived
                    const derived = rt.best.amountOut * BigInt(10_000 - i.slippageBps) / 10000n;
                    r.minOut = i.minOut > derived ? i.minOut : derived;
                    this.go(r, 'quoted', `${rt.best.venue} block ${rt.best.block}`);
                }
                catch (e) {
                    this.fail(r, e.message);
                }
                return true;
            }
            case 'quoted': {
                r.tx = this.build(r);
                if (chain.needsApproval && r.tx.tokenIn !== NATIVE) { // a sell needs an on-chain allowance first: run it as its own tracked child transaction
                    for (let step = 0; step < 2; step++) {
                        let need;
                        try {
                            need = await chain.needsApproval(r.tx);
                        }
                        catch {
                            return false; /* node unreachable: stay quoted */
                        }
                        if (!need)
                            break;
                        const ck = need.amount === 0n ? `${r.key}:reset:approve` : `${r.key}:approve`;
                        if (!store.records.has(ck)) {
                            const atx = { hash: '', wallet: i.walletId, nonce: -1, venue: r.quote.venue, tokenIn: need.token, tokenOut: need.token, amountIn: need.amount, minOut: 0n, deadline: i.deadline, platformFeeBps: 0, kind: 'approve', spender: need.spender };
                            store.records.set(ck, { key: ck, intent: { ...i, idempotencyKey: ck, tokenIn: need.token, tokenOut: need.token, amountIn: need.amount }, state: 'awaiting_authorization', history: [{ state: 'created' }, { state: 'awaiting_authorization', note: need.amount === 0n ? `reset the allowance of ${need.token} for ${need.spender} to 0 first (this token refuses to change a non-zero allowance)` : `approve exactly ${need.amount} of ${need.token} for ${need.spender}` }], quote: r.quote, tx: atx, resubmits: 0 });
                        }
                        const c = await this.advance(ck);
                        if (c.state === 'failed' || c.state === 'expired') {
                            this.fail(r, `approval ${c.state}: ${c.failure ?? 'no reason recorded'}`);
                            return true;
                        }
                        if (c.state !== 'confirmed' && c.state !== 'finalized')
                            return false; // approval still in flight: stay quoted, caller re-advances
                    }
                    let again;
                    try {
                        again = await chain.needsApproval(r.tx);
                    }
                    catch {
                        return false;
                    }
                    if (again) {
                        this.fail(r, 'allowance still insufficient after the approval was confirmed');
                        return true;
                    }
                }
                try {
                    const s = await chain.simulate(r.tx);
                    r.simBlock = s.block;
                    if (s.receipt.status === 'reverted') {
                        this.fail(r, `simulation reverted at block ${s.block}: ${s.receipt.reason}`);
                        return true;
                    }
                    this.go(r, 'simulated', `block ${s.block}`);
                }
                catch (e) {
                    if (e instanceof RpcError)
                        return false; /* RPC down: remain quoted; caller retries advance() */
                    this.fail(r, `simulation could not run: ${e.message}`);
                }
                return true;
            }
            case 'simulated':
                this.go(r, 'awaiting_authorization');
                return true;
            case 'awaiting_authorization': {
                const tx = r.tx;
                // allocate nonce: max(chain confirmed, locally allocated)
                const wk = `${i.chain}:${i.walletId}`;
                let n;
                try {
                    n = Math.max(await chain.confirmedNonce(i.walletId), store.nonces.get(wk) ?? 0);
                }
                catch {
                    return false; /* node unreachable: stay awaiting_authorization */
                }
                tx.nonce = n;
                tx.hash = this.hash(r, n);
                try {
                    r.signature = signer.sign({ userId: i.userId, walletId: i.walletId, chain: i.chain, kind: tx.kind === 'approve' ? 'approve' : 'swap', token: i.tokenIn,
                        amount: i.amountIn, venue: r.quote.family, digest: tx.hash, origin: i.origin, day: day(chain.time) });
                }
                catch (e) {
                    if (e instanceof PolicyRejection) {
                        this.fail(r, `signer policy: ${e.message}`);
                        return true;
                    }
                    throw e;
                }
                r.authDigest = tx.hash; // the signer's limit charge is keyed by THIS digest (release() must use it even if prepare() changes the hash)
                if (chain.prepare) {
                    try {
                        const p = await chain.prepare(tx);
                        tx.hash = p.hash;
                        tx.raw = p.raw;
                    }
                    catch (e) {
                        this.release(r);
                        this.fail(r, `could not build transaction: ${e.message}`);
                        return true;
                    }
                }
                store.nonces.set(wk, n + 1);
                r.signDay = day(chain.time);
                this.go(r, 'signed', `nonce ${n}`); // persisted BEFORE any network send (write-ahead)
                return true;
            }
            case 'signed':
            case 'unresolved': return this.send(r);
            case 'submitted':
            case 'observed': {
                let lk;
                try {
                    lk = await chain.lookup(r.tx.hash);
                }
                catch {
                    return false;
                }
                if (lk === 'none') {
                    this.go(r, 'unresolved', 'tx not found at node');
                    return true;
                }
                if (lk === 'pending') {
                    if (r.state === 'submitted') {
                        this.go(r, 'observed', 'in mempool');
                        return true;
                    }
                    return false;
                }
                const rc = await chain.receipt(r.tx.hash);
                if (!rc)
                    return false; // the node found the transaction but cannot give its receipt yet: look again on the next step, never guess
                if (r.state === 'submitted') {
                    this.go(r, 'observed', 'included');
                    return true;
                }
                if (rc.status === 'reverted') {
                    r.fill = undefined;
                    r.confirmedBlock = rc.block;
                    this.fail(r, `reverted on-chain: ${rc.reason}`);
                    return true;
                } // included => signer charge stays
                if (r.tx.kind !== 'noop' && r.tx.kind !== 'approve')
                    r.fill = this.fillOf(r, rc); // fill always from the CURRENT receipt
                r.confirmedBlock = rc.block;
                this.go(r, 'confirmed', `block ${rc.block}`);
                return true;
            }
            case 'confirmed': {
                for (const ck of [`${r.key}:reset:approve`, `${r.key}:approve`]) {
                    const child = store.records.get(ck);
                    if (child && !TERMINAL.has(child.state))
                        await this.advance(child.key);
                } // let the approval child finish too
                const rc = await chain.receipt(r.tx.hash);
                if (!rc) {
                    this.go(r, 'unresolved', 'receipt disappeared (reorg)');
                    return true;
                }
                // reorged and re-included in a different block: old fill is stale -> re-observe, recompute from the new receipt
                if (r.confirmedBlock !== undefined && rc.block !== r.confirmedBlock) {
                    this.go(r, 'unresolved', `receipt changed (reorg) block ${r.confirmedBlock} -> ${rc.block}`);
                    return true;
                }
                if ((await chain.confirmations(rc.hash)) >= chain.finalityDepth) {
                    this.go(r, 'finalized');
                    const f = this.d.fees;
                    if (f?.collector && r.fill && r.tx?.kind !== 'noop' && r.tx?.kind !== 'approve')
                        f.collector.charge(r.key, i.chain, i.userId, f.tierOf(i.userId), i.amountIn, i.tokenIn);
                    return true;
                }
                return false;
            }
        }
        return false;
    }
    /** Reconcile BEFORE rebuilding: look up the SAME signed tx; resubmit identical bytes (same nonce/hash) only if absent. */
    async send(r) {
        const { chain } = this.d;
        const tx = r.tx;
        let lk;
        try {
            lk = await chain.lookup(tx.hash);
        }
        catch {
            return false;
        }
        if (r.state === 'unresolved') {
            if (lk !== 'none') {
                this.go(r, lk === 'included' ? 'observed' : 'submitted', 'reconciled: tx found');
                return true;
            }
            if (chain.time > tx.deadline) {
                this.go(r, 'expired', 'deadline passed; not found');
                this.release(r);
                return true;
            }
            let cn;
            try {
                cn = await chain.confirmedNonce(tx.wallet);
            }
            catch {
                return false;
            }
            if (cn > tx.nonce) {
                this.fail(r, 'nonce consumed by a different tx');
                this.release(r);
                return true;
            }
            if (r.resubmits >= this.maxResubmits && tx.kind !== 'noop')
                return false; // noops are harmless and have no deadline: always retryable
        }
        else if (lk !== 'none') {
            this.go(r, 'submitted', 'already known to node');
            return true;
        }
        try {
            await chain.submit(tx);
            r.resubmits++;
            if (r.state === 'signed')
                this.go(r, 'submitted');
            else
                this.go(r, 'submitted', 'resubmitted identical tx');
        }
        catch (e) {
            r.resubmits++;
            if (e instanceof RpcError) {
                if (r.state === 'signed')
                    this.go(r, 'unresolved', `submit ack lost: ${e.message}`);
                try {
                    return r.state === 'unresolved' && (await chain.lookup(tx.hash)) !== 'none';
                }
                catch {
                    return false;
                }
            }
            this.fail(r, `submit rejected: ${e.message}`);
            this.release(r);
        }
        return true;
    }
    /** Tx can never be included (rejected / expired-absent / nonce taken): refund its signer limit charge. Never call if it may still land. */
    release(r) { const d = r.authDigest ?? r.tx?.hash; if (d)
        this.d.signer.release(d); }
    /**
     * Heal a nonce gap: if the wallet's lowest unconsumed nonce belongs to a signed tx that is failed/expired and absent from
     * the node, cancelNonce it. Returns undefined when there is nothing stuck.
     */
    async healNonce(walletId) {
        let n;
        try {
            n = await this.d.chain.confirmedNonce(walletId);
        }
        catch {
            return undefined;
        }
        const orig = [...this.d.store.records.values()].find(x => x.tx?.nonce === n && x.tx.wallet === walletId && x.signature && x.tx.kind !== 'noop');
        if (!orig || !['failed', 'expired'].includes(orig.state))
            return undefined;
        return this.cancelNonce(walletId, { reason: orig.failure ?? orig.state });
    }
    /**
     * Cancel/replace the wallet's lowest unconsumed nonce with a signed noop so later nonces are not blocked forever.
     * Reconcile-first rules: the original tx is looked up on the node BEFORE anything is replaced.
     *  - included            -> nothing to replace (original advanced via normal reconciliation)
     *  - pending in mempool  -> may still be included: refused unless opts.force (evict is atomic in SimChain; a real node needs replace-by-fee)
     *  - absent              -> noop signed (policy-checked) at the SAME nonce; original marked expired with reason; its signer charge released
     * Idempotent: an in-flight noop for the same nonce is just advanced.
     */
    async cancelNonce(walletId, opts = {}) {
        const { chain, store, signer } = this.d;
        let n;
        try {
            n = await chain.confirmedNonce(walletId);
        }
        catch {
            return { status: 'rpc_down', nonce: -1 };
        }
        const at = [...store.records.values()].filter(x => x.tx?.wallet === walletId && x.tx.nonce === n && x.signature);
        const live = at.find(x => x.tx.kind === 'noop' && x.state !== 'failed' && x.state !== 'expired');
        if (live) {
            await this.advance(live.key);
            return { status: 'cancelled', nonce: n, noopKey: live.key };
        }
        const orig = at.find(x => x.tx.kind !== 'noop');
        if (!orig)
            return { status: 'nothing', nonce: n };
        let lk;
        try {
            lk = await chain.lookup(orig.tx.hash);
        }
        catch {
            return { status: 'rpc_down', nonce: n };
        }
        if (lk === 'included') {
            await this.advance(orig.key);
            return { status: 'included', nonce: n };
        }
        if (lk === 'pending' && !opts.force)
            return { status: 'pending', nonce: n };
        if (lk === 'pending' && !chain.evict && !chain.replaceByFee)
            return { status: 'pending', nonce: n, reason: 'this chain cannot atomically cancel a pending tx (it may be mined at any moment); wait for it to land or expire' };
        const rbf = lk === 'pending' && !chain.evict; // replace-by-fee: NOT atomic. The original stays in play (and keeps its signer charge) until the chain decides.
        let attempt = 0;
        while (store.records.has(`noop:${walletId}:${n}:${attempt}`))
            attempt++;
        const key = `noop:${walletId}:${n}:${attempt}`;
        const tx = { hash: '0x' + createHash('sha256').update(['noop', walletId, n, attempt].join('|')).digest('hex'), wallet: walletId, nonce: n, venue: '',
            tokenIn: NATIVE, tokenOut: NATIVE, amountIn: 0n, minOut: 0n, deadline: Number.MAX_SAFE_INTEGER, platformFeeBps: 0, kind: 'noop' };
        let signature;
        const authDigest = tx.hash;
        try {
            signature = signer.sign({ userId: orig.intent.userId, walletId, chain: orig.intent.chain, kind: 'noop', token: NATIVE, amount: 0n, digest: tx.hash, origin: 'manual', day: day(chain.time) });
        }
        catch (e) {
            if (e instanceof PolicyRejection)
                return { status: 'denied', nonce: n, reason: e.message };
            throw e;
        }
        if (chain.prepare) { // real chain: build + sign the noop now (before the atomic section below); its fee must replace/undercut nothing, the nonce is free
            try {
                const p = await chain.prepare(tx);
                tx.hash = p.hash;
                tx.raw = p.raw;
            }
            catch (e) {
                signer.release(authDigest);
                return { status: 'denied', nonce: n, reason: `could not build cancel transaction: ${e.message}` };
            }
        }
        if (lk === 'pending' && !rbf) { // evict stays synchronous for SimChain (no await tick), so no other advance() can interleave between evict and the state changes below
            const ev = chain.evict(orig.tx.hash);
            const evicted = ev instanceof Promise ? await ev : ev;
            if (!evicted) {
                await this.advance(orig.key);
                return { status: 'included', nonce: n };
            } // lost the race: it landed
        }
        // from here to the end of the block everything is synchronous: original abandoned + noop recorded atomically (write-ahead before send)
        const why = `nonce ${n} cancelled: ${opts.reason ?? 'original did not land'}`;
        if (rbf) { // the original may still be mined before the replacement: keep it non-terminal and keep its charge; normal reconciliation settles it either way
            if (orig.state === 'observed' || orig.state === 'submitted')
                this.go(orig, 'unresolved', `replace-by-fee sent for nonce ${n}: the original or the replacement will land`);
        }
        else {
            if (orig.state === 'observed' || orig.state === 'confirmed')
                this.go(orig, 'unresolved', why);
            if (!TERMINAL.has(orig.state))
                this.go(orig, 'expired', why);
            orig.failure = orig.failure && !orig.failure.includes('cancelled') ? `${orig.failure}; ${why}` : why;
            this.release(orig);
        }
        store.records.set(key, { key, intent: { ...orig.intent, idempotencyKey: key, amountIn: 0n }, state: 'signed', history: [{ state: 'created' }, { state: 'signed', note: `noop nonce ${n}` }], tx, signature, authDigest, resubmits: 0 });
        await this.advance(key);
        return { status: rbf ? 'replacing' : 'cancelled', nonce: n, noopKey: key };
    }
    build(r) {
        const i = r.intent;
        return { hash: '', wallet: i.walletId, nonce: -1, venue: r.quote.venue, tokenIn: i.tokenIn, tokenOut: i.tokenOut,
            amountIn: i.amountIn, minOut: r.minOut, deadline: i.deadline, platformFeeBps: this.bps(i), ...(i.mev !== undefined ? { mev: i.mev } : {}) };
    }
    hash(r, nonce) {
        const t = r.tx;
        return '0x' + createHash('sha256').update([r.key, t.wallet, nonce, t.venue, t.tokenIn, t.tokenOut, t.amountIn, t.minOut, t.deadline].join('|')).digest('hex');
    }
    /** Fill derived from receipt balance deltas — never from the quote. */
    fillOf(r, rc) {
        const i = r.intent;
        const spentRaw = -(rc.deltas[i.tokenIn] ?? 0n);
        const spent = i.tokenIn === NATIVE ? spentRaw - rc.network : spentRaw;
        const receivedRaw = rc.deltas[i.tokenOut] ?? 0n;
        const received = i.tokenOut === NATIVE ? receivedRaw + rc.network : receivedRaw;
        return { spent, received, platformFee: rc.platformFee, venueFee: rc.venueFee, networkFee: rc.network,
            quotedOut: r.quote.amountOut, shortfall: r.quote.amountOut - received };
    }
}
