import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, NATIVE, CopyRunner, SyncRedis, openRedisState } from '../src/index.ts';
import type { ChainPort, SimChain, CopyConfig, LeaderEvent, LeaderSource } from '../src/index.ts';
import { world, TOK } from './fixtures.ts';

const E18 = 10n ** 18n, tick = () => new Promise(r => setTimeout(r, 1));
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); if (c.rpcDown) throw new Error('rpc down'); p.time = c.time; p.block = c.block; p.state = c.state; },
    async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); }, async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); },
    async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
/** Scripted leader feed: cursor is part of the source state, exactly like the real watcher's block cursor. */
class FakeSource implements LeaderSource {
  cursor = 0; reorg: { chain: string; txHash: string }[] = []; fail = false; polls = 0;
  constructor(public script: LeaderEvent[]) {}
  async poll() { this.polls++; if (this.fail) throw new Error('scan failed'); const events = this.script.slice(this.cursor); this.cursor = this.script.length; const reorged = this.reorg; this.reorg = []; return { events, reorged }; }
  snapshot() { return { cursor: this.cursor }; } load(s: any) { this.cursor = s.cursor; }
}
const cfg = (o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f1', walletId: 'w1', userId: 'u1', leader: 'L', chain: 'sim-evm', quoteToken: NATIVE, mode: 'fixed', fixed: 10_000n, ratioBps: 0, sides: 'both',
  maxPerLeader: 100_000n, maxPerToken: 100_000n, dailyLimit: 250_000n, maxPositions: 3, cooldownS: 0, minLiquidity: 100n, maxDeviationBps: 500, minConfirmations: 0, followLeaderExit: true, slippageBps: 300, venues: ['uniswap-v2'], ...o });
const ev = (o: Partial<LeaderEvent> = {}): LeaderEvent => ({ provider: 'rpc', chain: 'sim-evm', txHash: '0xaa', logIndex: 1, leader: 'L', kind: 'swap', side: 'buy', token: TOK, quoteAmount: 50_000n, tokenAmount: 50_000n,
  leaderBalanceBefore: 0n, leaderBalanceAfter: 50_000n, leaderPriceE18: E18, confirmations: 1, ...o });
function setup(script: LeaderEvent[], cfgs = [cfg()], opts: { persist?: import('../src/index.ts').Persist; store?: Store } = {}) {
  const w = world(); const p = port(w.chain); const source = new FakeSource(script);
  const engine = new Engine({ store: opts.store ?? w.store, chain: p, signer: w.signer, router: new Router(p), platformFeeBps: 100 });
  const runner = new CopyRunner({ engine, chain: p, source, cfgs, persistPath: opts.persist });
  return { ...w, store: opts.store ?? w.store, p, source, engine, runner };
}
const settleAll = async (s: { chain: SimChain; runner: CopyRunner }) => { for (let i = 0; i < 8 && s.runner.inflight.size; i++) { s.chain.mine(2); await s.runner.settle(); } };

