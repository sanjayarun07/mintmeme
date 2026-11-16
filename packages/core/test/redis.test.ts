import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RespParser, encodeCommand, RespError, SyncRedis, openRedisState } from '../src/index.ts';

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const ns = () => `memedesk-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const open = (n: string, o: Record<string, unknown> = {}) => openRedisState({ namespace: n, requireAof: false, lockTtlMs: 5000, ...o });
const wipe = (n: string) => { const c = new SyncRedis(); try { for (const k of ['lock', 'engine', 'orders', 'copy']) c.cmd('DEL', `${n}:${k}`); } finally { c.close(); } };

test('RESP: encode and incremental parse (split chunks, nested arrays, nulls, errors, unicode)', () => {
  assert.equal(encodeCommand(['SET', 'k', 'héllo']).toString(), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$6\r\nhéllo\r\n');
  const p = new RespParser(), wire = Buffer.from('+OK\r\n:42\r\n$-1\r\n*2\r\n$5\r\nhé\r\n\r\n*1\r\n:7\r\n-ERR boom\r\n$2\r\nhi\r\n');
  const out: unknown[] = []; for (const b of wire) { p.push(Buffer.from([b])); for (let r = p.next(); r; r = p.next()) out.push(r.value); }
  assert.equal(out[0], 'OK'); assert.equal(out[1], 42); assert.equal(out[2], null); assert.deepEqual(out[3], ['hé\r\n', [7]]);
  assert.ok(out[4] instanceof RespError && out[4].message === 'ERR boom'); assert.equal(out[5], 'hi');
});
test('an unreachable Redis fails fast with a clear error (nothing hangs)', () => {
  const c = new SyncRedis('redis://127.0.0.1:1', 800); const t0 = Date.now();
  assert.throws(() => c.cmd('PING'), /redis unreachable|timed out/); assert.ok(Date.now() - t0 < 4000); c.close();
});
test('only redis:// URLs are accepted', () => { assert.throws(() => new SyncRedis('rediss://x'), /only redis:\/\//); });

test('backend round-trips big, unicode and 2 MB values; read of a missing key is undefined', { skip }, () => {
  const n = ns(); const s = open(n); try {
    assert.equal(s.engine.read(), undefined);
    const big = JSON.stringify({ a: '😀é', b: 'x'.repeat(2_000_000), c: { $big: '123456789012345678901234567890' } }); s.engine.write(big); assert.equal(s.engine.read(), big);
    s.orders.write('{"o":1}'); assert.equal(s.engine.read(), big); assert.equal(s.orders.read(), '{"o":1}'); assert.match(s.engine.describe(), /volatile|redis/);
  } finally { s.release(); wipe(n); }
});
test('single writer: a second process cannot open the same state; after release it can', { skip }, () => {
  const n = ns(); const a = open(n); try {
    assert.throws(() => open(n), /locked by another process/); a.release(); const b = open(n); b.engine.write('1'); b.release();
  } finally { wipe(n); }
});
test('fencing: a process that lost its lock fails CLOSED and never overwrites the new owner', { skip }, () => {
  const n = ns(); const a = open(n); a.engine.write('mine');
  const c = new SyncRedis(); c.cmd('DEL', `${n}:lock`); const b = open(n); b.engine.write('theirs'); c.close();
  try { assert.throws(() => a.engine.write('stale'), /lock lost/); assert.throws(() => a.renew(), /lock lost/); assert.equal(b.engine.read(), 'theirs'); }
  finally { a.client.close(); b.release(); wipe(n); }
});
test('lock expires after the TTL, so a crashed owner does not block restarts forever; a live owner that writes keeps it', { skip }, async () => {
  // No fixed sleeps: the server-side TTL is shortened by hand and the test polls, so a loaded machine only makes it slower, never flaky.
  const n = ns(); const a = open(n, { lockTtlMs: 60_000 }); const c = new SyncRedis(); try {
    c.cmd('PEXPIRE', `${n}:lock`, 30_000); assert.ok(Number(c.cmd('PTTL', `${n}:lock`)) <= 30_000);   // simulate a lock that is about to lapse
    a.engine.write('x');                                                                              // a live owner's write extends the TTL back to the full 60s
    assert.ok(Number(c.cmd('PTTL', `${n}:lock`)) > 30_000, 'a write must extend the lock TTL'); a.engine.write('y');
    assert.throws(() => open(n), /locked/);                                                           // still held by the live owner
    a.client.close();                                                                                 // "crash": no release
    c.cmd('PEXPIRE', `${n}:lock`, 50);                                                                // the TTL lapses (50 ms of real server time)
    let b: ReturnType<typeof open> | undefined; const t0 = Date.now();
    while (!b && Date.now() - t0 < 20_000) { try { b = open(n); } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(b, 'the lock must expire and a restart must be able to take it'); assert.equal(b.engine.read(), 'y'); b.release();
  } finally { c.close(); wipe(n); }
});
test('durability check: refuses a server with AOF off unless requireAof:false', { skip }, () => {
  const n = ns(); const probe = open(n); const aof = probe.durability.appendonly; probe.release(); wipe(n);
  if (aof === 'yes') return;                                                                                                          // this server is durable: the refusal path cannot be exercised
  assert.throws(() => openRedisState({ namespace: n }), /durability check failed.*appendonly/); wipe(n);
});
