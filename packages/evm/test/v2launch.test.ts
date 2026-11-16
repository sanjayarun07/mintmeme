import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2LaunchWatcher, keccak256, bytesToHex } from '../src/index.ts';
import { A } from './fixtures.ts';

// MOCK NODE: logic only (log decoding, cursor, reorg). It proves our parsing on logs shaped like Uniswap V2's, not that any real node behaves so.
const FACTORY = A(0xfac0), WETH = A(0x1001), TOK_A = A(0x2002), TOK_B = A(0x0502), OTHER = A(0x7777), PAIR1 = A(0x9991), PAIR2 = A(0x9992), PAIR3 = A(0x9993);
const topic = (s: string) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const PAIR_CREATED = topic('PairCreated(address,address,address,uint256)'), MINT = topic('Mint(address,uint256,uint256)');
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0'), w32 = (n: bigint) => n.toString(16).padStart(64, '0'), hx = (n: number) => '0x' + n.toString(16);
type Log = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string };
class Node {
  logs: Log[] = []; txs = new Map<string, string>(); n = 20; hashes = new Map<number, string>(); fail = false;
  blockHash(b: number) { return this.hashes.get(b) ?? `0xblk${b}`; }
  mine(k = 1) { this.n += k; }
  add(block: number, l: Omit<Log, 'blockNumber' | 'blockHash'>) { this.logs.push({ ...l, blockNumber: hx(block), blockHash: this.blockHash(block) }); this.txs.set(l.transactionHash, this.blockHash(block)); }
  created(block: number, tx: string, t0: string, t1: string, pair: string, li = 0) { this.add(block, { address: FACTORY, topics: [PAIR_CREATED, pad(t0), pad(t1)], data: '0x' + pair.slice(2).padStart(64, '0') + w32(1n), transactionHash: tx, logIndex: hx(li) }); }
  mint(block: number, tx: string, pair: string, a0: bigint, a1: bigint, li = 1) { this.add(block, { address: pair, topics: [MINT, pad(A(0xabc))], data: '0x' + w32(a0) + w32(a1), transactionHash: tx, logIndex: hx(li) }); }
  async call<T = any>(m: string, p: any[] = []): Promise<T> {
    if (this.fail) throw new Error('node down');
    switch (m) {
      case 'eth_blockNumber': return hx(this.n) as any;
      case 'eth_getBlockByNumber': { const b = Number(BigInt(p[0])); return { number: hx(b), hash: this.blockHash(b) } as any; }
      case 'eth_getTransactionReceipt': { const h = this.txs.get(p[0]); return (h ? { blockHash: h } : null) as any; }
      case 'eth_getLogs': { const f = p[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock)); const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((x: string) => x.toLowerCase());
        return this.logs.filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to && addrs.includes(l.address.toLowerCase()) && l.topics[0] === f.topics[0]; }) as any; }
      default: throw new Error('unexpected ' + m);
    }
  }
}
const cfg = (o = {}) => ({ chain: 'evm-test', factory: FACTORY, weth: WETH, startBlock: 21, ...o });

test('pool creation + first liquidity in one tx: pool-created and liquidity-added with the WETH side as quote liquidity (both token orders)', async () => {
  const n = new Node(); const w = new V2LaunchWatcher(cfg(), n); n.mine(2);
  n.created(22, '0xt1', WETH, TOK_A, PAIR1); n.mint(22, '0xt1', PAIR1, 5n * 10n ** 18n, 1000n);            // WETH is token0
  n.created(22, '0xt2', TOK_B, WETH, PAIR2, 3); n.mint(22, '0xt2', PAIR2, 777n, 2n * 10n ** 18n, 4);       // WETH is token1
  const { events } = await w.poll();
  assert.deepEqual(events.map(e => [e.type, e.token, e.quoteLiquidity ?? null]), [['pool-created', TOK_A.toLowerCase(), null], ['liquidity-added', TOK_A.toLowerCase(), 5n * 10n ** 18n], ['pool-created', TOK_B.toLowerCase(), null], ['liquidity-added', TOK_B.toLowerCase(), 2n * 10n ** 18n]]);
  assert.equal(w.pairs.get(TOK_A.toLowerCase())!.pair, PAIR1); assert.equal(events[0].venueId, `uni:${TOK_A.toLowerCase()}`);
});
test('pairs that do not include WETH are ignored; history before the first poll is never reported; a re-poll adds nothing', async () => {
  const n = new Node(); n.created(18, '0xold', WETH, TOK_A, PAIR1); const w = new V2LaunchWatcher(cfg({ startBlock: undefined }), n);
  assert.equal((await w.poll()).events.length, 0); n.mine(1); n.created(22, '0xt3', OTHER, TOK_A, PAIR3); n.mint(22, '0xt3', PAIR3, 1n, 1n);
  assert.equal((await w.poll()).events.length, 0); assert.equal((await w.poll()).events.length, 0);
});
test('a pool created in an EARLIER poll still reports its later liquidity (Mint in a later block)', async () => {
  const n = new Node(); const w = new V2LaunchWatcher(cfg(), n); n.mine(1); n.created(21, '0xa', WETH, TOK_A, PAIR1); assert.deepEqual((await w.poll()).events.map(e => e.type), ['pool-created']);
  n.mine(2); n.mint(23, '0xb', PAIR1, 4n * 10n ** 18n, 9n); const { events } = await w.poll(); assert.deepEqual(events.map(e => [e.type, e.quoteLiquidity]), [['liquidity-added', 4n * 10n ** 18n]]);
});
test('reorg: the launch tx vanishing is reported once; node errors keep the cursor; snapshot/load resumes without duplicates', async () => {
  const n = new Node(); const w = new V2LaunchWatcher(cfg(), n); n.mine(1); n.created(21, '0xa', WETH, TOK_A, PAIR1); n.mint(21, '0xa', PAIR1, 1n, 1n);
  n.fail = true; await assert.rejects(() => w.poll(), /node down/); assert.equal(w.cursor, 21); n.fail = false;
  assert.equal((await w.poll()).events.length, 2); const snap = structuredClone(w.snapshot()); const w2 = new V2LaunchWatcher(cfg(), n); w2.load(snap); n.mine(1); assert.equal((await w2.poll()).events.length, 0);
  n.txs.delete('0xa'); const r = await w2.poll(); assert.deepEqual(r.reorged, [{ chain: 'evm-test', txHash: '0xa' }]); assert.equal((await w2.poll()).reorged.length, 0);
});
