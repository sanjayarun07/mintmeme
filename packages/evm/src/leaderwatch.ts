/** LeaderWatcher: turns a leader wallet's on-chain activity into CopyEngine `LeaderEvent`s using plain JSON-RPC (no indexer, no mempool).
 *  How it works: scan each new block, take transactions whose `from` is a tracked leader, read the receipt, and compute the leader's NET token
 *  deltas from ERC-20 Transfer logs plus native value / WETH Withdrawal. Exactly one non-quote token moving against a quote asset = a swap.
 *  Balances before/after come from eth_call at block-1 / block (needs state for those blocks: fine near head, archive node for old ones).
 *  Reorgs: emitted events are tracked by block hash for `trackDepth` blocks; if the tx vanishes or lands in another block, it is reported in `reorged`.
 *  Honest limits (see docs/KNOWN_LIMITATIONS.md): only transactions SENT BY the leader EOA (not smart-wallet / aggregator-internal / contract wallets);
 *  protocol-agnostic delta detection, so a token with transfer tax shows the net amount; several leader txs in one block share the block-level balance reads;
 *  ERC-721/1155 are ignored; no mempool: the earliest signal is a mined block. */
import type { LeaderEvent } from '../../core/src/index.ts';
import { keccak256, bytesToHex } from './keccak.ts';
import type { RpcLike } from './rpcchain.ts';
import { erc20 } from './calldata.ts';

const topic = (s: string) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const TRANSFER = topic('Transfer(address,address,uint256)'), WITHDRAWAL = topic('Withdrawal(address,uint256)');
const lc = (s: string) => s.toLowerCase(), big = (h: string) => BigInt(h), hex = (n: number) => '0x' + n.toString(16);
const addr = (t: string) => '0x' + t.slice(26).toLowerCase();
export const NATIVE_QUOTE = 'NATIVE';

export interface WatchCfg {
  chain: string; weth: string; leaders: string[];
  /** Assets that count as the "money" side of a swap: lowercase token addresses and/or 'NATIVE'. */
  quoteTokens: string[];
  /** Hold an event until its block has this many confirmations (0 = act as soon as it is mined). One policy per watcher. */
  minConfirmations: number;
  startBlock?: number; maxBlocksPerPoll?: number; trackDepth?: number;
  /** How new blocks are searched. 'blocks' (default): every block with its transactions. 'logs': only ERC-20 Transfer logs to or from a leader (eth_getLogs, two calls
   *  per range), then just those transactions: far fewer and smaller calls on fast chains (Base, BNB and Robinhood make 2 to 10 blocks a second). A swap always moves a
   *  token to or from the leader, so 'logs' finds every swap 'blocks' finds; what it does not see is a transaction that moves only the native coin (no swap). */
  scan?: 'blocks' | 'logs';
}
export interface Tracked { txHash: string; blockHash: string; blockNumber: number }
type Held = LeaderEvent & Tracked;
export interface WatchState { cursor: number | undefined; tipHash: string | undefined; known: string[]; holding: Held[]; tracked: Tracked[] }

export class LeaderWatcher {
  cursor: number | undefined; tipHash: string | undefined; known = new Set<string>(); holding: Held[] = []; tracked: Tracked[] = [];
  private leaders: Set<string>;
  constructor(private cfg: WatchCfg, private rpc: RpcLike) { this.leaders = new Set(cfg.leaders.map(lc)); this.cursor = cfg.startBlock; }

  snapshot(): WatchState { return { cursor: this.cursor, tipHash: this.tipHash, known: [...this.known], holding: this.holding, tracked: this.tracked }; }
  load(s: WatchState) { this.cursor = s.cursor; this.tipHash = s.tipHash; this.known = new Set(s.known); this.holding = s.holding; this.tracked = s.tracked; }

  private async head() { return Number(big(await this.rpc.call<string>('eth_blockNumber'))); }
  private async balanceAt(token: string, who: string, block: number) {
    if (token === NATIVE_QUOTE) return big(await this.rpc.call<string>('eth_getBalance', [who, hex(block)]));
    const q = erc20.balanceOf(token, who); return erc20.decodeUint(await this.rpc.call<string>('eth_call', [{ to: q.to, data: q.data }, hex(block)]));
  }

