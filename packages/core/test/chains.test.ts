import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedSolana, SimulatedTon, SimulatedTron, SimRpcError } from '../src/chains.ts';
import type { ChainAdapter } from '../src/chains.ts';

test('all fixtures are labelled simulated and describe their model', () => {
  const all: ChainAdapter<any>[] = [new SimulatedSolana(), new SimulatedTon(), new SimulatedTron()];
  for (const a of all) { assert.equal(a.simulated, true); assert.ok(a.model.account && a.model.validity && a.model.fee && a.model.finality); }
  assert.deepEqual(all.map(a => a.family), ['solana', 'ton', 'tron']);
  assert.equal(all[1].model.asyncDelivery, true);
});

// ---------- Solana ----------
test('solana: blockhash expiry by block-height window', () => {
  const c = new SimulatedSolana(); const tx = c.build({ payer: 'P', payload: 'swap1' });
  assert.equal(tx.lastValidBlockHeight, c.height + 150); assert.equal(c.isExpired(tx), false);
  c.advance(150); assert.equal(c.isExpired(tx), false, 'inclusive at lastValid'); c.advance(1); assert.equal(c.isExpired(tx), true);
  const r = c.submit(tx); assert.equal(r.accepted, false); assert.match(r.error!, /expired/);
});
test('solana: replay protection - same signature never executes twice; pending expiring tx never lands', () => {
  const c = new SimulatedSolana(); const tx = c.build({ payer: 'P', payload: 'p' });
  c.submit(tx); c.advance(1); const again = c.submit(tx); assert.equal(again.duplicate, true);
  c.advance(2); assert.equal(c.landedWithPayload('p').length, 1);
  const t2 = c.build({ payer: 'P', payload: 'q' }); c.blockCapacity = 0; c.submit(t2); c.advance(151); c.blockCapacity = 2; c.advance(5);
  assert.equal(c.status(t2.signature).landing, 'unknown');
});
test('solana: commitment levels and priority fee ordering', () => {
  const c = new SimulatedSolana(); c.blockCapacity = 1;
  const lo = c.build({ payer: 'A', payload: 'lo', priority: 0 }), hi = c.build({ payer: 'B', payload: 'hi', priority: 50_000 });
  assert.equal(c.fee(lo), 5000); assert.equal(c.fee(hi), 5000 + 10_000);
  c.submit(lo); c.submit(hi); c.advance(1);
  assert.equal(c.status(hi.signature).native, 'processed'); assert.equal(c.status(lo.signature).landing, 'pending', 'low priority waits');
  c.advance(1); assert.equal(c.status(hi.signature).native, 'confirmed'); assert.ok(c.meets(hi.signature, 'processed')); assert.ok(!c.meets(hi.signature, 'finalized'));
  c.advance(31); assert.equal(c.status(hi.signature).native, 'finalized'); assert.equal(c.status(hi.signature).landing, 'finalized');
});
test('solana: uncertain submission reconcile - fee-bumped rebuild has a NEW signature (double-execution hazard)', () => {
  const c = new SimulatedSolana(); c.dropAcks = 1; c.blockCapacity = 1;
  const tx = c.build({ payer: 'P', payload: 'buy' });
  assert.throws(() => c.submit(tx), SimRpcError);
  assert.equal(c.reconcile(tx).action, 'rebroadcast_same', 'still valid: do not rebuild');
  const bumped = c.build({ payer: 'P', payload: 'buy', blockhash: { blockhash: tx.blockhash, lastValidBlockHeight: tx.lastValidBlockHeight }, priority: 10 });
  assert.notEqual(bumped.signature, tx.signature);
  c.submit(bumped); c.advance(1); c.advance(1);               // both could land; here original also landed
  assert.equal(c.landedWithPayload('buy').length, 2, 'both signatures executed the payload => rebuilding early is unsafe');
  const c2 = new SimulatedSolana(); const t2 = c2.build({ payer: 'P', payload: 'x' }); c2.dropAcks = 1; c2.blockCapacity = 0; assert.throws(() => c2.submit(t2));
  c2.advance(1); assert.equal(c2.reconcile(t2).action, 'rebroadcast_same'); c2.blockCapacity = 2; c2.submit(t2); c2.advance(1); assert.equal(c2.reconcile(t2).action, 'already_landed');
  const c3 = new SimulatedSolana(); const t3 = c3.build({ payer: 'P', payload: 'y' }); c3.rpcDown = true; assert.throws(() => c3.submit(t3));
  c3.rpcDown = false; c3.advance(151); assert.equal(c3.reconcile(t3).action, 'safe_to_rebuild');
});

