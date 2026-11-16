import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpTradeSource, FallbackTradeSource, makeTradeSource, parseTrade } from '../src/indexport.ts';
import type { TradeSource, FeedToken, FeedTrade, CycleResult } from '../src/indexport.ts';
import { TradeFeed } from '../src/tradefeed.ts';

const tok: FeedToken = { id: 'e1', sym: 'PEPE', chain: 'ethereum', contract: '0xc0ffee', pool: '0xAbC0000000000000000000000000000000000001', pad: null };
const item = (o: any = {}) => ({ pool: tok.pool.toLowerCase(), chain: 'ethereum', side: 'buy', wallet: '0xw1', usd: 1200, tx: '0xt1', t: '2026-11-15T10:00:00.000Z', ...o });

/** A real local HTTP server that speaks the indexer contract. */
async function indexer(handler: (url: URL) => { status?: number; body: any }) {
  const srv = createServer((req, res) => { const r = handler(new URL(req.url!, 'http://x')); res.statusCode = r.status ?? 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r.body)); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => srv.close(() => r())) };
}

test('parseTrade accepts a good trade and drops malformed, unknown-pool, wrong-chain and non-finite ones', () => {
  const by = new Map([[tok.pool.toLowerCase(), tok]]);
  assert.equal(parseTrade(item(), by)?.sym, 'PEPE');
  for (const bad of [null, 'x', item({ pool: '0xother' }), item({ chain: 'bnb' }), item({ chain: 'dogechain' }), item({ side: 'hold' }), item({ usd: 'NaN' }), item({ usd: -1 }), item({ usd: 1e15 }), item({ tx: '' }), item({ t: 'not a date' }), item({ wallet: 'x'.repeat(200) })]) assert.equal(parseTrade(bad, by), null);
});

test('HttpTradeSource: first poll is a silent baseline, later trades are fresh, duplicates are dropped', async () => {
  let items: any[] = [item()]; const seen: string[] = [];
  const s = await indexer(u => { seen.push(u.search); return { body: { items, health: { lagS: 2 } } }; });
  try {
    const src = new HttpTradeSource(s.url, { now: () => Date.parse('2026-11-15T10:05:00Z') });
    const r1 = await src.pollCycle([tok]); assert.equal(r1.fresh.length, 0); assert.equal(src.query().length, 1); assert.equal(src.query()[0].fresh, false);
    items = [item(), item({ tx: '0xt2', t: '2026-11-15T10:01:00.000Z', usd: 5000 })];
    const r2 = await src.pollCycle([tok]); assert.equal(r2.fresh.length, 1); assert.equal(r2.fresh[0].tx, '0xt2'); assert.equal(src.query().length, 2);
    const r3 = await src.pollCycle([tok]); assert.equal(r3.fresh.length, 0);
    assert.ok(seen[1].includes('since='), 'later polls ask only for newer trades');
    assert.equal(src.status().lagS, 2); assert.equal(src.status().lastError, null); assert.equal(src.loaded, 1);
  } finally { await s.close(); }
});

test('HttpTradeSource: bad JSON shape, HTTP errors and an unreachable server throw plain-text errors; malformed items are dropped', async () => {
  let mode = 'shape';
  const s = await indexer(() => mode === 'shape' ? { body: { nope: 1 } } : mode === 'http' ? { status: 503, body: {} } : { body: { items: [item(), { junk: true }, item({ usd: 'x' })] } });
  const src = new HttpTradeSource(s.url);
  await assert.rejects(src.pollCycle([tok]), /unexpected shape/); assert.match(src.status().lastError!, /unexpected shape/);
  mode = 'http'; await assert.rejects(src.pollCycle([tok]), /HTTP 503/);
  mode = 'ok'; await src.pollCycle([tok]); assert.equal(src.query().length, 1, 'only the valid item is kept'); assert.equal(src.status().lastError, null);
  await s.close();
  await assert.rejects(src.pollCycle([tok]), /unreachable/);
  assert.throws(() => new HttpTradeSource('ftp://x'), /http/);
});

