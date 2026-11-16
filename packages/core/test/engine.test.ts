import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, TOK, TAX, HONEY } from './fixtures.ts';
import { NATIVE, Engine, Router, Store } from '../src/index.ts';

test('1. manual buy then partial sell; fill from receipt deltas, fees separated', async () => {
  const w = world();
  let r = await w.engine.submit(w.intent({ idempotencyKey: 'buy1' }));
  assert.ok(['observed', 'submitted'].includes(r.state));
  assert.equal(w.chain.balance('w1', TOK), 0n, 'no balance before mining');
  w.chain.mine(); r = await w.engine.advance('buy1'); assert.equal(r.state, 'confirmed');
  w.chain.mine(2); r = await w.engine.advance('buy1'); assert.equal(r.state, 'finalized');
  const f = r.fill!; assert.equal(f.received, w.chain.balance('w1', TOK));
  assert.equal(f.platformFee, 100n); assert.equal(f.spent, 10_000n); assert.equal(f.networkFee, 1000n);
  assert.equal(f.shortfall, 0n);
  const half = f.received / 2n;
  await w.engine.submit(w.intent({ idempotencyKey: 'sell1', tokenIn: TOK, tokenOut: NATIVE, amountIn: half, slippageBps: 500 }));
  w.chain.mine(3); const s = await w.engine.advance('sell1'); assert.equal(s.state, 'finalized');
  assert.equal(w.chain.balance('w1', TOK), f.received - half);
  assert.equal(s.fill!.received, w.chain.balance('w1', NATIVE) - (1_000_000n - 10_000n - 1000n - 1000n) );
});

test('2. multi-wallet trading uses independent nonces', async () => {
  const w = world();
  await w.engine.submit(w.intent({ idempotencyKey: 'a', walletId: 'w1', slippageBps: 1000 }));
  await w.engine.submit(w.intent({ idempotencyKey: 'b', walletId: 'w2', slippageBps: 1000 }));
  await w.engine.submit(w.intent({ idempotencyKey: 'c', walletId: 'w1', slippageBps: 1000 }));
  w.chain.mine(4);
  for (const k of ['a', 'b', 'c']) assert.equal((await w.engine.advance(k)).state, 'finalized');
  assert.ok(w.chain.balance('w1', TOK) > 0n && w.chain.balance('w2', TOK) > 0n);
  assert.equal(w.chain.confirmedNonce('w1'), 2);
});

test('8. honeypot rejected in simulation, taxed token shortfall is visible', async () => {
  const w = world();
  const h = await w.engine.submit(w.intent({ idempotencyKey: 'h', tokenOut: HONEY, venues: ['uniswap-v2'] }));
  assert.ok(['submitted','observed'].includes(h.state));   // buying a honeypot simulates fine; the SELL is what is blocked
  w.chain.mine(); w.chain.credit('w1', HONEY, 5000n);
  const sell = await w.engine.submit(w.intent({ idempotencyKey: 'hs', tokenIn: HONEY, tokenOut: NATIVE, amountIn: 5000n }));
  assert.equal(sell.state, 'failed'); assert.match(sell.failure!, /simulation reverted.*transfer blocked/);
  const t = await w.engine.submit(w.intent({ idempotencyKey: 't', tokenOut: TAX, slippageBps: 300 }));
  assert.equal(t.state, 'failed'); assert.match(t.failure!, /minOut/);                       // tax exceeds slippage: no silent widening
  const t2 = await w.engine.submit(w.intent({ idempotencyKey: 't2', tokenOut: TAX, slippageBps: 1500 }));
  w.chain.mine(); const f = (await w.engine.advance('t2')).fill!; assert.ok(f.shortfall > 0n);
});

