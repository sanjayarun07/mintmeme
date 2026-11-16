import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Router, NATIVE, RpcError } from '../src/index.ts';
import type { ChainPort, SimChain } from '../src/index.ts';
import { world, TOK } from './fixtures.ts';

const tick = () => new Promise(r => setTimeout(r, 1));
/** A networked-style port over SimChain: every call is async with a real delay, `time/block` are snapshots updated only by refresh(), and evict is NOT offered (like a real node). */
function asyncPort(c: SimChain, o: { evict?: boolean } = {}): ChainPort & { refreshes: number } {
  const p: any = {
    id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, refreshes: 0,
    venues: () => c.venues(),
    async refresh() { await tick(); p.time = c.time; p.block = c.block; p.state = c.state; p.refreshes++; },
    async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); },
    async simulate(tx: any) { await tick(); return c.simulate(tx); },
    async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); },
    async receipt(h: string) { await tick(); return c.receipt(h); },
    async confirmations(h: string) { await tick(); return c.confirmations(h); },
  };
  if (o.evict) p.evict = async (h: string) => { await tick(); return c.evict(h); };
  return p;
}
function setup(o: { evict?: boolean } = {}) {
  const w = world(); const port = asyncPort(w.chain, o);
  const engine = new Engine({ store: w.store, chain: port, signer: w.signer, router: new Router(port), platformFeeBps: 100 });
  return { ...w, port, engine };
}

test('engine drives a trade to finalized through a delayed async port; fill comes from the receipt', async () => {
  const w = setup();
  let r = await w.engine.submit(w.intent({ idempotencyKey: 'a1' })); assert.ok(['submitted', 'observed'].includes(r.state));
  w.chain.mine(); r = await w.engine.advance('a1'); assert.equal(r.state, 'confirmed');
  w.chain.mine(2); r = await w.engine.advance('a1'); assert.equal(r.state, 'finalized');
  assert.equal(r.fill!.received, w.chain.balance('w1', TOK)); assert.ok(w.port.refreshes > 0, 'refresh() is called by the engine');
});
test('concurrent submits of one idempotency key execute once on the async port', async () => {
  const w = setup(); const i = w.intent({ idempotencyKey: 'dup' });
  await Promise.all([w.engine.submit(i), w.engine.submit(i), w.engine.submit(i)]);
  w.chain.mine(4); const r = await w.engine.advance('dup');
  assert.equal(r.state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1);
});
test('lost submit ack on the async port reconciles by hash without a second send', async () => {
  const w = setup(); w.chain.failNextSubmitAck = 1;
  let r = await w.engine.submit(w.intent({ idempotencyKey: 'ack' }));
  assert.ok(['submitted', 'observed'].includes(r.state), r.state); assert.equal(w.chain.mempool.size, 1);
  w.chain.mine(4); r = await w.engine.advance('ack'); assert.equal(r.state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1);
});
test('restart from a snapshot resumes on the async port with one execution', async () => {
  const w = setup(); w.chain.failNextSubmitAck = 1;
  await w.engine.submit(w.intent({ idempotencyKey: 'rs' }));
  const { Store } = await import('../src/index.ts'); const store2 = Store.restore(w.store.snapshot());
  const engine2 = new Engine({ store: store2, chain: w.port, signer: w.signer, router: new Router(w.port), platformFeeBps: 100 });
  w.chain.mine(4); const done = await engine2.advance('rs');
  assert.equal(done.state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1);
});
test('a node that is unreachable mid-flight leaves the record resumable, never failed', async () => {
  const w = setup(); w.chain.rpcDown = true;
  let r = await w.engine.submit(w.intent({ idempotencyKey: 'down' }));
  assert.ok(!['failed', 'finalized'].includes(r.state), r.state);
  w.chain.rpcDown = false; w.chain.mine(); r = await w.engine.advance('down'); w.chain.mine(4); r = await w.engine.advance('down');
  assert.equal(r.state, 'finalized');
});
test('cancelling a PENDING tx is refused with a clear reason when the port cannot evict atomically', async () => {
  const w = setup({ evict: false }); await w.engine.submit(w.intent({ idempotencyKey: 'pend' }));
  const res = await w.engine.cancelNonce('w1', { force: true });
  assert.equal(res.status, 'pending'); assert.match(res.reason ?? '', /cannot atomically cancel/);
  w.chain.mine(4); assert.equal((await w.engine.advance('pend')).state, 'finalized');   // the original was untouched and still lands
});
test('cancelling a PENDING tx still works when the port offers atomic evict', async () => {
  const w = setup({ evict: true }); await w.engine.submit(w.intent({ idempotencyKey: 'pend2' }));
  const res = await w.engine.cancelNonce('w1', { force: true });
  assert.equal(res.status, 'cancelled'); w.chain.mine(4); await w.engine.advance(res.noopKey!);
  assert.equal(w.chain.confirmedNonce('w1'), 1); assert.equal(w.chain.balance('w1', TOK), 0n);
});
test('prepare() hook: real hash replaces the placeholder, signer charge is released under the original digest on failure', async () => {
  const w = setup(); const base = asyncPort(w.chain) as any;
  base.prepare = async (tx: any) => ({ hash: '0x' + 'ab'.repeat(32), raw: '0xdead' });
  base.submit = async () => { throw new Error('rejected by node: nonce too low'); };
  const engine = new Engine({ store: w.store, chain: base, signer: w.signer, router: new Router(base), platformFeeBps: 100 });
  const r = await engine.submit(w.intent({ idempotencyKey: 'prep' }));
  assert.equal(r.state, 'failed'); assert.equal(r.tx!.hash, '0x' + 'ab'.repeat(32)); assert.equal(r.tx!.raw, '0xdead'); assert.ok(r.authDigest && r.authDigest !== r.tx!.hash);
  const again = await engine.submit(w.intent({ idempotencyKey: 'prep2', amountIn: 100_000n }));   // daily limit would be exhausted if the failed tx's charge were not released
  assert.ok(again.state === 'failed' && /rejected by node/.test(again.failure ?? ''), again.failure);
});
test('prepare() failure fails the trade before anything is sent and releases the limit charge', async () => {
  const w = setup(); const base = asyncPort(w.chain) as any;
  base.prepare = async () => { throw new Error('platform fee collection is not implemented on this chain'); };
  const engine = new Engine({ store: w.store, chain: base, signer: w.signer, router: new Router(base), platformFeeBps: 100 });
  const r = await engine.submit(w.intent({ idempotencyKey: 'nofee' }));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /could not build transaction: platform fee/); assert.equal(w.chain.mempool.size, 0);
});
