import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, NATIVE, OrderRunner, CpAmm, writeAtomic } from '../src/index.ts';
import type { ChainPort, SimChain, Order } from '../src/index.ts';
import { world, TOK } from './fixtures.ts';

const E18 = 10n ** 18n, tick = () => new Promise(r => setTimeout(r, 0));
class Crash extends Error {}
function port(c: SimChain): ChainPort {
  const p: any = { id: c.id, family: c.family, time: c.time, block: c.block, finalityDepth: c.finalityDepth, state: c.state, venues: () => c.venues(),
    async refresh() { await tick(); p.time = c.time; p.block = c.block; p.state = c.state; }, async balanceOf(w: string, t: string) { await tick(); return c.balance(w, t); },
    async confirmedNonce(w: string) { await tick(); return c.confirmedNonce(w); }, async simulate(tx: any) { await tick(); return c.simulate(tx); }, async submit(tx: any) { await tick(); return c.submit(tx); },
    async lookup(h: string) { await tick(); return c.lookup(h); }, async receipt(h: string) { await tick(); return c.receipt(h); }, async confirmations(h: string) { await tick(); return c.confirmations(h); } };
  return p;
}
function env() {
  const w = world(); w.chain.credit('w1', TOK, 1000n); const p = port(w.chain); const dir = mkdtempSync(join(tmpdir(), 'memedesk-'));
  const files = { store: join(dir, 'engine.json'), orders: join(dir, 'orders.json') };
  /** Build everything FROM DISK (a process start). `limit` = how many checkpoint writes this process may complete before it "crashes" (throws before the next write). */
  const build = (limit = Infinity) => {
    let count = 0; const guard = (orig: () => void) => () => { if (count >= limit) throw new Crash(`crash before write #${count + 1}`); orig(); count++; };
    const store = Store.open(files.store); const sc = store.checkpoint.bind(store); store.checkpoint = guard(sc);
    const engine = new Engine({ store, chain: p, signer: w.signer, router: new Router(p), platformFeeBps: 100 });
    const runner = new OrderRunner({ engine, chain: p, clockMs: () => 1000, persistPath: files.orders });
    const rc = runner.checkpoint.bind(runner); runner.checkpoint = guard(rc);
    return { store, engine, runner, writes: () => count };
  };
  const order = (o: Partial<Order> = {}): Order => ({ id: 'o1', userId: 'u1', walletId: 'w1', chain: 'sim-evm', token: TOK, quoteToken: NATIVE, kind: 'take_profit', amount: 400n, triggerPriceE18: E18, expiresAt: w.chain.time + 5000,
    maxQuoteAgeMs: 5000, minLiquidity: 100n, maxDeviationBps: 500, maxAttempts: 2, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0, ...o });
  return { ...w, p, dir, files, build, order };
}

