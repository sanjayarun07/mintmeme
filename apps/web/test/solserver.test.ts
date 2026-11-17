/** The Solana test UI server's own guards (apps/web/server.ts). Only routes that do not open the real wallet state are called here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolServer as create } from '../server.ts';
const TMP = mkdtempSync(join(tmpdir(), 'solserver-'));   // never the real .state/sol-mainnet
const createSolServer = () => create({ stateDir: TMP });

test('page and assets are served, removed pages are gone, GET is allowed only for read-only routes, posts need JSON from this origin, and the RPC relay is read-only', async () => {
  const s = createSolServer(); await new Promise<void>(ok => s.listen(0, '127.0.0.1', () => ok())); const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/solana')).status, 200); assert.equal((await fetch(base + '/views4.js')).status, 200);
    const root = await fetch(base + '/', { redirect: 'manual' }); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/solana');
    for (const gone of ['/index.html', '/app.js', '/api/markets']) assert.equal((await fetch(base + gone)).status, 404, gone);
    const cfg = await fetch(base + '/api/sol/config'); assert.equal(cfg.status, 200, 'the page reads its config with a plain GET'); assert.ok('privyAppId' in (await cfg.json() as any));
    assert.equal((await fetch(base + '/api/sol/kill')).status, 405, 'a GET can never act (a cross-site image could otherwise flip the kill switch)');
    assert.equal((await post('/api/sol/kill', { on: true }, { origin: 'https://evil.example' })).status, 403, 'a post from another site is refused');
    assert.equal((await fetch(base + '/api/sol/kill', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 403, 'non-JSON is refused');
    const relay = await post('/api/sol/rpc', { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] }); assert.ok(relay.status === 403 || relay.status === 503, 'the relay never sends');
    assert.equal((await post('/api/sol/nope', {})).status, 404);
  } finally { s.close(); }
});

test('review fixes: an "Origin: null" post is refused (not a crash), and a foreign Host cannot even read the wallet status', async () => {
  const s = createSolServer(); await new Promise<void>(ok => s.listen(0, '127.0.0.1', () => ok())); const port = (s.address() as any).port, base = `http://127.0.0.1:${port}`;
  const { default: http } = await import('node:http');
  const raw = (path: string, method: string, headers: Record<string, string>, body = '') => new Promise<number>(ok => { const rq = http.request({ host: '127.0.0.1', port, path, method, headers }, r => { r.resume(); ok(r.statusCode!); }); rq.on('error', () => ok(0)); rq.end(body); });
  try {
    assert.equal(await raw('/api/sol/kill', 'POST', { 'content-type': 'application/json', origin: 'null' }, '{"on":true}'), 403);
    assert.equal(await raw('/api/sol/kill', 'POST', { 'content-type': 'application/json', origin: 'not a url' }, '{}'), 403);
    assert.equal((await fetch(base + '/solana')).status, 200, 'the server is still up');
    assert.equal(await raw('/api/sol/config', 'GET', { host: 'evil.example:' + port }), 403, 'DNS rebinding: a foreign Host is refused before any route runs');
    assert.equal(await raw('/api/sol/wallet/connect', 'POST', { 'content-type': 'application/json' }, '{"key":"x"}'), 404, 'the pasted-key login is gone');
  } finally { s.close(); }
});
