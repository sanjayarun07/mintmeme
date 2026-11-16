/** V2LaunchWatcher: detects new Uniswap-V2-style pools and their first liquidity from chain logs (factory PairCreated + pair Mint) over plain JSON-RPC,
 *  and turns them into `LaunchEvent`s for the core LaunchDetector. Only pairs against the wrapped native token are launches here.
 *  What it CANNOT see (so the sniper must not pretend to): a token's own "trading enabled" switch (there is no standard event: the sniper learns about it only
 *  by test-simulating the buy), launchpad curves, v3/v4 pools, and anything before the first poll (it starts from the current head).
 *  Reorgs: emitted events are tracked by block hash for `trackDepth` blocks; a vanished tx is reported so the detector can revoke it. */
import type { LaunchEvent } from '../../core/src/index.ts';
import { keccak256, bytesToHex } from './keccak.ts';
import type { RpcLike } from './rpcchain.ts';

const topic = (s: string) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const PAIR_CREATED = topic('PairCreated(address,address,address,uint256)'), MINT = topic('Mint(address,uint256,uint256)');
const lc = (s: string) => s.toLowerCase(), big = (h: string) => BigInt(h), hex = (n: number) => '0x' + n.toString(16);
const addr = (t: string) => '0x' + t.slice(26).toLowerCase();

export interface LaunchWatchCfg { chain: string; factory: string; weth: string; startBlock?: number; maxBlocksPerPoll?: number; trackDepth?: number }
export interface PairInfo { token: string; pair: string; wethIsToken0: boolean }
interface Tracked { txHash: string; blockHash: string; blockNumber: number }
export interface LaunchWatchState { cursor: number | undefined; tipHash: string | undefined; pairs: [string, PairInfo][]; known: string[]; tracked: Tracked[] }

export class V2LaunchWatcher {
  cursor: number | undefined; tipHash: string | undefined; pairs = new Map<string, PairInfo>() /* token -> pair */; known = new Set<string>(); tracked: Tracked[] = [];
  constructor(private cfg: LaunchWatchCfg, private rpc: RpcLike) { this.cursor = cfg.startBlock; }
  snapshot(): LaunchWatchState { return { cursor: this.cursor, tipHash: this.tipHash, pairs: [...this.pairs], known: [...this.known], tracked: this.tracked }; }
  load(s: LaunchWatchState) { this.cursor = s.cursor; this.tipHash = s.tipHash; this.pairs = new Map(s.pairs); this.known = new Set(s.known); this.tracked = s.tracked; }

  async poll(): Promise<{ events: LaunchEvent[]; reorged: { chain: string; txHash: string }[] }> {
    const head = Number(big(await this.rpc.call<string>('eth_blockNumber'))), depth = this.cfg.trackDepth ?? 12, reorged: { chain: string; txHash: string }[] = [];
    if (this.cursor === undefined) this.cursor = head + 1;
    if (this.cursor - 1 > head) this.cursor = Math.max(head - depth + 1, 0);
    else if (this.tipHash && this.cursor >= 1) {
      const b: any = await this.rpc.call('eth_getBlockByNumber', [hex(this.cursor - 1), false]); if (!b || b.hash !== this.tipHash) this.cursor = Math.max(this.cursor - depth, 0);
    }
    const still: Tracked[] = [];
    for (const t of this.tracked) {
      if (head - t.blockNumber + 1 > depth) continue;
      const rc: any = await this.rpc.call('eth_getTransactionReceipt', [t.txHash]);
      if (!rc || rc.blockHash !== t.blockHash) reorged.push({ chain: this.cfg.chain, txHash: t.txHash }); else still.push(t);
    }
    this.tracked = still;
    const from = this.cursor, to = Math.min(head, from + (this.cfg.maxBlocksPerPoll ?? 500) - 1), events: LaunchEvent[] = [];
    if (to >= from) {
      const range = { fromBlock: hex(from), toBlock: hex(to) }, weth = lc(this.cfg.weth);
      const created: any[] = await this.rpc.call('eth_getLogs', [{ ...range, address: this.cfg.factory, topics: [PAIR_CREATED] }]);
      const staged = new Map<string, PairInfo>(this.pairs);
      for (const l of created) {
        const t0 = addr(l.topics[1]), t1 = addr(l.topics[2]), pair = '0x' + l.data.slice(26, 66).toLowerCase();
        if (t0 !== weth && t1 !== weth) continue;
        const token = t0 === weth ? t1 : t0; staged.set(token, { token, pair, wethIsToken0: t0 === weth });
      }
      const byPair = new Map([...staged.values()].map(p => [p.pair, p]));
      const mints: any[] = byPair.size ? await this.rpc.call('eth_getLogs', [{ ...range, address: [...byPair.keys()], topics: [MINT] }]) : [];
      type Item = { l: any; kind: 'created' | 'mint' };
      const items: Item[] = [...created.filter(l => { const t0 = addr(l.topics[1]), t1 = addr(l.topics[2]); return t0 === weth || t1 === weth; }).map(l => ({ l, kind: 'created' as const })), ...mints.map(l => ({ l, kind: 'mint' as const }))]
        .sort((a, b) => Number(big(a.l.blockNumber)) - Number(big(b.l.blockNumber)) || Number(big(a.l.logIndex)) - Number(big(b.l.logIndex)));
      for (const { l, kind } of items) {
        const block = Number(big(l.blockNumber)), logIndex = Number(big(l.logIndex)), id = `${kind}:${l.transactionHash}:${logIndex}`; if (this.known.has(id)) continue;
        let ev: LaunchEvent;
        if (kind === 'created') {
          const t0 = addr(l.topics[1]), token = t0 === weth ? addr(l.topics[2]) : t0;
          ev = { type: 'pool-created', chain: this.cfg.chain, token, txHash: l.transactionHash, logIndex, block, venueId: `uni:${token}` };
        } else {
          const p = byPair.get(lc(l.address))!, a0 = big('0x' + l.data.slice(2, 66)), a1 = big('0x' + l.data.slice(66, 130));
          ev = { type: 'liquidity-added', chain: this.cfg.chain, token: p.token, txHash: l.transactionHash, logIndex, block, venueId: `uni:${p.token}`, quoteLiquidity: p.wethIsToken0 ? a0 : a1 };
        }
        this.known.add(id); events.push(ev);
        if (!this.tracked.some(t => t.txHash === l.transactionHash)) this.tracked.push({ txHash: l.transactionHash, blockHash: l.blockHash, blockNumber: block });
      }
      this.pairs = staged;
      const tip: any = await this.rpc.call('eth_getBlockByNumber', [hex(to), false]); this.cursor = to + 1; this.tipHash = tip?.hash;
    }
    return { events, reorged };
  }
}
