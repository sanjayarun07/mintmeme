import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, TOK } from './fixtures.ts';
import { NATIVE, Engine, Router, Store, PolicySigner, MemoryLedger, CpAmm } from '../src/index.ts';
import type { SignRequest } from '../src/index.ts';

// ---------- 1. nonce gap / cancel-replace ----------
async function gapWorld() {
  const w = world();
  const a = await w.engine.submit(w.intent({ idempotencyKey: 'A', deadline: w.chain.time + 30, amountIn: 10_000n }));
  const b = await w.engine.submit(w.intent({ idempotencyKey: 'B', amountIn: 5_000n }));
  assert.equal(a.tx!.nonce, 0); assert.equal(b.tx!.nonce, 1);
  return { w, a, b };
}

test('H1a. permanently dead nonce 0 blocks nonce 1 until cancelNonce replaces it with a noop', async () => {
  const { w, a } = await gapWorld();
  w.chain.mempool.delete(a.tx!.hash);                      // node dropped A
  w.chain.mine(5);                                          // A's deadline passes; B (nonce 1) can never execute
  assert.equal((await w.engine.advance('B')).state, 'observed');
  assert.equal(w.chain.confirmedNonce('w1'), 0); assert.equal(w.chain.balance('w1', TOK), 0n);
  assert.equal((await w.engine.advance('A')).state, 'expired');
  const used = w.signer.spentFor('w1', NATIVE, 19675);
  assert.equal(used, 5_000n, 'expired A released its signer charge; only B remains charged');
  const res = await w.engine.cancelNonce('w1', { reason: 'test' });
  assert.equal(res.status, 'cancelled'); assert.equal(res.nonce, 0);
  const noop = w.store.records.get(res.noopKey!)!; assert.equal(noop.tx!.kind, 'noop'); assert.equal(noop.tx!.nonce, 0);
  assert.match(w.store.records.get('A')!.failure!, /nonce 0 cancelled: test/);
  w.chain.mine(4);
  assert.equal((await w.engine.advance(res.noopKey!)).state, 'finalized');
  assert.equal((await w.engine.advance('B')).state, 'finalized');
  assert.equal(w.chain.confirmedNonce('w1'), 2); assert.ok(w.chain.balance('w1', TOK) > 0n);
  assert.equal(w.store.records.get(res.noopKey!)!.fill, undefined);
  assert.equal((await w.engine.healNonce('w1')), undefined, 'nothing left to heal');
});

test('H1b. never replaces a nonce whose original is still pending (unless forced); nothing to do once included', async () => {
  const { w, a } = await gapWorld();
  const res = await w.engine.cancelNonce('w1');
  assert.equal(res.status, 'pending'); assert.equal(w.chain.mempool.has(a.tx!.hash), true);
  assert.ok(![...w.store.records.keys()].some(k => k.startsWith('noop:')));
  // forced replace of a pending tx: evict is atomic in SimChain; original ends expired, its charge released, B proceeds
  const forced = await w.engine.cancelNonce('w1', { force: true, reason: 'operator' });
  assert.equal(forced.status, 'cancelled'); assert.equal(forced.nonce, 0);
  w.chain.mine(4);
  assert.equal((await w.engine.advance('A')).state, 'expired'); assert.equal((await w.engine.advance('B')).state, 'finalized');
  assert.equal(w.chain.confirmedNonce('w1'), 2); assert.equal(w.chain.receipt(a.tx!.hash), undefined, 'A never executed');
  assert.equal(w.signer.spentFor('w1', NATIVE, 19675), 5_000n);
  // included originals are never replaced
  const w2 = await gapWorld(); w2.w.chain.mine();
  assert.equal((await w2.w.engine.cancelNonce('w1')).status, 'nothing');
  assert.ok(![...w2.w.store.records.keys()].some(k => k.startsWith('noop:')));
});

