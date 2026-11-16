import { keccak256, bytesToHex } from './keccak.js';
import { erc20 } from './calldata.js';
const topic = (s) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const TRANSFER = topic('Transfer(address,address,uint256)'), WITHDRAWAL = topic('Withdrawal(address,uint256)');
const lc = (s) => s.toLowerCase(), big = (h) => BigInt(h), hex = (n) => '0x' + n.toString(16);
const addr = (t) => '0x' + t.slice(26).toLowerCase();
export const NATIVE_QUOTE = 'NATIVE';
export class LeaderWatcher {
    cfg;
    rpc;
    cursor;
    tipHash;
    known = new Set();
    holding = [];
    tracked = [];
    leaders;
    constructor(cfg, rpc) {
        this.cfg = cfg;
        this.rpc = rpc;
        this.leaders = new Set(cfg.leaders.map(lc));
        this.cursor = cfg.startBlock;
    }
    snapshot() { return { cursor: this.cursor, tipHash: this.tipHash, known: [...this.known], holding: this.holding, tracked: this.tracked }; }
    load(s) { this.cursor = s.cursor; this.tipHash = s.tipHash; this.known = new Set(s.known); this.holding = s.holding; this.tracked = s.tracked; }
    async head() { return Number(big(await this.rpc.call('eth_blockNumber'))); }
    async balanceAt(token, who, block) {
        if (token === NATIVE_QUOTE)
            return big(await this.rpc.call('eth_getBalance', [who, hex(block)]));
        const q = erc20.balanceOf(token, who);
        return erc20.decodeUint(await this.rpc.call('eth_call', [{ to: q.to, data: q.data }, hex(block)]));
    }
    /** One pass. Throws on node errors WITHOUT losing progress: the cursor only moves past blocks that were scanned completely. */
    async poll() {
        const head = await this.head(), depth = this.cfg.trackDepth ?? 12, reorged = [];
        if (this.cursor === undefined)
            this.cursor = head + 1; // start from now: never copy history
        // chain rewound or the block we last scanned changed -> rescan the recent window (dedupe by `known` keeps this safe)
        if (this.cursor - 1 > head)
            this.cursor = Math.max(head - depth + 1, 0);
        else if (this.tipHash && this.cursor >= 1) {
            const b = await this.rpc.call('eth_getBlockByNumber', [hex(this.cursor - 1), false]);
            if (!b || b.hash !== this.tipHash)
                this.cursor = Math.max(this.cursor - depth, 0);
        }
        // 1. reorg check on events we already emitted
        const stillTracked = [];
        for (const t of this.tracked) {
            if (head - t.blockNumber + 1 > depth)
                continue; // deep enough: stop tracking
            const rc = await this.rpc.call('eth_getTransactionReceipt', [t.txHash]);
            if (!rc || rc.blockHash !== t.blockHash)
                reorged.push({ chain: this.cfg.chain, txHash: t.txHash });
            else
                stillTracked.push(t);
        }
        this.tracked = stillTracked;
        // 2. scan new blocks
        const end = Math.min(head, this.cursor + (this.cfg.maxBlocksPerPoll ?? 50) - 1), found = [];
        for (let n = this.cursor; n <= end; n++) {
            const blk = await this.rpc.call('eth_getBlockByNumber', [hex(n), true]);
            if (!blk)
                throw new Error(`block ${n} not available`);
            for (const tx of blk.transactions) {
                if (!tx.to || !this.leaders.has(lc(tx.from)))
                    continue;
                const ev = await this.parse(tx, n, head);
                if (!ev)
                    continue;
                const id = `${ev.txHash}:${ev.logIndex}`;
                if (this.known.has(id))
                    continue;
                found.push({ ...ev, blockHash: blk.hash, blockNumber: n });
            }
            for (const f of found)
                this.known.add(`${f.txHash}:${f.logIndex}`);
            this.cursor = n + 1;
            this.tipHash = blk.hash;
        }
        this.holding.push(...found);
        // 3. release held events once deep enough AND still in the same block
        const events = [], keep = [];
        for (const h of this.holding) {
            const conf = head - h.blockNumber + 1;
            if (conf < this.cfg.minConfirmations) {
                keep.push(h);
                continue;
            }
            const rc = await this.rpc.call('eth_getTransactionReceipt', [h.txHash]);
            if (!rc || rc.blockHash !== h.blockHash)
                continue; // reorged before we ever acted: drop it, nothing to revoke
            const { blockHash, blockNumber, ...ev } = h;
            events.push({ ...ev, confirmations: conf });
            if (!this.tracked.some(t => t.txHash === h.txHash))
                this.tracked.push({ txHash: h.txHash, blockHash, blockNumber });
        }
        this.holding = keep;
        return { events, reorged };
    }
    /** Receipt -> LeaderEvent (swap) / 'transfer' event (any other value movement) / undefined (no value movement or reverted). */
    async parse(tx, n, head) {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [tx.hash]);
        if (!rc || rc.status !== '0x1')
            return undefined;
        const leader = lc(tx.from), deltas = new Map(), firstLog = new Map();
        const add = (k, d) => deltas.set(k, (deltas.get(k) ?? 0n) + d);
        for (const l of rc.logs) {
            if (l.topics?.[0] === TRANSFER && l.topics.length === 3) {
                const token = lc(l.address), from = addr(l.topics[1]), to = addr(l.topics[2]), amt = big(l.data);
                if (from === leader)
                    add(token, -amt);
                if (to === leader)
                    add(token, amt);
                if ((from === leader || to === leader) && !firstLog.has(token))
                    firstLog.set(token, Number(big(l.logIndex)));
            }
            else if (l.topics?.[0] === WITHDRAWAL && lc(l.address) === lc(this.cfg.weth))
                add(NATIVE_QUOTE, big(l.data)); // WETH unwrapped by the router and paid out as native
        }
        if (big(tx.value) > 0n)
            add(NATIVE_QUOTE, -big(tx.value));
        const nz = [...deltas].filter(([, d]) => d !== 0n);
        if (!nz.length)
            return undefined;
        const quotes = new Set(this.cfg.quoteTokens.map(lc).map(q => q === 'native' ? NATIVE_QUOTE : q));
        const toks = nz.filter(([k]) => !quotes.has(k)), qs = nz.filter(([k]) => quotes.has(k));
        const base = { provider: 'rpc', chain: this.cfg.chain, txHash: tx.hash, leader, confirmations: head - n + 1 };
        const none = { quoteAmount: 0n, tokenAmount: 0n, leaderBalanceBefore: 0n, leaderBalanceAfter: 0n, leaderPriceE18: 0n };
        if (toks.length !== 1)
            return { ...base, logIndex: Number(big(rc.logs[0]?.logIndex ?? '0x0')), kind: 'transfer', side: 'buy', token: toks[0]?.[0] ?? '', ...none };
        const [token, td] = toks[0], q = qs.filter(([, d]) => (d > 0n) !== (td > 0n)).sort((a, b) => (abs(b[1]) > abs(a[1]) ? 1 : -1))[0];
        const logIndex = firstLog.get(token) ?? 0;
        if (!q)
            return { ...base, logIndex, kind: 'transfer', side: td > 0n ? 'buy' : 'sell', token, ...none }; // token moved with no opposite quote leg (gift, airdrop, send)
        const tokenAmount = abs(td), quoteAmount = abs(q[1]);
        const before = await this.balanceAt(token, leader, n - 1), after = await this.balanceAt(token, leader, n);
        return { ...base, logIndex, kind: 'swap', side: td > 0n ? 'buy' : 'sell', token, quoteAmount, tokenAmount, leaderBalanceBefore: before, leaderBalanceAfter: after, leaderPriceE18: quoteAmount * 10n ** 18n / tokenAmount };
    }
}
const abs = (x) => (x < 0n ? -x : x);
