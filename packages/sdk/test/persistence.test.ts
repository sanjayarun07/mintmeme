import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Trader, createSimTrader, PRACTICE_TOKEN as T } from '../src/index.ts';
import { Engine, Router, Store, NATIVE, SyncRedis, openRedisState } from '../../core/src/index.ts';
import type { Backend } from '../../core/src/index.ts';

/** A "crash": throw the whole Trader away and build a new one from ONLY what was written to disk (state files + the engine store snapshot) over the same chain. */
const world = (state?: (n: string) => Backend) => {
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-persist-')); const s = createSimTrader({ persistDir: state ? undefined : dir }); let n = 0;
  const cfg = { chain: s.chain, userId: 'u1', venues: ['uniswap-v2'], clockMs: () => (n += 1), persistDir: state ? undefined : dir, state, advanceChain: () => { const t = s.chain.time; s.chain.mine(4); s.chain.time = t; } };
  const restart = (engine: Engine) => new Trader({ ...cfg, engine: new Engine({ store: Store.restore(engine.d.store.snapshot()), chain: s.chain, signer: s.signer, router: new Router(s.chain), platformFeeBps: 100 }) });
  const first = new Trader({ ...cfg, engine: s.engine }); return { ...s, first, restart, dir };
};

test('the pause switch survives a restart', async () => {
  const w = world(); w.first.pauseEntries(); const t2 = w.restart(w.first['engine' as keyof Trader] as any);
  assert.equal(t2.entriesPaused, true); await assert.rejects(t2.buy({ walletId: 'w1', token: T, amount: 1_000n }), /paused/); t2.resumeEntries(); assert.equal(w.restart(w.first['engine' as keyof Trader] as any).entriesPaused, false);
});

test('price alerts survive a restart and a one-shot alert that already fired does not fire again', async () => {
  const w = world(); const px = Number(w.first.spotE18(T)) / 1e18;
  w.first.addPriceAlert({ id: 'hi', token: T, direction: 'above', threshold: px * 100 }); w.first.addPriceAlert({ id: 'lo', token: T, direction: 'below', threshold: px * 2, oneShot: true });
  let fired: string[] = []; w.first.on(e => { if (e.type === 'alert') fired.push(e.id); }); await w.first.tick(); assert.deepEqual(fired, ['lo'], 'only the alert whose condition holds fires');
  const t2 = w.restart(w.first['engine' as keyof Trader] as any); fired = []; t2.on(e => { if (e.type === 'alert') fired.push(e.id); });
  await t2.tick(); await t2.tick(); assert.deepEqual(fired, [], 'the fired one-shot stays fired; the other is still waiting');
  assert.equal(t2.alerts.isActive('hi'), true); assert.equal(t2.alerts.isActive('lo'), false);
});

test('a TWAP interrupted by a crash is found again, finishes, and never trades a slice twice', async () => {
  const w = world(); await w.first.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 30_000n, slices: 3, intervalS: 60 }); await w.first.tick();
  assert.equal(w.first.twapStatus('tw').filled, 1, 'the first slice runs at once');
  const t2 = w.restart(w.first['engine' as keyof Trader] as any); assert.ok(t2.twaps.has('tw'), 'the job is back without being re-created');
  await t2.resume(); assert.equal(t2.twapStatus('tw').filled, 1);
  for (let i = 0; i < 2; i++) { w.chain.time += 61; await t2.tick(); await t2.tick(); }
  const s = t2.twapStatus('tw'); assert.equal(s.filled, 3); assert.equal(s.done, true);
  assert.equal(t2.trades().filter(x => x.key.startsWith('twap:tw:') && !x.key.endsWith(':approve')).length, 3, 'exactly three slice trades exist');
  assert.equal(w.chain.balance('w1', NATIVE) + 30_000n < 1_000_000n, true);
});

test('a bulk buy interrupted right after planning completes once per wallet', async () => {
  const w = world(); await w.first.bulkBuy({ id: 'bb', token: T, wallets: ['w1', 'w2'], total: 20_000n });
  const t2 = w.restart(w.first['engine' as keyof Trader] as any); assert.ok(t2.bulks.has('bb')); await t2.resume(); for (let i = 0; i < 5 && !t2.bulkStatus('bb').done; i++) await t2.tick();
  assert.equal(t2.bulkStatus('bb').filled, 2); const keys = t2.trades().filter(x => x.key.startsWith('bulk:bb:') && !x.key.endsWith(':approve')); assert.equal(keys.length, 2);
});

test('orders and positions are back after a restart', async () => {
  const w = world(); await w.first.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'b1' }); const held = w.chain.balance('w1', T);
  await w.first.limitSell({ id: 'ls', walletId: 'w1', token: T, amount: held / 2n, priceE18: w.first.spotE18(T)! * 3n });
  const t2 = w.restart(w.first['engine' as keyof Trader] as any); await t2.resume();
  assert.equal(t2.getOrder('ls')?.status, 'active'); assert.equal(t2.positions().find(p => p.token === T)?.balance, held, 'the position is rebuilt from the engine records');
});

test('a Backend factory (what a Redis or database layer provides) works the same as a folder', async () => {
  const mem = new Map<string, string>(); const state = (n: string): Backend => ({ read: () => mem.get(n), write: d => { mem.set(n, d); }, describe: () => `mem ${n}` });
  const w = world(state); await w.first.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 20_000n, slices: 2, intervalS: 60 }); w.first.pauseEntries();
  assert.ok(mem.has('trader') && mem.has('twap-tw'), `state went to the backend, not to disk (keys: ${[...mem.keys()]})`);
  const t2 = w.restart(w.first['engine' as keyof Trader] as any); assert.equal(t2.entriesPaused, true);
});

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
test('state in a real Redis survives a restart, and a second process cannot take the account while the first holds it', { skip: up ? false : 'no local Redis on 127.0.0.1:6379' }, async () => {
  const ns = `memedesk-test:${Date.now()}:${Math.random().toString(36).slice(2)}`; const r1 = openRedisState({ namespace: ns, requireAof: false, lockTtlMs: 5000 });
  try {
    const w = world(n => r1.backend(n)); await w.first.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 20_000n, slices: 2, intervalS: 60 }); w.first.pauseEntries();
    assert.throws(() => openRedisState({ namespace: ns, requireAof: false }), /locked by another process/, 'a second worker is refused while the first owns the state');
    const t2 = w.restart(w.first['engine' as keyof Trader] as any); assert.equal(t2.entriesPaused, true); assert.ok(t2.twaps.has('tw'));
  } finally { r1.release(); const c = new SyncRedis(); try { for (const k of ['lock', 'engine', 'orders', 'copy', 'trader', 'twap-tw']) c.cmd('DEL', `${ns}:${k}`); } finally { c.close(); } }
});
