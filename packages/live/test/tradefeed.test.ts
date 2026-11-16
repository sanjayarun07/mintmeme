import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeFeed } from '../src/tradefeed.ts';
import type { FeedToken } from '../src/tradefeed.ts';

const row = (tx: string, kind: string, from: string, usd: number, ts: string) => ({ attributes: { kind, tx_from_address: from, volume_in_usd: String(usd), block_timestamp: ts, tx_hash: tx } });
const tok = (n: number): FeedToken => ({ id: `ethereum:0x${n}`, sym: 'T' + n, chain: 'ethereum', contract: '0x' + String(n).repeat(40).slice(0, 40), pool: 'pool' + n, pad: null, chg: 1.5 });
function mk(script: Record<string, any[][] | number>) {
  const calls: string[] = []; const idx: Record<string, number> = {};
  const fetchFn = (async (u: string) => { const pool = u.split('/pools/')[1].split('/')[0]; calls.push(pool); const s = script[pool];
    if (typeof s === 'number') return { ok: false, status: s, json: async () => ({}) };
    const i = idx[pool] = (idx[pool] ?? -1) + 1; const rows = s[Math.min(i, s.length - 1)]; return { ok: true, status: 200, json: async () => ({ data: rows }) }; }) as any;
  return { calls, feed: (o?: any) => new TradeFeed({ rpc: {} as any, fetchFn, sleep: async () => {}, now: () => 0 }, o) };
}

test('the first poll of a pool is a baseline (nothing fresh); later polls emit only unseen trades, once each', async () => {
  const a = row('0xa', 'buy', '0xw1', 100, '2026-11-14T10:00:01Z'), b = row('0xb', 'sell', '0xw2', 900, '2026-11-14T10:00:05Z'), c = row('0xc', 'buy', '0xw3', 40, '2026-11-14T10:00:09Z');
  const m = mk({ pool1: [[b, a], [c, b, a], [c, b, a]] }); const f = m.feed();
  assert.deepEqual(await f.pollPool(tok(1)), [], 'baseline is not announced');
  assert.equal(f.recent.length, 2); assert.ok(f.recent.every(t => t.fresh === false), 'baseline kept for display only');
  const second = await f.pollPool(tok(1)); assert.deepEqual(second.map(t => t.tx), ['0xc']); assert.equal(second[0].fresh, true); assert.equal(second[0].chg, 1.5);
  assert.deepEqual(await f.pollPool(tok(1)), [], 'the same trades are never emitted twice');
});
test('a cycle polls at most maxPoolsPerCycle pools and rotates through the list', async () => {
  const s: any = {}; for (let i = 1; i <= 5; i++) s['pool' + i] = [[row('0x' + i, 'buy', '0xw', 10, '2026-11-14T10:00:0' + i + 'Z')]];
  const m = mk(s); const f = m.feed({ maxPoolsPerCycle: 2 }); const toks = [1, 2, 3, 4, 5].map(tok);
  await f.pollCycle(toks); await f.pollCycle(toks); await f.pollCycle(toks);
  assert.deepEqual(m.calls, ['pool1', 'pool2', 'pool3', 'pool4', 'pool5', 'pool1'], 'two pools per cycle, wrapping around'); assert.equal(f.loaded, 5);
});
test('errors: a 404 is recorded per pool and the cycle goes on; a 429 ends the cycle early and says so', async () => {
  const m = mk({ pool1: 404, pool2: [[row('0x2', 'buy', '0xw', 10, '2026-11-14T10:00:00Z')]], pool3: 429, pool4: [[]] }); const f = m.feed({ maxPoolsPerCycle: 4 });
  const r = await f.pollCycle([1, 2, 3, 4].map(tok));
  assert.equal(r.polled, 1); assert.equal(r.errors, 2); assert.match(f.errors.get('pool1')!, /no trade feed/); assert.match(f.errors.get('pool3')!, /rate limited/); assert.ok(!m.calls.includes('pool4'), 'stopped after the rate limit');
});
test('query filters by size and chain, newest first; recent is bounded', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row('0x' + i, 'buy', '0xw' + i, i * 100, '2026-11-14T10:' + String(i).padStart(2, '0') + ':00Z'));
  const m = mk({ pool1: [rows] }); const f = m.feed({ recentMax: 10 }); await f.pollPool(tok(1));
  assert.equal(f.recent.length, 10); const q = f.query(2500); assert.ok(q.every(t => t.usd >= 2500)); assert.deepEqual(q.map(t => t.t), [...q.map(t => t.t)].sort().reverse());
  assert.equal(f.query(0, ['solana']).length, 0);
});