test('H1c. cancelNonce with RPC down does nothing; noop send survives ack loss and restart', async () => {
  const { w, a } = await gapWorld();
  w.chain.mempool.delete(a.tx!.hash); w.chain.mine(5); await w.engine.advance('A');
  w.chain.rpcDown = true; assert.equal((await w.engine.cancelNonce('w1')).status, 'rpc_down'); w.chain.rpcDown = false;
  w.chain.failNextSubmitAck = 1;
  const res = await w.engine.cancelNonce('w1');
  assert.equal(res.status, 'cancelled'); assert.equal(w.chain.mempool.size, 2);        // noop + B, noop not duplicated
  const store2 = Store.restore(w.store.snapshot());
  const e2 = new Engine({ ...w.engine.d, store: store2 });
  const again = await e2.cancelNonce('w1'); assert.equal(again.noopKey, res.noopKey);   // idempotent after restart
  assert.equal([...store2.records.keys()].filter(k => k.startsWith('noop:')).length, 1);
  w.chain.mine(4); await e2.advance(res.noopKey!); assert.equal((await e2.advance('B')).state, 'finalized');
  assert.equal(w.chain.confirmedNonce('w1'), 2);
});

test('H1d. noop obeys signer: unknown/foreign wallet cannot be cancelled', async () => {
  const w = world();
  const s = new PolicySigner(new Map([['w1', 'k1']]), w.policies);
  assert.throws(() => s.sign({ userId: 'u2', walletId: 'w1', chain: 'sim-evm', kind: 'noop', token: NATIVE, amount: 0n, digest: 'd', origin: 'manual', day: 1 }), /another user/);
  assert.throws(() => s.sign({ userId: 'u1', walletId: 'w1', chain: 'other', kind: 'noop', token: NATIVE, amount: 0n, digest: 'd', origin: 'manual', day: 1 }), /chain/);
});

// ---------- 2. signer charge / release / persistence ----------
const req = (o: Partial<SignRequest> = {}): SignRequest => ({ userId: 'u1', walletId: 'w1', chain: 'sim-evm', kind: 'swap', token: NATIVE, amount: 10_000n, venue: 'uniswap-v2', digest: 'd1', origin: 'manual', day: 5, ...o });

test('H2a. charge on sign, idempotent per digest, release frees headroom exactly once', () => {
  const w = world(); const s = new PolicySigner(new Map([['w1', 'k1']]), w.policies);
  s.sign(req({ digest: 'd1', amount: 100_000n })); s.sign(req({ digest: 'd1', amount: 100_000n }));      // re-sign same digest: no double charge
  assert.equal(s.spentFor('w1', NATIVE, 5), 100_000n);
  s.sign(req({ digest: 'd2', amount: 100_000n })); assert.equal(s.spentFor('w1', NATIVE, 5), 200_000n);
  assert.throws(() => s.sign(req({ digest: 'd3', amount: 100_000n })), /daily limit/);
  assert.equal(s.release('d2'), true); assert.equal(s.release('d2'), false); assert.equal(s.release('nope'), false);
  assert.equal(s.spentFor('w1', NATIVE, 5), 100_000n);
  s.sign(req({ digest: 'd3', amount: 100_000n }));                                                         // headroom is back
  assert.equal(s.spentFor('w1', NATIVE, 5), 200_000n);
});

test('H2b. ledger persistence: limits and releases survive signer restart', () => {
  const w = world(); const keys = new Map([['w1', 'k1']]); const ledger = new MemoryLedger();
  const s1 = new PolicySigner(keys, w.policies, ledger);
  s1.sign(req({ digest: 'a', amount: 100_000n })); s1.sign(req({ digest: 'b', amount: 100_000n }));
  const s2 = new PolicySigner(keys, w.policies, MemoryLedger.restore(ledger.snapshot()));                 // restart
  assert.equal(s2.spentFor('w1', NATIVE, 5), 200_000n);
  assert.throws(() => s2.sign(req({ digest: 'c', amount: 100_000n })), /daily limit/);
  assert.equal(s2.release('a'), true);                                                                     // charge record persisted too
  const s3 = new PolicySigner(keys, w.policies, MemoryLedger.restore((s2 as any).ledger.snapshot()));
  assert.equal(s3.release('a'), false); assert.equal(s3.spentFor('w1', NATIVE, 5), 100_000n);
  s3.sign(req({ digest: 'c', amount: 100_000n }));
  assert.equal(s3.spentFor('w1', NATIVE, 5), 200_000n);
});

