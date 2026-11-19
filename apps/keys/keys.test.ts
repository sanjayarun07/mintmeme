/** The key dashboard: the keys file it writes (the servers' format, hashes only), its HTTP guards, and the servers picking up a new or revoked key without a restart. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { keyStore } from './store.ts';
import { createDashboard } from './server.ts';
import { parseKeyFile, watchKeyFile } from '../server/keyfile.ts';
import { createApi } from '../api/server.ts';
import { createSimTrader } from '../../packages/sdk/src/sim.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'memedesk-keys-'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('store: create writes a hash line the servers parse, never the secret; revoke removes it; other lines are kept', async () => {
  const f = join(dir(), 'keys.txt'), old = sha('made-with-keys-ts-0123456789');
  writeFileSync(f, `# operator note\n${old}:bob:read`);
  const s = keyStore(f, { now: () => new Date('2026-11-19T10:00:00Z') });
  const a = await s.create({ userId: 'alice', scope: 'trade', label: 'Claude Desktop' });
  assert.match(a.secret, /^mk_[A-Za-z0-9_-]{43}$/); assert.equal(a.key.hash, sha(a.secret));
  const text = readFileSync(f, 'utf8'); assert.ok(!text.includes(a.secret)); assert.ok(!readFileSync(f + '.meta.json', 'utf8').includes(a.secret));
  assert.equal(text, `# operator note\n${old}:bob:read\n${a.key.hash}:alice:trade\n`);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(parseKeyFile(text).map(k => [k.userId, k.scope]), [['bob', 'read'], ['alice', 'trade']]);
  assert.deepEqual(s.list(), [{ hash: old, userId: 'bob', scope: 'read', label: null, createdAt: null }, { hash: a.key.hash, userId: 'alice', scope: 'trade', label: 'Claude Desktop', createdAt: '2026-11-19T10:00:00.000Z' }]);
  const b = await s.create({ userId: 'shop', scope: 'app' }); assert.notEqual(b.secret, a.secret);
  await s.revoke(a.key.hash);
  assert.deepEqual(s.list().map(k => k.userId), ['bob', 'shop']); assert.ok(readFileSync(f, 'utf8').startsWith('# operator note\n'));
  assert.ok(!(a.key.hash in JSON.parse(readFileSync(f + '.meta.json', 'utf8'))));
  await assert.rejects(s.revoke(a.key.hash), /No such key/);
  for (const bad of [{ userId: 'a:b', scope: 'read' }, { userId: '', scope: 'read' }, { userId: 'a b', scope: 'read' }, { userId: 'a', scope: 'admin' }, { userId: 'a', scope: 'read', label: 'x'.repeat(61) }, { userId: 'a', scope: 'read', label: 'two\nlines' }])
    await assert.rejects(s.create(bad), (e: any) => /^bad_/.test(e.code), JSON.stringify(bad));
  // parallel creates do not lose a line
  await Promise.all(Array.from({ length: 8 }, (_, i) => s.create({ userId: `u${i}`, scope: 'read' })));
  assert.equal(parseKeyFile(readFileSync(f, 'utf8')).length, 10);
  // a new file is created on the first key
  const g = join(dir(), 'new.txt'); await keyStore(g).create({ userId: 'x', scope: 'read' }); assert.ok(existsSync(g));
});

test('dashboard: localhost Host only, same-origin JSON only, admin token, secret only in the create answer', async () => {
  const f = join(dir(), 'keys.txt'), d = createDashboard({ file: f, apiUrl: 'http://127.0.0.1:9', deskUrl: 'http://127.0.0.1:9', adminToken: 'admin-token-0123456789', fetch: (async () => new Response(JSON.stringify({ default: 'base', chains: [{ id: 'base', label: 'Base', kind: 'evm' }] }))) as any });
  const port = await d.listen(), base = `http://127.0.0.1:${port}`, T = { 'x-admin-token': 'admin-token-0123456789' };
  const raw = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; body: string }>((ok, no) => {
    // node's fetch will not send a custom Host header, so use http.request
    import('node:http').then(({ request }) => { const r = request({ host: '127.0.0.1', port, path, method, headers }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => ok({ status: res.statusCode!, body: b })); }); r.on('error', no); if (body) r.write(body); r.end(); });
  });
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.match((await fetch(base + '/')).headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await raw('/', 'GET', { host: `evil.test:${port}` })).status, 421, 'DNS rebinding: a foreign Host is refused');
    assert.equal((await fetch(base + '/api/keys')).status, 401, 'admin token required');
    assert.equal((await fetch(base + '/api/keys', { headers: { 'x-admin-token': 'wrong' } })).status, 401);
    const info = await (await fetch(base + '/api/info', { headers: T })).json(); assert.equal(info.server.default, 'base'); assert.match(info.mcpMain, /apps\/mcp\/main\.ts$/); assert.ok(!JSON.stringify(info).includes('admin-token-0123456789'));
    assert.equal((await fetch(base + '/api/keys', { method: 'POST', headers: { ...T, 'content-type': 'text/plain' }, body: '{"userId":"a","scope":"read"}' })).status, 415, 'a cross-site form post cannot be JSON');
    assert.equal((await fetch(base + '/api/keys', { method: 'POST', headers: { ...T, 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{"userId":"a","scope":"read"}' })).status, 403);
    assert.equal((await fetch(base + '/api/keys', { method: 'POST', headers: { ...T, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"userId":"a","scope":"read"}' })).status, 403);
    const bad = await fetch(base + '/api/keys', { method: 'POST', headers: { ...T, 'content-type': 'application/json' }, body: '{"userId":"a:b","scope":"read"}' }); assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, 'bad_user');
    const made = await (await fetch(base + '/api/keys', { method: 'POST', headers: { ...T, 'content-type': 'application/json', origin: base }, body: '{"userId":"alice","scope":"trade","label":"MCP"}' })).json();
    assert.match(made.secret, /^mk_/);
    const list = await (await fetch(base + '/api/keys', { headers: T })).text(); assert.ok(!list.includes(made.secret)); assert.match(list, /"userId":"alice"/);
    assert.equal((await fetch(base + `/api/keys/${made.key.hash}`, { method: 'DELETE', headers: { ...T, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(base + `/api/keys/${made.key.hash}`, { method: 'DELETE', headers: T })).status, 200, 'the page revokes with a bodiless DELETE');
    assert.equal((await fetch(base + `/api/keys/${made.key.hash}`, { method: 'DELETE', headers: T })).status, 404);
    assert.equal((await fetch(base + '/api/keys', { method: 'PUT', headers: T })).status, 405);
  } finally { await d.close(); }
});

test('a key made in the dashboard works on a running API within the reload interval, and stops working once revoked', async () => {
  const f = join(dir(), 'keys.txt'), s = keyStore(f), first = await s.create({ userId: 'alice', scope: 'read' });
  const sims = new Map<string, ReturnType<typeof createSimTrader>>(), simFor = (u: string) => { let x = sims.get(u); if (!x) sims.set(u, x = createSimTrader({ userId: u })); return x; };
  const api = createApi({ keys: parseKeyFile(readFileSync(f, 'utf8')), traderFor: u => simFor(u).trader }), port = await api.listen();
  const logs: string[] = [], w = watchKeyFile(f, k => api.setKeys(k), m => logs.push(m), 50);
  const get = (k: string) => fetch(`http://127.0.0.1:${port}/v1/overview`, { headers: { authorization: `Bearer ${k}` } }).then(r => r.status);
  try {
    assert.equal(await get(first.secret), 200);
    const second = await s.create({ userId: 'bob', scope: 'trade' }); assert.equal(await get(second.secret), 401, 'not yet re-read');
    await sleep(200); assert.equal(await get(second.secret), 200);
    await s.revoke(first.key.hash); await sleep(200);
    assert.equal(await get(first.secret), 401); assert.equal(await get(second.secret), 200);
    writeFileSync(f, 'not a key line\n'); await sleep(200);
    assert.equal(await get(second.secret), 200, 'a malformed file keeps the keys in use'); assert.ok(logs.some(l => /refused, keeping/.test(l)));
    writeFileSync(f, '# every key revoked\n'); await sleep(200);
    assert.equal(await get(second.secret), 401, 'an empty file revokes everything');
    assert.ok(logs.every(l => !l.includes(second.secret) && !l.includes(first.secret)), 'secrets are never logged');
  } finally { w.stop(); await api.close(); for (const x of sims.values()) x.trader.stop?.(); }
});
