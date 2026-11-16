/** RaydiumLaunchSource: a `LaunchSource` for sniping on Solana. It READS confirmed transactions that touch `watch` (default: the Raydium AMM v4 program) and finds new pools.
 *  Detection is layout-free and verified on chain: an account that this transaction CREATED (balance 0 before, positive after) which is owned by the Raydium AMM program and is
 *  exactly 752 bytes decodes as a pool; its mints come from the pool account itself, never from instruction data. The transaction must also contain an instruction to the
 *  program whose first data byte is 1 (initialize2, the pool-creation tag of Raydium AMM v4's instruction enum), otherwise it is ignored.
 *  Limits, stated plainly: it acts only on MINED pools (after the creation tx; never in the mempool, never ahead of it). Polling the whole program on mainnet is busy: when one page of
 *  signatures does not reach the previous cursor, `missed` is set so the gap is visible instead of silent. Point `watch` at an account that only pool creation touches to avoid this. */
import { NATIVE } from '../../core/src/index.js';
import { decodePoolState, AMM_V4_LAYOUT } from './raydium.js';
import { b58decode } from './tx.js';
const INITIALIZE2 = 1;
export class RaydiumLaunchSource {
    cfg;
    rpc;
    cursor;
    seeded = false;
    pairs = new Map();
    /** number of signatures the last poll could not reach (page full before the cursor): 0 = no gap */
    missed = 0;
    ignored = [];
    watchTx = [];
    constructor(cfg, rpc) {
        this.cfg = cfg;
        this.rpc = rpc;
    }
    snapshot() { return { cursor: this.cursor, seeded: this.seeded, pairs: [...this.pairs], reorgWatch: this.watchTx }; }
    load(s) { this.cursor = s.cursor; this.seeded = s.seeded; this.pairs = new Map(s.pairs); this.watchTx = s.reorgWatch ?? []; }
    async poll() {
        const limit = this.cfg.pageLimit ?? 100, watch = this.cfg.watch ?? this.cfg.program;
        const head = await this.rpc.call('getSlot', [{ commitment: 'confirmed' }]), reorged = [], keep = [];
        for (const t of this.watchTx) { // pools we reported: if their creation tx vanished, revoke
            if (head - t.slot > 150)
                continue;
            const r = await this.rpc.call('getSignatureStatuses', [[t.txHash], { searchTransactionHistory: false }]);
            if (!r.value[0] || r.value[0].err)
                reorged.push({ chain: this.cfg.chain, txHash: t.txHash });
            else
                keep.push(t);
        }
        this.watchTx = keep;
        const rows = await this.rpc.call('getSignaturesForAddress', [watch, { limit, commitment: 'confirmed', ...(this.cursor ? { until: this.cursor } : {}) }]);
        this.missed = this.cursor && rows.length >= limit ? rows.length : 0;
        if (!this.seeded) {
            this.seeded = true;
            if (rows[0])
                this.cursor = rows[0].signature;
            return { events: [], reorged };
        } // start from now: no historical launches
        const events = [];
        for (const row of [...rows].reverse()) {
            if (!row.err) {
                const evs = await this.parse(row.signature);
                events.push(...evs);
            }
            this.cursor = row.signature; // progress only after the signature was fully processed
        }
        return { events, reorged };
    }
    async parse(sig) {
        const t = await this.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (!t)
            throw new Error(`transaction ${sig} not available yet`);
        const m = t.meta;
        if (!m || m.err)
            return [];
        const msg = t.transaction.message, keys = [...msg.accountKeys, ...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? [])];
        const calls = [...msg.instructions, ...(m.innerInstructions ?? []).flatMap((x) => x.instructions)];
        const init = calls.some(c => keys[c.programIdIndex] === this.cfg.program && b58decode(c.data)[0] === INITIALIZE2);
        if (!init)
            return [];
        const created = keys.map((k, i) => ({ k, i })).filter(({ i }) => BigInt(m.preBalances[i] ?? 0) === 0n && BigInt(m.postBalances[i] ?? 0) > 0n).map(x => x.k);
        if (!created.length)
            return [];
        const r = await this.rpc.call('getMultipleAccounts', [created, { encoding: 'base64', commitment: 'confirmed' }]);
        const out = [];
        for (let i = 0; i < created.length; i++) {
            const a = r.value[i];
            if (!a || a.owner !== this.cfg.program)
                continue;
            const data = Buffer.from(a.data[0], 'base64');
            if (data.length !== AMM_V4_LAYOUT.size)
                continue;
            const st = decodePoolState(data), quotes = new Set(this.cfg.quoteMints.map(q => (q === NATIVE ? this.cfg.wsol : q)));
            quotes.add(this.cfg.wsol);
            const baseIsQuote = quotes.has(st.baseMint), quoteIsQuote = quotes.has(st.quoteMint);
            if (baseIsQuote === quoteIsQuote) {
                this.ignored.push(`${created[i]}: neither or both sides are quote mints`);
                continue;
            } // token/token or quote/quote: not a snipe target
            const token = baseIsQuote ? st.quoteMint : st.baseMint, quoteVault = baseIsQuote ? st.baseVault : st.quoteVault;
            const bal = await this.rpc.call('getTokenAccountBalance', [quoteVault, { commitment: 'confirmed' }]);
            this.pairs.set(token, { pair: created[i], program: this.cfg.program });
            this.watchTx.push({ txHash: sig, slot: t.slot });
            out.push({ type: 'pool-created', chain: this.cfg.chain, token, txHash: sig, logIndex: 0, block: t.slot, venueId: created[i], quoteLiquidity: BigInt(bal.value.amount) });
        }
        return out;
    }
}