  /** One pass. Throws on node errors WITHOUT losing progress: the cursor only moves past blocks that were scanned completely. */
  async poll(): Promise<{ events: LeaderEvent[]; reorged: { chain: string; txHash: string }[] }> {
    const head = await this.head(), depth = this.cfg.trackDepth ?? 12, reorged: { chain: string; txHash: string }[] = [];
    if (this.cursor === undefined) this.cursor = head + 1;                       // start from now: never copy history
    // chain rewound or the block we last scanned changed -> rescan the recent window (dedupe by `known` keeps this safe)
    if (this.cursor - 1 > head) this.cursor = Math.max(head - depth + 1, 0);
    else if (this.tipHash && this.cursor >= 1) {
      const b: any = await this.rpc.call('eth_getBlockByNumber', [hex(this.cursor - 1), false]);
      if (!b || b.hash !== this.tipHash) this.cursor = Math.max(this.cursor - depth, 0);
    }
    // 1. reorg check on events we already emitted
    const stillTracked: Tracked[] = [];
    for (const t of this.tracked) {
      if (head - t.blockNumber + 1 > depth) continue;                             // deep enough: stop tracking
      const rc: any = await this.rpc.call('eth_getTransactionReceipt', [t.txHash]);
      if (!rc || rc.blockHash !== t.blockHash) reorged.push({ chain: this.cfg.chain, txHash: t.txHash }); else stillTracked.push(t);
    }
    this.tracked = stillTracked;
    // 2. scan new blocks
    const found: Held[] = [];
    if (this.cfg.scan === 'logs') {
      // one range: the leaders' Transfer logs (as sender, then as receiver), then each matching transaction once, in block order. The cursor moves past the whole range
      // only after every transaction in it was read, so a failed call rescans the same range next time (dedupe by `known` keeps that safe).
      const end = Math.min(head, this.cursor + (this.cfg.maxBlocksPerPoll ?? 500) - 1);
      if (end >= this.cursor) {
        const lead = [...this.leaders].map(l => '0x' + l.slice(2).padStart(64, '0')), range = { fromBlock: hex(this.cursor), toBlock: hex(end) };
        const [out, inn] = await Promise.all([this.rpc.call<any[]>('eth_getLogs', [{ ...range, topics: [TRANSFER, lead] }]), this.rpc.call<any[]>('eth_getLogs', [{ ...range, topics: [TRANSFER, null, lead] }])]);
        const txs = new Map<string, { n: number; blockHash: string }>();
        for (const l of [...(out ?? []), ...(inn ?? [])]) if (!l.removed) txs.set(l.transactionHash, { n: Number(big(l.blockNumber)), blockHash: l.blockHash });
        for (const [h, { n, blockHash }] of [...txs].sort((a, b) => a[1].n - b[1].n)) {
          const tx: any = await this.rpc.call('eth_getTransactionByHash', [h]); if (!tx || !tx.to || !this.leaders.has(lc(tx.from))) continue;   // only what the leader itself sent
          const ev = await this.parse(tx, n, head); if (!ev) continue;
          const id = `${ev.txHash}:${ev.logIndex}`; if (this.known.has(id) || found.some(f => `${f.txHash}:${f.logIndex}` === id)) continue;
          found.push({ ...ev, blockHash, blockNumber: n });
        }
        const tip: any = await this.rpc.call('eth_getBlockByNumber', [hex(end), false]); if (!tip) throw new Error(`block ${end} not available`);
        for (const f of found) this.known.add(`${f.txHash}:${f.logIndex}`);
        this.cursor = end + 1; this.tipHash = tip.hash;
      }
    }
    const end = this.cfg.scan === 'logs' ? this.cursor - 1 : Math.min(head, this.cursor + (this.cfg.maxBlocksPerPoll ?? 50) - 1);
    for (let n = this.cursor; n <= end; n++) {
      const blk: any = await this.rpc.call('eth_getBlockByNumber', [hex(n), true]); if (!blk) throw new Error(`block ${n} not available`);
      for (const tx of blk.transactions as any[]) {
        if (!tx.to || !this.leaders.has(lc(tx.from))) continue;
        const ev = await this.parse(tx, n, head); if (!ev) continue;
        const id = `${ev.txHash}:${ev.logIndex}`; if (this.known.has(id)) continue;
        found.push({ ...ev, blockHash: blk.hash, blockNumber: n });
      }
      for (const f of found) this.known.add(`${f.txHash}:${f.logIndex}`);
      this.cursor = n + 1; this.tipHash = blk.hash;
    }
    this.holding.push(...found);
    // 3. release held events once deep enough AND still in the same block
    const events: LeaderEvent[] = [], keep: Held[] = [];
    for (const h of this.holding) {
      const conf = head - h.blockNumber + 1;
      if (conf < this.cfg.minConfirmations) { keep.push(h); continue; }
      const rc: any = await this.rpc.call('eth_getTransactionReceipt', [h.txHash]);
      if (!rc || rc.blockHash !== h.blockHash) continue;                         // reorged before we ever acted: drop it, nothing to revoke
      const { blockHash, blockNumber, ...ev } = h; events.push({ ...ev, confirmations: conf });
      if (!this.tracked.some(t => t.txHash === h.txHash)) this.tracked.push({ txHash: h.txHash, blockHash, blockNumber });
    }
    this.holding = keep;
    return { events, reorged };
  }