test('H2c. engine: rejected/expired txs release the charge; included (even reverted) keeps it', async () => {
  const w = world();
  // reverted on-chain: charge stays
  await w.engine.submit(w.intent({ idempotencyKey: 'p' }));
  await w.engine.submit(w.intent({ idempotencyKey: 'victim', slippageBps: 5 }));
  await w.engine.submit(w.intent({ idempotencyKey: 'mover', walletId: 'w2', amountIn: 90_000n, slippageBps: 5000 }));
  w.chain.mine(); assert.equal((await w.engine.advance('victim')).state, 'failed');
  assert.equal(w.signer.spentFor('w1', NATIVE, 19675), 20_000n, 'reverted-but-included keeps its charge (gas spent)');
  // expired absent: released
  const e = await w.engine.submit(w.intent({ idempotencyKey: 'exp', deadline: w.chain.time + 30 }));
  assert.equal(w.signer.spentFor('w1', NATIVE, 19675), 30_000n);
  w.chain.mempool.clear(); w.chain.mine(5); assert.equal((await w.engine.advance('exp')).state, 'expired');
  assert.equal(w.signer.spentFor('w1', NATIVE, 19675), 20_000n); assert.ok(e.tx);
  // submit rejected (nonce too low because another tx consumed nonce): released
  const r = await w.engine.submit(w.intent({ idempotencyKey: 'rej' }));
  w.chain.mempool.clear(); w.chain.nextNonceMap.set('w1', r.tx!.nonce + 1);
  assert.equal((await w.engine.advance('rej')).state, 'failed');
  assert.equal(w.signer.spentFor('w1', NATIVE, 19675), 20_000n);
});

// ---------- 3. reorg ----------
test('H3. reorg: receipt disappears -> unresolved -> re-observed after re-inclusion; no duplicate execution; fill from NEW receipt', async () => {
  const w = world();
  await w.engine.submit(w.intent({ idempotencyKey: 'A', slippageBps: 5000 }));
  await w.engine.submit(w.intent({ idempotencyKey: 'M', walletId: 'w2', amountIn: 90_000n, slippageBps: 5000 }));
  w.chain.mine(); const a1 = await w.engine.advance('A'); await w.engine.advance('M');
  assert.equal(a1.state, 'confirmed'); const fill1 = { ...a1.fill! }; const hashA = a1.tx!.hash;
  assert.ok(w.chain.reorgReinclude(hashA)); assert.equal(w.chain.receipt(hashA), undefined);
  assert.equal(w.chain.balance('w1', TOK), 0n, 'state rolled back'); assert.equal(w.chain.confirmedNonce('w1'), 0);
  // adversarial ordering after reorg: M lands first, A second (different price)
  const txA = w.chain.mempool.get(hashA)!; w.chain.mempool.delete(hashA); w.chain.mempool.set(hashA, txA);
  let a = await w.engine.advance('A');
  assert.equal(a.state, 'observed'); assert.ok(a.history.some(h => h.note?.includes('receipt disappeared')));
  w.chain.mine(); a = await w.engine.advance('A'); await w.engine.advance('M');
  assert.equal(a.state, 'confirmed');
  const rc = w.chain.receipt(hashA)!;
  assert.notEqual(rc.block, 101); assert.equal(a.confirmedBlock, rc.block);
  assert.equal(a.fill!.received, rc.deltas[TOK]); assert.equal(a.fill!.received, w.chain.balance('w1', TOK));
  assert.notEqual(a.fill!.received, fill1.received, 'fill recomputed from the new receipt, not kept from the old one');
  assert.equal(w.chain.confirmedNonce('w1'), 1, 'executed exactly once'); assert.equal([...w.chain.receipts.keys()].filter(h => h === hashA).length, 1);
  w.chain.mine(3); assert.equal((await w.engine.advance('A')).state, 'finalized');
});

