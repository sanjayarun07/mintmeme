import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaderWatcher, keccak256, bytesToHex } from '../src/index.ts';
import { A } from './fixtures.ts';

// MOCK NODE: proves our parsing/cursor/reorg logic on logs shaped like the ones observed on a real anvil fork; it does not prove any real node behaves so.
const LEADER = A(0xaaa1), OTHER = A(0xbbb2), TOKEN = A(0x2002), USDC = A(0x3003), WETH = A(0x1001), ROUTER = A(0xdddd), PAIR = A(0x9999);
const topic = (s: string) => bytesToHex(keccak256(new TextEncoder().encode(s)));
const TRANSFER = topic('Transfer(address,address,uint256)'), WITHDRAWAL = topic('Withdrawal(address,uint256)');
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0'), w32 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0'), hx = (n: number | bigint) => '0x' + n.toString(16);
const tr = (token: string, from: string, to: string, amt: bigint, i: number) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: w32(amt), logIndex: hx(i) });
type Tx = { hash: string; from: string; to: string; value: bigint; status?: string; logs: any[] };

class Node {
  blocks: { number: number; hash: string; txs: Tx[] }[] = []; bal = new Map<string, bigint>(); fail = false; gen = 0; calls: string[] = [];
  constructor() { for (let i = 0; i <= 10; i++) this.mine([]); }
  mine(txs: Tx[]) { this.blocks.push({ number: this.blocks.length, hash: '0xb' + this.gen++ + '_' + this.blocks.length, txs }); }
  rewind(to: number) { this.blocks.length = to + 1; }
  setBal(token: string, who: string, block: number, v: bigint) { this.bal.set(`${token}|${who}|${block}`, v); }
  find(h: string) { for (const b of this.blocks) { const t = b.txs.find(x => x.hash === h); if (t) return { b, t }; } }
  async call<T = any>(method: string, p: any[] = []): Promise<T> {
    this.calls.push(method); if (this.fail) throw new Error('node down');
    switch (method) {
      case 'eth_blockNumber': return hx(this.blocks.length - 1) as any;
      case 'eth_getBlockByNumber': { const b = this.blocks[Number(BigInt(p[0]))]; if (!b) return null as any;
        return { number: hx(b.number), hash: b.hash, transactions: p[1] ? b.txs.map(t => ({ hash: t.hash, from: t.from, to: t.to, value: hx(t.value) })) : b.txs.map(t => t.hash) } as any; }
      case 'eth_getTransactionReceipt': { const f = this.find(p[0]); if (!f) return null as any; return { status: f.t.status ?? '0x1', blockHash: f.b.hash, blockNumber: hx(f.b.number), logs: f.t.logs } as any; }
      case 'eth_call': { const who = '0x' + p[0].data.slice(34), blk = Number(BigInt(p[1])); return w32(this.bal.get(`${p[0].to}|${who}|${blk}`) ?? 0n) as any; }
      case 'eth_getTransactionByHash': { const f = this.find(p[0]); return (f ? { hash: f.t.hash, from: f.t.from, to: f.t.to, value: hx(f.t.value), blockNumber: hx(f.b.number) } : null) as any; }
      case 'eth_getLogs': { const q = p[0], lo = Number(BigInt(q.fromBlock)), hi = Number(BigInt(q.toBlock)), [t0, t1, t2] = q.topics, any = (want: any, got: string) => want == null || (Array.isArray(want) ? want.includes(got) : want === got), out: any[] = [];
        for (const b of this.blocks.slice(lo, hi + 1)) for (const t of b.txs) for (const l of t.logs) if (any(t0, l.topics[0]) && any(t1, l.topics[1]) && any(t2, l.topics[2])) out.push({ ...l, transactionHash: t.hash, blockNumber: hx(b.number), blockHash: b.hash });
        return out as any; }
      default: throw new Error('unexpected ' + method);
    }
  }
}
const cfg = (o = {}) => ({ chain: 'evm-test', weth: WETH, leaders: [LEADER], quoteTokens: ['NATIVE'], minConfirmations: 0, ...o });
const buy = (hash = '0x01', value = 10n ** 18n, got = 2_000_000n): Tx => ({ hash, from: LEADER, to: ROUTER, value, logs: [tr(TOKEN, PAIR, LEADER, got, 4)] });
const sell = (hash = '0x02', amt = 2_000_000n, out = 9n * 10n ** 17n): Tx => ({ hash, from: LEADER, to: ROUTER, value: 0n, logs: [tr(TOKEN, LEADER, PAIR, amt, 3), { address: WETH, topics: [WITHDRAWAL, pad(ROUTER)], data: w32(out), logIndex: hx(5) }] });