// ---------- TON ----------
test('ton: seqno replay protection and valid_until expiry', () => {
  const t = new SimulatedTon(); const m = t.build({ wallet: 'W', dest: 'D', amount: 5 });
  assert.equal(t.submit(m).accepted, true); assert.equal(t.walletSeqno('W'), 1);
  assert.equal(t.submit(m).duplicate, true, 'resend of same message is a no-op');
  const stale = t.build({ wallet: 'W', dest: 'D', amount: 5, seqno: 0, validForS: 999 });
  const r = t.submit(stale); assert.equal(r.accepted, false); assert.match(r.error!, /seqno/);
  const m2 = t.build({ wallet: 'W', dest: 'D', amount: 1, validForS: 10 }); t.advance(11);
  assert.equal(t.isExpired(m2), true); assert.match(t.submit(m2).error!, /valid_until/); assert.equal(t.walletSeqno('W'), 1, 'expired message does not consume seqno');
});
test('ton: delivered != executed; bounce is a failure', () => {
  const t = new SimulatedTon(); const ok = t.build({ wallet: 'W', dest: 'D', amount: 1 }); t.submit(ok);
  assert.equal(t.status(ok.msgHash).native, 'accepted_by_wallet'); assert.equal(t.status(ok.msgHash).landing, 'processed');
  assert.equal(t.reconcile(ok).action, 'wait');
  t.advance(10); assert.equal(t.status(ok.msgHash).landing, 'confirmed'); t.advance(5); assert.equal(t.status(ok.msgHash).landing, 'finalized');
  const bad = t.build({ wallet: 'W', dest: 'D', amount: 1, destFails: true }); t.submit(bad); t.advance(10);
  assert.equal(t.status(bad.msgHash).landing, 'failed'); assert.equal(t.status(bad.msgHash).native, 'bounced');
});
test('ton: reconcile helper', () => {
  const t = new SimulatedTon(); t.dropAcks = 1; const m = t.build({ wallet: 'W', dest: 'D', amount: 1, validForS: 30 });
  assert.throws(() => t.submit(m));   // ack lost, but wallet accepted
  assert.equal(t.walletSeqno('W'), 1);
  assert.equal(t.reconcile(m).action, 'wait', 'seqno consumed by OUR message: never rebuild with next seqno');
  const t2 = new SimulatedTon(); const m2 = t2.build({ wallet: 'W', dest: 'D', amount: 1, validForS: 30 }); t2.rpcDown = true; assert.throws(() => t2.submit(m2)); t2.rpcDown = false;
  assert.equal(t2.reconcile(m2).action, 'rebroadcast_same'); t2.advance(31); assert.equal(t2.reconcile(m2).action, 'safe_to_rebuild');
  const t3 = new SimulatedTon(); const a = t3.build({ wallet: 'W', dest: 'D', amount: 1 }); const other = t3.build({ wallet: 'W', dest: 'X', amount: 9 }); t3.submit(other);
  assert.equal(t3.reconcile(a).action, 'investigate', 'seqno taken by someone else');
});

// ---------- Tron ----------
test('tron: expiration semantics and replay protection', () => {
  const c = new SimulatedTron(); const tx = c.build({ owner: 'O', payload: 'p', validForS: 30 });
  assert.equal(c.submit(tx).accepted, true); assert.equal(c.submit(tx).duplicate, true);
  c.advance(1); assert.equal(c.submit(tx).duplicate, true, 'still no double execution after inclusion');
  assert.equal([...[c.receipt(tx.txId)]].length, 1);
  const e = c.build({ owner: 'O', payload: 'late', validForS: 5 }); c.advance(2); assert.equal(c.isExpired(e), true);   // 6s of chain time
  const r = c.submit(e); assert.equal(r.accepted, false); assert.match(r.error!, /expired/);
  const old = c.build({ owner: 'O', payload: 'old', validForS: 99999 }); c.advance(1001); assert.match(c.submit(old).error!, /reference block/);
});
test('tron: resource model - free bandwidth, staked energy, burn, fee_limit', () => {
  const c = new SimulatedTron(); c.setResources('O', 300, 1000);
  const a = c.build({ owner: 'O', payload: 'a', bytes: 250, energyRequired: 800, feeLimitSun: 0 }); c.submit(a); c.advance(1);
  assert.deepEqual([c.receipt(a.txId)!.ok, c.receipt(a.txId)!.burnedSun], [true, 0], 'covered fully by free bandwidth + staked energy');
  const b = c.build({ owner: 'O', payload: 'b', bytes: 250, energyRequired: 700, feeLimitSun: 50_000 }); c.submit(b); c.advance(1);
  // free bw left 50 -> burn 200*1000; energy left 200 -> burn 500*100 = 50_000 (== fee_limit, ok)
  assert.deepEqual([c.receipt(b.txId)!.ok, c.receipt(b.txId)!.burnedSun], [true, 200_000 + 50_000]);
  const d = c.build({ owner: 'O', payload: 'd', bytes: 100, energyRequired: 1000, feeLimitSun: 10_000 }); c.submit(d); c.advance(1);
  const rd = c.receipt(d.txId)!; assert.equal(rd.ok, false); assert.equal(rd.burnedSun, 100_000 + 10_000, 'fee still burned up to fee_limit');
  assert.equal(c.status(d.txId).landing, 'failed');
});
test('tron: solidified confirmation level', () => {
  const c = new SimulatedTron(); const tx = c.build({ owner: 'O', payload: 'p' }); c.submit(tx); c.advance(1);
  assert.equal(c.status(tx.txId).native, 'in_block'); assert.equal(c.status(tx.txId).landing, 'processed'); assert.match(c.status(tx.txId).note!, /unsolidified/);
  c.advance(19); assert.equal(c.status(tx.txId).native, 'solidified'); assert.equal(c.status(tx.txId).landing, 'finalized');
});
test('tron: reconcile helper', () => {
  const c = new SimulatedTron(); c.dropAcks = 1; const tx = c.build({ owner: 'O', payload: 'p', validForS: 30 });
  assert.throws(() => c.submit(tx)); assert.equal(c.reconcile(tx).action, 'wait', 'known to node');
  c.advance(1); assert.equal(c.reconcile(tx).action, 'already_landed');
  const d = new SimulatedTron(); const t2 = d.build({ owner: 'O', payload: 'q', validForS: 10 }); d.rpcDown = true; assert.throws(() => d.submit(t2)); d.rpcDown = false;
  assert.equal(d.reconcile(t2).action, 'rebroadcast_same'); d.time += 11; assert.equal(d.reconcile(t2).action, 'rebroadcast_same', 'within node-lag margin');
  d.time += 3; assert.equal(d.reconcile(t2).action, 'safe_to_rebuild');
});