  /** Receipt -> LeaderEvent (swap) / 'transfer' event (any other value movement) / undefined (no value movement or reverted). */
  private async parse(tx: any, n: number, head: number): Promise<LeaderEvent | undefined> {
    const rc: any = await this.rpc.call('eth_getTransactionReceipt', [tx.hash]);
    if (!rc || rc.status !== '0x1') return undefined;
    const leader = lc(tx.from), deltas = new Map<string, bigint>(), firstLog = new Map<string, number>();
    const add = (k: string, d: bigint) => deltas.set(k, (deltas.get(k) ?? 0n) + d);
    for (const l of rc.logs as any[]) {
      if (l.topics?.[0] === TRANSFER && l.topics.length === 3) {
        const token = lc(l.address), from = addr(l.topics[1]), to = addr(l.topics[2]), amt = big(l.data);
        if (from === leader) add(token, -amt); if (to === leader) add(token, amt);
        if ((from === leader || to === leader) && !firstLog.has(token)) firstLog.set(token, Number(big(l.logIndex)));
      } else if (l.topics?.[0] === WITHDRAWAL && lc(l.address) === lc(this.cfg.weth)) add(NATIVE_QUOTE, big(l.data));   // WETH unwrapped by the router and paid out as native
    }
    if (big(tx.value) > 0n) add(NATIVE_QUOTE, -big(tx.value));
    const nz = [...deltas].filter(([, d]) => d !== 0n); if (!nz.length) return undefined;
    const quotes = new Set(this.cfg.quoteTokens.map(lc).map(q => q === 'native' ? NATIVE_QUOTE : q));
    const toks = nz.filter(([k]) => !quotes.has(k)), qs = nz.filter(([k]) => quotes.has(k));
    const base = { provider: 'rpc', chain: this.cfg.chain, txHash: tx.hash as string, leader, confirmations: head - n + 1 };
    const none = { quoteAmount: 0n, tokenAmount: 0n, leaderBalanceBefore: 0n, leaderBalanceAfter: 0n, leaderPriceE18: 0n };
    if (toks.length !== 1) return { ...base, logIndex: Number(big(rc.logs[0]?.logIndex ?? '0x0')), kind: 'transfer', side: 'buy', token: toks[0]?.[0] ?? '', ...none };
    const [token, td] = toks[0], q = qs.filter(([, d]) => (d > 0n) !== (td > 0n)).sort((a, b) => (abs(b[1]) > abs(a[1]) ? 1 : -1))[0];
    const logIndex = firstLog.get(token) ?? 0;
    if (!q) return { ...base, logIndex, kind: 'transfer', side: td > 0n ? 'buy' : 'sell', token, ...none };   // token moved with no opposite quote leg (gift, airdrop, send)
    const tokenAmount = abs(td), quoteAmount = abs(q[1]);
    const before = await this.balanceAt(token, leader, n - 1), after = await this.balanceAt(token, leader, n);
    return { ...base, logIndex, kind: 'swap', side: td > 0n ? 'buy' : 'sell', token, quoteAmount, tokenAmount, leaderBalanceBefore: before, leaderBalanceAfter: after, leaderPriceE18: quoteAmount * 10n ** 18n / tokenAmount };
  }
}
const abs = (x: bigint) => (x < 0n ? -x : x);