test('9. RPC failure after submit: reconcile finds tx, no duplicate', async () => {
  const w = world(); w.chain.failNextSubmitAck = 1;
  let r = await w.engine.submit(w.intent({ idempotencyKey: 'ack' }));
  assert.ok(['submitted', 'observed'].includes(r.state), r.state);
  assert.equal(w.chain.mempool.size, 1);
  w.chain.mine(4); r = await w.engine.advance('ack'); assert.equal(r.state, 'finalized');
  assert.equal(w.chain.confirmedNonce('w1'), 1);
  const again = await w.engine.submit(w.intent({ idempotencyKey: 'ack' }));       // retry same key
  assert.equal(again.state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1);
});

test('9b. RPC down at submit then recovers: same tx resubmitted, one execution', async () => {
  const w = world(); w.chain.rpcDown = false;
  const r0 = await w.engine.submit(w.intent({ idempotencyKey: 'down' }));
  assert.ok(r0.tx);
  w.chain.mempool.clear();                       // node lost it (dropped)
  w.chain.rpcDown = true; await w.engine.advance('down'); w.chain.rpcDown = false;
  const r = await w.engine.advance('down');
  assert.ok(['submitted', 'observed'].includes(r.state), r.state); w.chain.mine(4);
  assert.equal((await w.engine.advance('down')).state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1);
});

test('10. worker restart without duplicate trading', async () => {
  const w = world(); w.chain.failNextSubmitAck = 1;
  await w.engine.submit(w.intent({ idempotencyKey: 'rs' }));
  const store2 = Store.restore(w.store.snapshot());                                   // process dies, state reloaded
  const engine2 = new Engine({ store: store2, chain: w.chain, signer: w.signer, router: new Router(w.chain), platformFeeBps: 100 });
  const r1 = await engine2.submit(w.intent({ idempotencyKey: 'rs' })); const r2 = await engine2.advance('rs');
  w.chain.mine(4); const done = await engine2.advance('rs');
  assert.equal(done.state, 'finalized'); assert.equal(w.chain.confirmedNonce('w1'), 1); assert.equal(r1.key, r2.key);
});

test('expired when deadline passes before inclusion and tx absent', async () => {
  const w = world(); const r0 = await w.engine.submit(w.intent({ idempotencyKey: 'exp', deadline: w.chain.time + 30 }));
  w.chain.mempool.clear(); w.chain.mine(5);
  const r = await w.engine.advance('exp'); assert.equal(r.state, 'expired');
});

test('on-chain revert is failure, never success', async () => {
  const w2 = world(); await w2.engine.submit(w2.intent({ idempotencyKey: 'p' }));
  const q = await w2.engine.submit(w2.intent({ idempotencyKey: 'victim', slippageBps: 5 }));
  await w2.engine.submit(w2.intent({ idempotencyKey: 'mover', walletId: 'w2', amountIn: 90_000n, slippageBps: 5000 }));
  w2.chain.mine(); const v = await w2.engine.advance('victim');
  assert.equal(v.state, 'failed'); assert.match(v.failure!, /reverted on-chain/); assert.equal(v.fill, undefined);
});

test('4b/5. bonding curve buy, graduation keeps token identity and routes to successor pool', async () => {
  const { LinearCurve } = await import('../src/index.ts'); const w = world();
  const c = new LinearCurve('pump:NEW', 'pump-like', '0xNEW', NATIVE, 10n, 1n, 0n, 0n, 20_000n); w.chain.addVenue(c);
  const i = (k: string, amt: bigint) => w.intent({ idempotencyKey: k, tokenOut: '0xNEW', venues: ['pump-like'], amountIn: amt, slippageBps: 500 });
  await w.engine.submit(i('c1', 15_000n)); w.chain.mine(); assert.equal((await w.engine.advance('c1')).state, 'confirmed');
  assert.equal(w.chain.state.venues.get('pump:NEW')!.status, 'active');
  await w.engine.submit(i('c2', 10_000n)); w.chain.mine();
  assert.equal(w.chain.state.venues.get('pump:NEW')!.status, 'graduated');
  const r = await w.engine.submit(i('c3', 5_000n));               // same token, same authorized family, now served by the pool
  assert.equal(r.quote!.venue, 'pump:NEW-pool'); w.chain.mine(); assert.ok((await w.engine.advance('c3')).fill!.received > 0n);
});