test('starts from NOW: history before the first poll is never copied', async () => {
  const n = new Node(); n.mine([buy()]); const w = new LeaderWatcher(cfg(), n); const r = await w.poll(); assert.equal(r.events.length, 0);
  n.mine([buy('0x03')]); n.setBal(TOKEN, LEADER, 11, 0n); n.setBal(TOKEN, LEADER, 12, 2_000_000n); assert.equal((await w.poll()).events.length, 1);
});
test('native->token buy is recognised: side, amounts, price and balances before/after', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11 }), n); n.mine([buy()]); n.setBal(TOKEN, LEADER, 10, 5n); n.setBal(TOKEN, LEADER, 11, 2_000_005n); n.mine([]); n.mine([]);
  const [e] = (await w.poll()).events;
  assert.deepEqual({ k: e.kind, s: e.side, t: e.token, q: e.quoteAmount, ta: e.tokenAmount, b: e.leaderBalanceBefore, a: e.leaderBalanceAfter, p: e.leaderPriceE18, c: e.confirmations, li: e.logIndex },
    { k: 'swap', s: 'buy', t: TOKEN, q: 10n ** 18n, ta: 2_000_000n, b: 5n, a: 2_000_005n, p: 10n ** 18n * 10n ** 18n / 2_000_000n, c: 3, li: 4 });
});
test('token->native sell (WETH unwrapped to the leader) is recognised', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11 }), n); n.mine([sell()]); n.setBal(TOKEN, LEADER, 10, 2_000_000n); n.setBal(TOKEN, LEADER, 11, 0n);
  const [e] = (await w.poll()).events; assert.equal(e.side, 'sell'); assert.equal(e.quoteAmount, 9n * 10n ** 17n); assert.equal(e.tokenAmount, 2_000_000n); assert.equal(e.leaderBalanceAfter, 0n);
});
test('ERC-20 quote tokens work too (USDC -> token)', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11, quoteTokens: [USDC] }), n);
  n.mine([{ hash: '0x07', from: LEADER, to: ROUTER, value: 0n, logs: [tr(USDC, LEADER, PAIR, 500n, 1), tr(TOKEN, PAIR, LEADER, 77n, 2)] }]); n.setBal(TOKEN, LEADER, 11, 77n);
  const [e] = (await w.poll()).events; assert.equal(e.kind, 'swap'); assert.equal(e.side, 'buy'); assert.equal(e.quoteAmount, 500n); assert.equal(e.tokenAmount, 77n);
});
test('not swaps / not the leader / reverted: ignored or labelled transfer, never a swap', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11 }), n);
  n.mine([{ ...buy('0x10'), from: OTHER }, { ...buy('0x11'), status: '0x0' }, { hash: '0x12', from: LEADER, to: TOKEN, value: 0n, logs: [] },                      // other wallet / reverted / approve-like (no value moved)
    { hash: '0x13', from: LEADER, to: TOKEN, value: 0n, logs: [tr(TOKEN, OTHER, LEADER, 5n, 0)] }]);                                                                  // token arrived with no quote leg
  const r = await w.poll(); assert.deepEqual(r.events.map(e => [e.txHash, e.kind]), [['0x13', 'transfer']]);
});
test('minConfirmations holds the event until deep enough, then releases once', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11, minConfirmations: 3 }), n); n.mine([buy()]); n.setBal(TOKEN, LEADER, 11, 2_000_000n);
  assert.equal((await w.poll()).events.length, 0); n.mine([]); assert.equal((await w.poll()).events.length, 0);
  n.mine([]); const r = await w.poll(); assert.equal(r.events.length, 1); assert.equal(r.events[0].confirmations, 3); assert.equal((await w.poll()).events.length, 0);
});
test('reorg: an emitted tx that vanished is reported once; a held one is dropped silently; re-mined copies are not re-emitted', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11 }), n); n.mine([buy()]); n.setBal(TOKEN, LEADER, 11, 2_000_000n);
  assert.equal((await w.poll()).events.length, 1);
  n.rewind(10); n.mine([]); n.mine([]); n.mine([]);                                   // block 11 replaced by an empty block, chain longer than before
  const r = await w.poll(); assert.deepEqual(r.reorged, [{ chain: 'evm-test', txHash: '0x01' }]); assert.equal(r.events.length, 0); assert.equal((await w.poll()).reorged.length, 0);
  n.rewind(12); n.mine([buy()]); n.setBal(TOKEN, LEADER, 13, 2_000_000n);               // the same tx is mined again later: same id, never emitted twice
  const again = await w.poll(); assert.equal(again.events.length, 0);
});
test('node errors do not lose progress; snapshot/load resumes at the same cursor without duplicates', async () => {
  const n = new Node(); const w = new LeaderWatcher(cfg({ startBlock: 11 }), n); n.mine([buy()]); n.setBal(TOKEN, LEADER, 11, 2_000_000n);
  n.fail = true; await assert.rejects(() => w.poll(), /node down/); assert.equal(w.cursor, 11); n.fail = false;
  assert.equal((await w.poll()).events.length, 1); const w2 = new LeaderWatcher(cfg({ startBlock: 11 }), n); w2.load(structuredClone(w.snapshot())); n.mine([]); assert.equal((await w2.poll()).events.length, 0); assert.equal(w2.cursor, 13);
});