test('leader buy is mirrored through the engine; fill is attributed to that leader with cost basis', async () => {
  const s = setup([ev()]); const t = await s.runner.tick();
  assert.equal(t.events, 1); assert.equal(t.submitted.length, 1); assert.match(t.submitted[0], /^copy:f1:sim-evm:0xaa:1$/);
  await settleAll(s); const r = s.store.records.get(t.submitted[0])!;
  assert.equal(r.state, 'finalized'); assert.equal(r.intent.origin, 'copy'); assert.equal(r.intent.amountIn, 10_000n);
  assert.equal(s.runner.copy.attributed('f1', 'L', TOK), r.fill!.received); assert.equal(s.runner.copy.exposure('f1', 'L'), r.fill!.spent);
  assert.equal(s.runner.copy.positionStatus('f1', 'L', TOK), 'open');
});
test('the same leader event seen again (re-scan / second provider) never copies twice', async () => {
  const s = setup([ev()]); await s.runner.tick(); await settleAll(s);
  s.source.script.push(ev()); await s.runner.tick(); await settleAll(s);
  assert.equal([...s.store.records.keys()].filter(k => k.startsWith('copy:')).length, 1); assert.ok(s.runner.copy.log.some(l => l.decision.includes('duplicate')));
});
test('leader exit: follower sells exactly its attributed tokens, nothing else', async () => {
  const s = setup([ev()]); s.chain.credit('w1', TOK, 777n);   // unrelated pre-existing holding must stay untouched
  await s.runner.tick(); await settleAll(s); const mine = s.runner.copy.attributed('f1', 'L', TOK);
  s.source.script.push(ev({ txHash: '0xbb', side: 'sell', tokenAmount: 50_000n, leaderBalanceBefore: 50_000n, leaderBalanceAfter: 0n }));
  const t = await s.runner.tick(); await settleAll(s); const r = s.store.records.get(t.submitted[0])!;
  assert.equal(r.state, 'finalized'); assert.equal(r.intent.amountIn, mine); assert.equal(s.runner.copy.attributed('f1', 'L', TOK), 0n); assert.equal(s.chain.balance('w1', TOK), 777n);
});
test('leader reorg after a fast (0-conf) copy: position flagged orphaned, attribution reversed, NO automatic sell', async () => {
  const s = setup([ev()]); await s.runner.tick(); await settleAll(s); const before = [...s.store.records.keys()].length;
  s.source.reorg = [{ chain: 'sim-evm', txHash: '0xaa' }]; const t = await s.runner.tick();
  assert.equal(t.reorged, 1); assert.equal(s.runner.copy.positionStatus('f1', 'L', TOK), 'orphaned'); assert.equal(s.runner.copy.attributed('f1', 'L', TOK), 0n);
  assert.equal(t.submitted.length, 0); assert.equal([...s.store.records.keys()].length, before); assert.ok(s.chain.balance('w1', TOK) > 0n);
});
test('skip reasons are recorded and nothing is sent: price moved, token filtered, liquidity', async () => {
  const s = setup([ev({ leaderPriceE18: 2n * E18 }), ev({ txHash: '0xbb', token: '0xOTHER' })], [cfg({ allow: [TOK] })]);
  const t = await s.runner.tick(); assert.equal(t.submitted.length, 0); assert.equal(s.store.records.size, 0);
  assert.deepEqual(s.runner.copy.log.filter(l => l.decision.startsWith('skip')).map(l => l.decision), ['skip: price moved beyond deviation limit', 'skip: token filtered']);
  const s2 = setup([ev()], [cfg({ minLiquidity: 10n ** 30n })]); await s2.runner.tick(); assert.equal(s2.store.records.size, 0); assert.ok(s2.runner.copy.log.some(l => l.decision.includes('liquidity')));
});
test('budget caps hold across several events and in-flight buys count against them', async () => {
  const s = setup([ev({ txHash: '0x01' }), ev({ txHash: '0x02' }), ev({ txHash: '0x03' })], [cfg({ maxPerToken: 25_000n })]);
  const t = await s.runner.tick(); assert.equal(t.submitted.length, 3); await settleAll(s);
  const amounts = [...s.store.records.values()].filter(r => r.intent.origin === 'copy').map(r => r.intent.amountIn).sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(amounts, [5_000n, 10_000n, 10_000n]);
});
test('node down / scan failure: nothing changes, error reported, recovers on the next tick', async () => {
  const s = setup([ev()]); s.source.fail = true; let t = await s.runner.tick(); assert.match(t.error!, /leader scan failed/); assert.equal(s.store.records.size, 0);
  s.source.fail = false; s.chain.rpcDown = true; t = await s.runner.tick(); assert.match(t.error!, /node unreachable/); assert.equal(s.source.polls, 1);
  s.chain.rpcDown = false; t = await s.runner.tick(); assert.equal(t.submitted.length, 1);
});
test('two configs on one chain with different quote tokens are refused', () => {
  assert.throws(() => setup([], [cfg(), cfg({ follower: 'f2', quoteToken: '0xUSDC' })]), /same quote token/);
});