test('H3b. reorg+re-inclusion between two advance() calls is detected via changed block', async () => {
  const w = world();
  await w.engine.submit(w.intent({ idempotencyKey: 'A', slippageBps: 1000 }));
  w.chain.mine(); const a1 = await w.engine.advance('A'); assert.equal(a1.state, 'confirmed'); const b1 = a1.confirmedBlock;
  w.chain.reorgReinclude(a1.tx!.hash); w.chain.mine();                                    // engine never saw the gap
  const a = await w.engine.advance('A');
  assert.ok(a.history.some(h => h.note?.startsWith('receipt changed')));
  assert.equal(a.state, 'confirmed'); assert.notEqual(a.confirmedBlock, b1); assert.equal(w.chain.confirmedNonce('w1'), 1);
  assert.equal(a.fill!.received, w.chain.balance('w1', TOK));
});

// ---------- 4. fuzz ----------
function prng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

for (const seed of [1, 2, 3]) test(`H4. fuzz seed ${seed}: 500 intents with ack loss, rpc down, drops, restarts, reorgs`, async () => {
  const rnd = prng(seed), ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const w = world({ dailyLimit: 150_000n }); const ledger = new MemoryLedger();
  const keys = new Map([['w1', 'k1'], ['w2', 'k2']]);
  const mkSigner = (l: MemoryLedger) => new PolicySigner(keys, w.policies, l);
  let signer = mkSigner(ledger); let engine = new Engine({ ...w.engine.d, signer });
  const chain = w.chain, WALLETS = ['w1', 'w2'], pool0 = chain.state.venues.get('uni-v2:MEME') as CpAmm;
  const totalNative0 = 2_000_000n + pool0.rQuote, totalTok0 = pool0.rToken;
  const keysUsed: string[] = []; const intents = new Map<string, ReturnType<typeof w.intent>>();
  const live = () => keysUsed.filter(k => !['finalized', 'failed', 'expired'].includes(engine.d.store.records.get(k)!.state));
  const advanceAll = async () => { for (const k of live()) await engine.advance(k); for (const wl of WALLETS) await engine.healNonce(wl); };

  for (let n = 0; n < 500; n++) {
    const roll = rnd();
    if (roll < 0.04) { chain.rpcDown = true; }
    else if (roll < 0.10) { chain.rpcDown = false; }
    if (rnd() < 0.08) chain.failNextSubmitAck = 1;
    if (rnd() < 0.05 && chain.mempool.size) { const hs = [...chain.mempool.keys()]; chain.mempool.delete(hs[ri(0, hs.length - 1)]); }       // node drop
    if (rnd() < 0.04) {                                                                                                                     // restart (consistent boundary)
      const store2 = Store.restore(engine.d.store.snapshot()); signer = mkSigner(MemoryLedger.restore(ledger.snapshot()));
      // keep using the same ledger object for new signer so its writes continue to be observed by the invariant checks
      (signer as any).ledger = ledger; engine = new Engine({ ...engine.d, store: store2, signer });
    }
    if (rnd() < 0.04) {                                                                                                                     // shallow reorg
      const rcs = [...chain.receipts.values()].filter(r => chain.confirmations(r.hash) < 3);
      if (rcs.length) chain.reorgReinclude(rcs[ri(0, rcs.length - 1)].hash);
    }
    const key = rnd() < 0.15 && keysUsed.length ? keysUsed[ri(0, keysUsed.length - 1)] : `f${n}`;   // 15%: retry an existing key
    if (!intents.has(key)) {
      const it = w.intent({ idempotencyKey: key, walletId: WALLETS[ri(0, 1)], amountIn: BigInt(ri(500, 30_000)), slippageBps: ri(50, 2000), deadline: chain.time + ri(20, 400),
        ...(rnd() < 0.3 ? { tokenIn: TOK, tokenOut: NATIVE, amountIn: BigInt(ri(10, 3000)) } : {}) });
      intents.set(key, it); keysUsed.push(key);
    }
    try { await engine.submit(intents.get(key)!); } catch (e) { assert.fail('engine threw: ' + (e as Error).stack); }
    if (rnd() < 0.5) chain.mine(ri(1, 3));
    if (rnd() < 0.6) await advanceAll();
  }
  // drain with all faults off
  chain.rpcDown = false; chain.failNextSubmitAck = 0;
  for (let i = 0; i < 400 && live().length; i++) { chain.mine(1); await advanceAll(); }
  for (let i = 0; i < 6; i++) { chain.mine(1); await advanceAll(); }
  assert.deepEqual(live().map(k => engine.d.store.records.get(k)!.state), [], 'all records terminal after drain');

  const recs = [...engine.d.store.records.values()];
  const byHash = new Map<string, typeof recs[number]>(); for (const r of recs) if (r.tx?.hash && r.signature) byHash.set(r.tx.hash, r);
  // (1) each idempotency key executes at most once; every receipt belongs to a known signed record; noops are at most one per nonce
  const perKey = new Map<string, number>();
  for (const h of chain.receipts.keys()) { const r = byHash.get(h); assert.ok(r, 'receipt for unknown tx ' + h); perKey.set(r.key, (perKey.get(r.key) ?? 0) + 1); }
  for (const [k, c] of perKey) assert.equal(c, 1, `key ${k} executed ${c} times`);
  // (2) confirmed nonces contiguous & unique per wallet; mempool holds nothing stale
  for (const wl of WALLETS) {
    const ns = [...chain.receipts.values()].map(r => byHash.get(r.hash)!.tx!).filter(t => t.wallet === wl).map(t => t.nonce).sort((a, b) => a - b);
    assert.deepEqual(ns, ns.map((_, i) => i), `${wl} nonces contiguous`); assert.equal(chain.confirmedNonce(wl), ns.length);
  }
  assert.equal([...chain.mempool.values()].filter(t => t.nonce < chain.confirmedNonce(t.wallet)).length, 0);
  const pool = chain.state.venues.get('uni-v2:MEME') as CpAmm;   // venues are cloned on every exec/reorg: re-read
  // (3) conservation: wallets + pool + PLATFORM == initial - gas burned
  const burned = BigInt([...chain.receipts.values()].filter(r => r.reason !== 'insufficient gas').length) * chain.gasFee;
  const sum = (t: string) => chain.balance('w1', t) + chain.balance('w2', t) + chain.balance('PLATFORM', t);
  assert.equal(sum(NATIVE) + pool.rQuote + burned, totalNative0, 'native conserved');
  assert.equal(sum(TOK) + pool.rToken, totalTok0, 'token conserved');
  // (4) confirmed/finalized always have a receipt, fill matches the receipt currently on chain
  for (const r of recs) if (r.state === 'confirmed' || r.state === 'finalized') {
    const rc = chain.receipt(r.tx!.hash); assert.ok(rc, `${r.key} ${r.state} without receipt`); assert.equal(rc.status, 'success');
    if (r.tx!.kind !== 'noop') assert.equal(r.fill!.received, (r.intent.tokenOut === NATIVE ? rc.deltas[NATIVE]! + rc.network : rc.deltas[r.intent.tokenOut]!));
  }
  // (5) spend never exceeds limits and ledger equals the sum of still-charged txs
  const charged = new Map<string, bigint>();
  for (const r of recs) if (r.signature && r.tx!.kind !== 'noop' && r.signDay !== undefined && (chain.receipts.has(r.tx!.hash) || !['failed', 'expired'].includes(r.state))) {
    const dk = `${r.tx!.wallet}:${r.intent.tokenIn}:${r.signDay}`; charged.set(dk, (charged.get(dk) ?? 0n) + r.intent.amountIn);
  }
  for (const [dk, amt] of charged) { const [wl, tok, d] = dk.split(':'); assert.ok(amt <= w.policies.get(wl)!.dailyLimit[tok]!, 'limit exceeded ' + dk); assert.equal(signer.spentFor(wl, tok, Number(d)), amt, 'ledger drift ' + dk); }
  const stats = { recs: recs.length, receipts: chain.receipts.size, noops: recs.filter(r => r.tx?.kind === 'noop').length, expired: recs.filter(r => r.state === 'expired').length };
  assert.ok(stats.receipts > 50, JSON.stringify(stats));
  console.log(`fuzz seed ${seed}`, JSON.stringify(stats));
});