test("scan 'logs': finds the leader's buys and sells from Transfer logs, reads only those transactions, and ignores trades the leader did not send", async () => {
  const n = new Node(), w = new LeaderWatcher(cfg({ scan: 'logs' }), n); await w.poll();   // start: now
  for (let i = 0; i < 40; i++) n.mine([]);                                                // 40 empty blocks: no block is read whole
  n.mine([buy('0x11')]); const b = n.blocks.length - 1; n.setBal(TOKEN, LEADER, b - 1, 0n); n.setBal(TOKEN, LEADER, b, 2_000_000n);
  n.mine([{ hash: '0x12', from: OTHER, to: ROUTER, value: 10n ** 17n, logs: [tr(TOKEN, PAIR, LEADER, 5n, 2)] }]);   // someone else's trade sends the leader tokens: not the leader's
  n.calls.length = 0; const r = await w.poll();
  assert.deepEqual(r.events.map(e => [e.txHash, e.kind, e.side]), [['0x11', 'swap', 'buy']]);
  assert.equal(n.calls.filter(c => c === 'eth_getBlockByNumber').length, 1, 'only the range tip is read as a block');
  assert.equal(n.calls.filter(c => c === 'eth_getLogs').length, 2, 'one range: leader as sender, then as receiver');
  n.mine([sell('0x13')]); const s = n.blocks.length - 1; n.setBal(TOKEN, LEADER, s - 1, 2_000_000n); n.setBal(TOKEN, LEADER, s, 0n);
  const r2 = await w.poll(); assert.deepEqual(r2.events.map(e => [e.txHash, e.side, e.quoteAmount]), [['0x13', 'sell', 9n * 10n ** 17n]]);
  assert.equal((await w.poll()).events.length, 0, 'nothing twice');
});

test("scan 'logs': a failed call leaves the cursor, so the same range is read again and nothing is lost or doubled", async () => {
  const n = new Node(), w = new LeaderWatcher(cfg({ scan: 'logs' }), n); await w.poll();
  n.mine([buy('0x21')]); const b = n.blocks.length - 1; n.setBal(TOKEN, LEADER, b - 1, 0n); n.setBal(TOKEN, LEADER, b, 2_000_000n);
  const before = w.cursor; n.fail = true; await assert.rejects(w.poll()); assert.equal(w.cursor, before);
  n.fail = false; assert.deepEqual((await w.poll()).events.map(e => e.txHash), ['0x21']); assert.equal((await w.poll()).events.length, 0);
});