test('atomic write: the target is always a complete file; no temp files are left behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-')); const f = join(dir, 'x.json');
  for (let i = 0; i < 20; i++) writeAtomic(f, JSON.stringify({ i, pad: 'x'.repeat(i * 100) }));
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).i, 19); assert.deepEqual(readdirSync(dir), ['x.json']);
});
test('file-backed engine store: signed tx is on disk before it is sent', async () => {
  const e = env(); const a = e.build(); const seen: string[] = [];
  const realSubmit = e.p.submit.bind(e.p); e.p.submit = async (tx: any) => { const disk = JSON.parse(readFileSync(e.files.store, 'utf8'), (k, v) => v); seen.push(JSON.stringify(disk).includes(tx.hash) ? 'on-disk' : 'MISSING'); return realSubmit(tx); };
  await a.engine.submit(e.intent({ idempotencyKey: 'wal' })); assert.deepEqual(seen, ['on-disk']);
});
test('CRASH SWEEP: kill the process before every checkpoint write; restart from disk; the order executes exactly once and ends in a consistent state', async t => {
  let completedWithoutCrash = false, sweeps = 0;
  for (let limit = 0; limit < 80 && !completedWithoutCrash; limit++, sweeps++) {
    const e = env(); const a = e.build(limit);
    try {
      await a.runner.place(e.order()); await a.runner.tick(); e.chain.mine(2); await a.runner.settle(); e.chain.mine(3); await a.runner.settle(); completedWithoutCrash = true;
    } catch (err) { if (!(err instanceof Crash)) throw err; }
    const b = e.build(); await b.runner.resume();
    if (!b.runner.orders.orders.has('o1')) await b.runner.place(e.order());   // crashed before the order was ever durable: the user would simply retry
    for (let i = 0; i < 8; i++) { e.chain.mine(2); await b.runner.tick(); await b.runner.settle(); }
    const why = `limit ${limit}`;
    assert.equal(e.chain.confirmedNonce('w1'), 1, `exactly one execution (${why})`);
    assert.equal(e.chain.balance('w1', TOK), 600n, why);
    assert.equal(b.store.records.get('order:o1:a0')?.state, 'finalized', why);
    assert.equal(b.runner.orders.orders.get('o1')!.status, 'fired', why);
    assert.equal(b.runner.reservations.reservedTotal('w1', TOK), 0n, why); assert.equal(b.runner.inflight.size, 0, why); assert.equal(b.runner.outbox.length, 0, why);
    assert.equal([...b.store.records.keys()].filter(k => k.startsWith('order:o1')).length, 1, why);
  }
  t.diagnostic(`swept ${sweeps} crash points`); assert.ok(completedWithoutCrash, 'sweep reached a crash-free run'); assert.ok(sweeps >= 8, `swept ${sweeps} crash points`);
});
test('OCO claim and cancelled sibling survive a restart: the stop-loss cannot fire after the take-profit did', async () => {
  const e = env(); const a = e.build();
  await a.runner.place(e.order({ id: 'tp', ocoGroup: 'g' })); await a.runner.place(e.order({ id: 'sl', kind: 'stop_loss', ocoGroup: 'g', triggerPriceE18: 2n * E18 }));   // SL would also be "met" (price 1 <= 2)
  const t = await a.runner.tick(); assert.deepEqual(t.fired, ['tp']);
  const b = e.build(); await b.runner.resume(); for (let i = 0; i < 5; i++) { e.chain.mine(2); await b.runner.tick(); }
  assert.equal(b.runner.orders.orders.get('sl')!.status, 'cancelled'); assert.equal(e.chain.confirmedNonce('w1'), 1);
});
test('trailing-stop peak survives a restart', async () => {
  const e = env(); const a = e.build(); const v = e.chain.state.venues.get('uni-v2:MEME') as CpAmm;
  await a.runner.place(e.order({ id: 't', kind: 'trailing_stop', trailBps: 1000, triggerPriceE18: undefined }));
  v.rQuote = 2_000_000n; assert.deepEqual((await a.runner.tick()).fired, []); assert.equal(a.runner.orders.orders.get('t')!.peakE18, 2n * E18);
  const b = e.build(); await b.runner.resume(); assert.equal(b.runner.orders.orders.get('t')!.peakE18, 2n * E18);
  v.rQuote = 1_700_000n; assert.deepEqual((await b.runner.tick()).fired, ['t']);   // 1.7 <= 2.0 * 0.9 only because the old peak was kept
});
test('reservations survive a restart: the same balance cannot be reserved twice by a new order', async () => {
  const e = env(); const a = e.build(); await a.runner.place(e.order({ id: 'a', amount: 700n, triggerPriceE18: 5n * E18 }));
  const b = e.build(); await b.runner.resume();
  assert.equal(b.runner.reservations.reservedTotal('w1', TOK), 700n);
  await assert.rejects(b.runner.place(e.order({ id: 'b', amount: 400n, triggerPriceE18: 5n * E18 })), /insufficient unreserved/);
});
test('cancel is durable; a corrupt/foreign-version state file is refused, not guessed', async () => {
  const e = env(); const a = e.build(); await a.runner.place(e.order({ id: 'c', triggerPriceE18: 5n * E18 })); a.runner.cancel('c');
  const b = e.build(); assert.equal(b.runner.orders.orders.get('c')!.status, 'cancelled'); assert.equal(b.runner.reservations.reservedTotal('w1', TOK), 0n);
  writeFileSync(e.files.orders, JSON.stringify({ v: 99 })); assert.throws(() => e.build(), /unsupported order state version 99/);
  writeFileSync(e.files.orders, '{"v":1,"orders":'); assert.throws(() => e.build());
});