class Fake implements TradeSource {
  recent: FeedTrade[] = []; errors = new Map<string, string>(); lastFill = 0; loaded = 0; fail: string | null = null; lagS: number | undefined; calls = 0;
  constructor(readonly name: string) {}
  async pollCycle(): Promise<CycleResult> { this.calls++; if (this.fail) throw new Error(this.fail); return { fresh: [], polled: 1, errors: 0 }; }
  query() { return this.recent; }
  status() { return { name: this.name, serving: this.name, lastOkAt: 1, lastError: this.fail, lagS: this.lagS }; }
}

test('FallbackTradeSource: uses the indexer, falls back on error or lag, and switches back on recovery', async () => {
  const a = new Fake('idx'), b = new Fake('third'), f = new FallbackTradeSource(a, b, { maxLagS: 30 });
  await f.pollCycle([tok]); assert.equal(f.status().serving, 'idx'); assert.equal(b.calls, 0);
  a.fail = 'the indexer is unreachable: boom'; await f.pollCycle([tok]); assert.equal(f.status().serving, 'third'); assert.match(f.status().lastError!, /unreachable/); assert.equal(b.calls, 1);
  a.fail = null; a.lagS = 120; await f.pollCycle([tok]); assert.equal(f.status().serving, 'third'); assert.match(f.status().lastError!, /120 s behind/);
  a.lagS = 5; await f.pollCycle([tok]); assert.equal(f.status().serving, 'idx'); assert.equal(f.status().lastError, null);
});

test('FallbackTradeSource: queries and counters come from whichever source is serving', async () => {
  const a = new Fake('idx'), b = new Fake('third'), f = new FallbackTradeSource(a, b);
  a.loaded = 3; b.loaded = 7; await f.pollCycle([tok]); assert.equal(f.loaded, 3);
  a.fail = 'down'; await f.pollCycle([tok]); assert.equal(f.loaded, 7);
});

test('makeTradeSource: no INDEX_URL gives the plain third-party feed; INDEX_URL gives indexer + fallback', () => {
  const deps: any = { rpc: {} };
  assert.ok(makeTradeSource(deps, {}, {}) instanceof TradeFeed);
  assert.ok(makeTradeSource(deps, {}, { INDEX_URL: '  ' }) instanceof TradeFeed);
  const m = makeTradeSource(deps, {}, { INDEX_URL: 'http://127.0.0.1:9' }); assert.ok(m instanceof FallbackTradeSource);
});

test('end to end: dead indexer URL -> falls back to the third-party feed, the error text does not leak the URL query', async () => {
  const third = new Fake('third'), f = new FallbackTradeSource(new HttpTradeSource('http://127.0.0.1:9', { timeoutMs: 500 }), third);
  const r = await f.pollCycle([tok]); assert.equal(r.polled, 1); assert.equal(f.status().serving, 'third'); assert.match(f.status().lastError!, /unreachable/);
  assert.ok(!f.status().lastError!.includes('pools='));
});

test('TradeFeed reports a status of its own', async () => {
  const t = new TradeFeed({ rpc: {} } as any); assert.equal(t.status().serving, t.name); assert.equal(t.status().lastOkAt, 0);
});

import { Paced } from '../src/rpc.ts';
test('Paced: concurrent callers are scheduled gapMs apart (deterministic clock), results and errors pass through', async () => {
  const delays: number[] = []; const inner = { async call(m: string) { if (m === 'bad') throw new Error('boom'); return m; } };
  const p = new Paced(inner as any, 40, () => 1000, (fn, ms) => { delays.push(ms); fn(); });
  const res = await Promise.all([p.call('a'), p.call('b'), p.call('c'), p.call('d')]);
  assert.deepEqual(res, ['a', 'b', 'c', 'd']); assert.deepEqual(delays, [40, 80, 120], 'the first call starts at once, the rest are queued 40 ms apart');
  await assert.rejects(p.call('bad'), /boom/);
});