// ---- durability: crash sweep
function files() { const d = mkdtempSync(join(tmpdir(), 'memedesk-copy-')); return { ef: join(d, 'engine.json'), cf: join(d, 'copy.json'), d }; }
test('crash after the write-ahead checkpoint but before the engine hand-over: restart submits the SAME key once', async () => {
  const { ef, cf } = files(); const w1 = world(); const s1 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) });
  const real = s1.engine.submit.bind(s1.engine); (s1.engine as any).submit = async () => { throw new Error('process killed'); };
  await assert.rejects(() => s1.runner.tick(), /process killed/); void real; void w1;
  assert.equal(s1.runner.outbox.length, 1);
  // "restart": new objects over the SAME chain, only the files survive
  const s2 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) }); assert.equal(s2.runner.outbox.length, 1); assert.equal(s2.source.cursor, 1);
  await s2.runner.resume(); await settleAll(s2); await s2.runner.tick();
  assert.equal([...s2.store.records.keys()].filter(k => k.startsWith('copy:')).length, 1); assert.equal(s2.runner.copy.attributed('f1', 'L', TOK), s2.store.records.get('copy:f1:sim-evm:0xaa:1')!.fill!.received);
});
test('crash BEFORE the checkpoint (old file): the leader block is re-read and the SAME key is used; still one copy', async () => {
  const { ef, cf } = files(); const s1 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) });
  s1.runner.checkpoint(); const old = cf + '.old'; copyFileSync(cf, old);   // the file as it was before the tick
  await s1.runner.tick(); await settleAll(s1);
  copyFileSync(old, cf);                                                    // crash: the new state never reached disk
  const s2 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) }); assert.equal(s2.source.cursor, 0);
  await s2.runner.resume(); await s2.runner.tick(); await settleAll(s2);
  assert.equal([...s2.store.records.keys()].filter(k => k.startsWith('copy:')).length, 1);
  assert.equal(s2.runner.copy.attributed('f1', 'L', TOK), s2.store.records.get('copy:f1:sim-evm:0xaa:1')!.fill!.received);
});
test('crash after the fill but before attribution is written: restart attributes it exactly once; state file holds no keys', async () => {
  const { ef, cf } = files(); const s1 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) });
  const t = await s1.runner.tick(); s1.chain.mine(3); await s1.engine.advance(t.submitted[0]); s1.chain.mine(3); await s1.engine.advance(t.submitted[0]);   // engine finalizes; runner never settled
  assert.equal(s1.store.records.get(t.submitted[0])!.state, 'finalized'); assert.equal(s1.runner.copy.attributed('f1', 'L', TOK), 0n);
  const s2 = setup([ev()], [cfg()], { persist: cf, store: Store.open(ef) }); await s2.runner.resume(); await s2.runner.resume();
  assert.equal(s2.runner.copy.attributed('f1', 'L', TOK), s2.store.records.get(t.submitted[0])!.fill!.received); assert.equal(s2.runner.inflight.size, 0);
  assert.ok(!/key|secret/i.test(readFileSync(cf, 'utf8').replace(/idempotencyKey/g, '')));
});

let redisUp = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); redisUp = c.cmd('PING') === 'PONG'; c.close(); } catch { redisUp = false; }
test('REDIS backend: crash after the write-ahead checkpoint, restart after the lock expires: SAME key submitted once, attributed once', { skip: redisUp ? false : 'no local Redis' }, async () => {
  const ns = `memedesk-test:copy:${Date.now()}:${Math.random().toString(36).slice(2)}`, o = { namespace: ns, requireAof: false, lockTtlMs: 400 };
  const r1 = openRedisState(o); try {
    const s1 = setup([ev()], [cfg()], { persist: r1.copy, store: Store.open(r1.engine) });
    (s1.engine as any).submit = async () => { throw new Error('process killed'); };
    await assert.rejects(() => s1.runner.tick(), /process killed/); assert.equal(s1.runner.outbox.length, 1);
    r1.client.close();                                              // crash: lock is NOT released
    assert.throws(() => openRedisState(o), /locked by another process/);
    await new Promise(r => setTimeout(r, 500));
    const r2 = openRedisState({ ...o, lockTtlMs: 5000 }); try {
      const s2 = setup([ev()], [cfg()], { persist: r2.copy, store: Store.open(r2.engine) }); assert.equal(s2.runner.outbox.length, 1); assert.equal(s2.source.cursor, 1);
      await s2.runner.resume(); await settleAll(s2); await s2.runner.tick();
      assert.equal([...s2.store.records.keys()].filter(k => k.startsWith('copy:')).length, 1);
      assert.equal(s2.runner.copy.attributed('f1', 'L', TOK), s2.store.records.get('copy:f1:sim-evm:0xaa:1')!.fill!.received);
    } finally { r2.release(); }
  } finally { const c = new SyncRedis(); for (const k of ['lock', 'engine', 'orders', 'copy']) c.cmd('DEL', `${ns}:${k}`); c.close(); }
});
