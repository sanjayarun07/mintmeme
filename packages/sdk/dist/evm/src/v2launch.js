import { keccak256, bytesToHex } from './keccak.js';
const topic = (s) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const PAIR_CREATED = topic('PairCreated(address,address,address,uint256)'), MINT = topic('Mint(address,uint256,uint256)');
const lc = (s) => s.toLowerCase(), big = (h) => BigInt(h), hex = (n) => '0x' + n.toString(16);
const addr = (t) => '0x' + t.slice(26).toLowerCase();
export class V2LaunchWatcher {
    cfg;
    rpc;
    cursor;
    tipHash;
    pairs = new Map() /* token -> pair */;
    known = new Set();
    tracked = [];
    constructor(cfg, rpc) {
        this.cfg = cfg;
        this.rpc = rpc;
        this.cursor = cfg.startBlock;
    }
    snapshot() { return { cursor: this.cursor, tipHash: this.tipHash, pairs: [...this.pairs], known: [...this.known], tracked: this.tracked }; }
    load(s) { this.cursor = s.cursor; this.tipHash = s.tipHash; this.pairs = new Map(s.pairs); this.known = new Set(s.known); this.tracked = s.tracked; }
    async poll() {
        const head = Number(big(await this.rpc.call('eth_blockNumber'))), depth = this.cfg.trackDepth ?? 12, reorged = [];
        if (this.cursor === undefined)
            this.cursor = head + 1;
        if (this.cursor - 1 > head)
            this.cursor = Math.max(head - depth + 1, 0);
        else if (this.tipHash && this.cursor >= 1) {
            const b = await this.rpc.call('eth_getBlockByNumber', [hex(this.cursor - 1), false]);
            if (!b || b.hash !== this.tipHash)
                this.cursor = Math.max(this.cursor - depth, 0);
        }
        const still = [];
        for (const t of this.tracked) {
            if (head - t.blockNumber + 1 > depth)
                continue;
            const rc = await this.rpc.call('eth_getTransactionReceipt', [t.txHash]);
            if (!rc || rc.blockHash !== t.blockHash)
                reorged.push({ chain: this.cfg.chain, txHash: t.txHash });
            else
                still.push(t);
        }
        this.tracked = still;
        const from = this.cursor, to = Math.min(head, from + (this.cfg.maxBlocksPerPoll ?? 500) - 1), events = [];
        if (to >= from) {
            const range = { fromBlock: hex(from), toBlock: hex(to) }, weth = lc(this.cfg.weth);
            const created = await this.rpc.call('eth_getLogs', [{ ...range, address: this.cfg.factory, topics: [PAIR_CREATED] }]);
            const staged = new Map(this.pairs);
            for (const l of created) {
                const t0 = addr(l.topics[1]), t1 = addr(l.topics[2]), pair = '0x' + l.data.slice(26, 66).toLowerCase();
                if (t0 !== weth && t1 !== weth)
                    continue;
                const token = t0 === weth ? t1 : t0;
                staged.set(token, { token, pair, wethIsToken0: t0 === weth });
            }
            const byPair = new Map([...staged.values()].map(p => [p.pair, p]));
            const mints = byPair.size ? await this.rpc.call('eth_getLogs', [{ ...range, address: [...byPair.keys()], topics: [MINT] }]) : [];
            const items = [...created.filter(l => { const t0 = addr(l.topics[1]), t1 = addr(l.topics[2]); return t0 === weth || t1 === weth; }).map(l => ({ l, kind: 'created' })), ...mints.map(l => ({ l, kind: 'mint' }))]
                .sort((a, b) => Number(big(a.l.blockNumber)) - Number(big(b.l.blockNumber)) || Number(big(a.l.logIndex)) - Number(big(b.l.logIndex)));
            for (const { l, kind } of items) {
                const block = Number(big(l.blockNumber)), logIndex = Number(big(l.logIndex)), id = `${kind}:${l.transactionHash}:${logIndex}`;
                if (this.known.has(id))
                    continue;
                let ev;
                if (kind === 'created') {
                    const t0 = addr(l.topics[1]), token = t0 === weth ? addr(l.topics[2]) : t0;
                    ev = { type: 'pool-created', chain: this.cfg.chain, token, txHash: l.transactionHash, logIndex, block, venueId: `uni:${token}` };
                }
                else {
                    const p = byPair.get(lc(l.address)), a0 = big('0x' + l.data.slice(2, 66)), a1 = big('0x' + l.data.slice(66, 130));
                    ev = { type: 'liquidity-added', chain: this.cfg.chain, token: p.token, txHash: l.transactionHash, logIndex, block, venueId: `uni:${p.token}`, quoteLiquidity: p.wethIsToken0 ? a0 : a1 };
                }
                this.known.add(id);
                events.push(ev);
                if (!this.tracked.some(t => t.txHash === l.transactionHash))
                    this.tracked.push({ txHash: l.transactionHash, blockHash: l.blockHash, blockNumber: block });
            }
            this.pairs = staged;
            const tip = await this.rpc.call('eth_getBlockByNumber', [hex(to), false]);
            this.cursor = to + 1;
            this.tipHash = tip?.hash;
        }
        return { events, reorged };
    }
}
