import { createHash } from 'node:crypto';
export class SimRpcError extends Error {
}
const h = (...p) => createHash('sha256').update(p.join('|')).digest('hex').slice(0, 16);
export class SimulatedSolana {
    family = 'solana';
    simulated = true;
    model = { account: 'no nonce; replay protection = recent blockhash + unique signature', validity: 'blockhash valid until lastValidBlockHeight (block-height window)',
        fee: 'base per signature + priority fee (compute units x price)', finality: 'processed -> confirmed -> finalized', asyncDelivery: false };
    height = 1000;
    blockhashWindow = 150;
    confirmDepth = 1;
    finalizeDepth = 32;
    baseFee = 5000;
    blockCapacity = 2;
    rpcDown = false;
    dropAcks = 0;
    bhIssued = new Map(); // blockhash -> issue height
    pending = new Map();
    landed = new Map();
    now() { return this.height; }
    latestBlockhash() { const bh = `bh-${this.height}`; this.bhIssued.set(bh, this.height); return { blockhash: bh, lastValidBlockHeight: this.height + this.blockhashWindow }; }
    /** Signature is content-addressed: identical content+blockhash => identical signature (dedup). Changing fee/blockhash => NEW signature. */
    build(o) {
        const b = o.blockhash ?? this.latestBlockhash();
        const cu = o.computeUnits ?? 200_000, pr = o.priority ?? 0;
        return { signature: h('sol', o.payer, o.payload, b.blockhash, cu, pr), payer: o.payer, payload: o.payload, blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight, computeUnits: cu, priorityMicroLamportsPerCu: pr };
    }
    fee(tx) { return this.baseFee + Math.floor(tx.computeUnits * tx.priorityMicroLamportsPerCu / 1_000_000); }
    isExpired(tx) { return this.height > tx.lastValidBlockHeight; }
    submit(tx) {
        if (this.rpcDown)
            throw new SimRpcError('rpc down');
        if (this.landed.has(tx.signature))
            return { accepted: true, id: tx.signature, duplicate: true }; // already processed: replay is a no-op
        if (!this.bhIssued.has(tx.blockhash) || this.isExpired(tx))
            return { accepted: false, id: tx.signature, error: 'BlockhashNotFound/expired' };
        this.pending.set(tx.signature, tx);
        if (this.dropAcks > 0) {
            this.dropAcks--;
            throw new SimRpcError('ack lost after send');
        }
        return { accepted: true, id: tx.signature };
    }
    /** Produce n blocks; leader includes up to blockCapacity pending txs by priority fee; expired ones are dropped, never land. */
    advance(n = 1) {
        for (let i = 0; i < n; i++) {
            this.height++;
            for (const [s, t] of this.pending)
                if (this.isExpired(t))
                    this.pending.delete(s);
            const order = [...this.pending.values()].sort((a, b) => b.priorityMicroLamportsPerCu - a.priorityMicroLamportsPerCu).slice(0, this.blockCapacity);
            for (const t of order) {
                this.pending.delete(t.signature);
                this.landed.set(t.signature, { slot: this.height, fee: this.fee(t), tx: t });
            }
        }
    }
    landedWithPayload(payload) { return [...this.landed.values()].filter(l => l.tx.payload === payload).map(l => l.tx.signature); }
    status(sig) {
        const l = this.landed.get(sig);
        if (!l)
            return this.pending.has(sig) ? { landing: 'pending', native: 'unseen' } : { landing: 'unknown', native: 'not_found' };
        const d = this.height - l.slot;
        const level = d >= this.finalizeDepth ? 'finalized' : d >= this.confirmDepth ? 'confirmed' : 'processed';
        return { landing: level, native: level };
    }
    meets(sig, c) { const o = { processed: 0, confirmed: 1, finalized: 2 }; const s = this.status(sig).native; return s in o && o[s] >= o[c]; }
    reconcile(tx) {
        const checks = ['signature status (search history) for the ORIGINAL signature', 'current block height vs lastValidBlockHeight', 'payload-level idempotency: any other signature already landed with this payload?'];
        const st = this.status(tx.signature);
        if (st.landing !== 'unknown' && st.landing !== 'pending')
            return { action: 'already_landed', reasons: [`signature is ${st.native}`], checks };
        const twin = this.landedWithPayload(tx.payload).filter(s => s !== tx.signature);
        if (twin.length)
            return { action: 'already_landed', reasons: ['a different signature carrying the same payload already landed'], checks };
        if (!this.isExpired(tx))
            return { action: 'rebroadcast_same', reasons: ['blockhash still valid: original may yet land; rebuilding now risks double execution'], checks };
        return { action: 'safe_to_rebuild', reasons: ['blockhash expired and original signature not found: it can never land'], checks };
    }
}
export class SimulatedTon {
    family = 'ton';
    simulated = true;
    model = { account: 'wallet contract seqno; external msg accepted only if seqno matches, then seqno increments (replay protection)', validity: 'message valid_until (unix seconds)',
        fee: 'forward + compute fees charged in the async message chain', finality: 'accepted_by_wallet (delivered) -> executed at destination (or bounced)', asyncDelivery: true };
    time = 1_700_000_000;
    executionDelayS = 10;
    finalitySeconds = 5;
    rpcDown = false;
    dropAcks = 0;
    seqno = new Map();
    accepted = new Map();
    now() { return this.time; }
    walletSeqno(w) { return this.seqno.get(w) ?? 0; }
    build(o) {
        const seqno = o.seqno ?? this.walletSeqno(o.wallet), validUntil = this.time + (o.validForS ?? 60);
        return { msgHash: h('ton', o.wallet, seqno, validUntil, o.dest, o.amount), wallet: o.wallet, seqno, validUntil, dest: o.dest, amount: o.amount, destFails: o.destFails };
    }
    isExpired(m) { return this.time > m.validUntil; }
    submit(m) {
        if (this.rpcDown)
            throw new SimRpcError('rpc down');
        if (this.accepted.has(m.msgHash))
            return { accepted: true, id: m.msgHash, duplicate: true };
        if (this.isExpired(m))
            return { accepted: false, id: m.msgHash, error: 'valid_until passed' };
        if (m.seqno !== this.walletSeqno(m.wallet))
            return { accepted: false, id: m.msgHash, error: 'seqno mismatch (replay or stale)' };
        this.seqno.set(m.wallet, m.seqno + 1);
        this.accepted.set(m.msgHash, { msg: m, at: this.time });
        if (this.dropAcks > 0) {
            this.dropAcks--;
            throw new SimRpcError('ack lost after send');
        }
        return { accepted: true, id: m.msgHash };
    }
    advance(seconds = 1) {
        this.time += seconds;
        for (const a of this.accepted.values())
            if (!a.done && this.time - a.at >= this.executionDelayS)
                a.done = { at: this.time, ok: !a.msg.destFails };
    }
    native(id) { const a = this.accepted.get(id); return !a ? 'not_accepted' : !a.done ? 'accepted_by_wallet' : a.done.ok ? 'executed' : 'bounced'; }
    status(id) {
        const n = this.native(id), a = this.accepted.get(id);
        if (n === 'not_accepted')
            return { landing: 'unknown', native: n };
        if (n === 'accepted_by_wallet')
            return { landing: 'processed', native: n, note: 'delivered != executed' };
        if (n === 'bounced')
            return { landing: 'failed', native: n, note: 'destination failed; value returns minus fees' };
        return { landing: this.time - a.done.at >= this.finalitySeconds ? 'finalized' : 'confirmed', native: n };
    }
    reconcile(m) {
        const checks = ['wallet get-seqno on chain', 'wallet transactions: find our message by hash', 'if found: follow outbound message to the destination transaction'];
        const n = this.native(m.msgHash);
        if (n === 'accepted_by_wallet')
            return { action: 'wait', reasons: ['wallet accepted it (seqno consumed) but destination not executed yet: do NOT resend'], checks };
        if (n === 'executed' || n === 'bounced')
            return { action: 'already_landed', reasons: [`destination ${n}`], checks };
        const cur = this.walletSeqno(m.wallet);
        if (cur > m.seqno)
            return { action: 'investigate', reasons: ['seqno advanced but our message hash not found: another message consumed it; re-derive intent from chain state'], checks };
        if (!this.isExpired(m))
            return { action: 'rebroadcast_same', reasons: ['seqno unchanged and valid_until not reached: identical message can still be accepted'], checks };
        return { action: 'safe_to_rebuild', reasons: ['seqno unchanged and valid_until passed: this message can never be accepted; rebuild with same seqno and new valid_until'], checks };
    }
}
export class SimulatedTron {
    family = 'tron';
    simulated = true;
    model = { account: 'no nonce; replay protection = tx id (hash of raw data) + expiration + reference block', validity: 'expiration timestamp (unix seconds)',
        fee: 'bandwidth (bytes) + energy (contracts); free/staked resources first, then TRX burned, energy burn capped by fee_limit', finality: 'in_block (unsolidified) -> solidified', asyncDelivery: false };
    block = 500;
    time = 1_700_000_000;
    blockTimeS = 3;
    solidifyDepth = 19;
    refBlockWindow = 1000;
    energyPriceSun = 100;
    bandwidthPriceSun = 1000;
    rpcDown = false;
    dropAcks = 0;
    res = new Map();
    pending = new Map();
    incl = new Map();
    now() { return this.time; }
    setResources(owner, freeBandwidth, energy) { this.res.set(owner, { freeBandwidth, energy }); }
    build(o) {
        const exp = this.time + (o.validForS ?? 60);
        return { txId: h('tron', o.owner, o.payload, exp, this.block), owner: o.owner, payload: o.payload, bytes: o.bytes ?? 250, energyRequired: o.energyRequired ?? 0, feeLimitSun: o.feeLimitSun ?? 0, expiration: exp, refBlock: this.block };
    }
    isExpired(t) { return this.time > t.expiration; }
    submit(t) {
        if (this.rpcDown)
            throw new SimRpcError('rpc down');
        if (this.incl.has(t.txId) || this.pending.has(t.txId))
            return { accepted: true, id: t.txId, duplicate: true }; // DUP_TRANSACTION_ERROR-like
        if (this.isExpired(t))
            return { accepted: false, id: t.txId, error: 'transaction expired' };
        if (this.block - t.refBlock > this.refBlockWindow || t.refBlock > this.block)
            return { accepted: false, id: t.txId, error: 'reference block invalid/too old' };
        this.pending.set(t.txId, t);
        if (this.dropAcks > 0) {
            this.dropAcks--;
            throw new SimRpcError('ack lost after send');
        }
        return { accepted: true, id: t.txId };
    }
    advance(n = 1) {
        for (let i = 0; i < n; i++) {
            this.block++;
            this.time += this.blockTimeS;
            for (const t of [...this.pending.values()]) {
                if (this.isExpired(t)) {
                    this.pending.delete(t.txId);
                    continue;
                }
                this.pending.delete(t.txId);
                this.incl.set(t.txId, this.execute(t));
            }
        }
    }
    execute(t) {
        const r = this.res.get(t.owner) ?? { freeBandwidth: 0, energy: 0 };
        const bwFromFree = Math.min(r.freeBandwidth, t.bytes);
        r.freeBandwidth -= bwFromFree;
        let burned = (t.bytes - bwFromFree) * this.bandwidthPriceSun;
        const fromStaked = Math.min(r.energy, t.energyRequired);
        const energyBurnSun = (t.energyRequired - fromStaked) * this.energyPriceSun;
        if (energyBurnSun > t.feeLimitSun) { // fee_limit exhausted: execution reverts, up to fee_limit is still burned
            r.energy -= fromStaked;
            this.res.set(t.owner, r);
            return { block: this.block, ok: false, burnedSun: burned + t.feeLimitSun, energyUsed: fromStaked, bandwidthUsed: t.bytes };
        }
        r.energy -= fromStaked;
        this.res.set(t.owner, r);
        burned += energyBurnSun;
        return { block: this.block, ok: true, burnedSun: burned, energyUsed: t.energyRequired, bandwidthUsed: t.bytes };
    }
    receipt(id) { return this.incl.get(id); }
    native(id) {
        const i = this.incl.get(id);
        if (!i)
            return this.pending.has(id) ? 'pending' : 'not_found';
        if (!i.ok)
            return 'out_of_energy';
        return this.block - i.block >= this.solidifyDepth ? 'solidified' : 'in_block';
    }
    status(id) {
        const n = this.native(id);
        if (n === 'not_found')
            return { landing: 'unknown', native: n };
        if (n === 'pending')
            return { landing: 'pending', native: n };
        if (n === 'out_of_energy')
            return { landing: 'failed', native: n, note: 'fee_limit exhausted; fee still burned' };
        return { landing: n === 'solidified' ? 'finalized' : 'processed', native: n, note: n === 'in_block' ? 'unsolidified: may still be reorged' : undefined };
    }
    reconcile(t) {
        const checks = ['transaction by id (unsolidified node AND solidified node)', 'transaction info/receipt for result (energy, fee, revert)', 'expiration vs latest block timestamp (plus one block-time margin for node lag)'];
        const n = this.native(t.txId);
        if (n !== 'not_found' && n !== 'pending')
            return { action: 'already_landed', reasons: [`tx is ${n}`], checks };
        if (n === 'pending')
            return { action: 'wait', reasons: ['tx known to node, not yet in a block'], checks };
        if (this.time <= t.expiration + this.blockTimeS)
            return { action: 'rebroadcast_same', reasons: ['not expired (within node-lag margin): identical tx may still be packed'], checks };
        return { action: 'safe_to_rebuild', reasons: ['expiration passed beyond margin and tx id not found: it can never be packed'], checks };
    }
}
