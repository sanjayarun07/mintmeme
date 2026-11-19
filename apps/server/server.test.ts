/** Cluster behaviour of the production server, with real nodes on real ports sharing the local Redis (skipped when there is none). Practice chain, fake funds.
 *  Each test uses its own Redis namespace and deletes it afterwards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { MemeClient, PRACTICE_TOKEN as T } from '../../packages/sdk/src/index.ts';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { UserLease, ownerOf } from './lease.ts';
import { parseKeyFile } from './main.ts';

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const ns = () => `memedesk-cluster-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
const wipe = (n: string) => { const c = new SyncRedis(); try { const ks: string[] = c.cmd('KEYS', `${n}:*`) ?? []; for (const k of ks) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const KA = 'alice-secret-key-0123456789abcdef', KB = 'bob---secret-key-0123456789abcdef';
const hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(KA), userId: 'alice' }, { keyHash: hash(KB), userId: 'bob' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function node(n: string, o: { ttl?: number; maxUsers?: number; sweepMs?: number } = {}) {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, makeAccount: practiceAccount, leaseTtlMs: o.ttl ?? 3000, maxUsers: o.maxUsers, sweepMs: o.sweepMs ?? 60_000, requireAof: false, log: () => {} });
  await nd.listen(port); return { nd, url, client: (k: string) => new MemeClient({ baseUrl: url, apiKey: k }) };
}

test('key file: hashes only, plain keys and bad lines are refused with the line number', () => {
  assert.deepEqual(parseKeyFile(`# comment\n${hash(KA)}:alice\n${hash(KB)}:bob:read\n`), [{ keyHash: hash(KA), userId: 'alice', scope: 'trade' }, { keyHash: hash(KB), userId: 'bob', scope: 'read' }]);
  assert.throws(() => parseKeyFile(`${KA}:alice`), /line 1/); assert.throws(() => parseKeyFile('\n\n'), /no keys/);
});

test('a lease is single-owner, names its node, and a node that lost it fails closed on its next write', { skip }, () => {
  const n = ns(), r1 = new SyncRedis(), r2 = new SyncRedis();
  try {
    const a = new UserLease(r1, n, 'alice', 'http://a:1', 5000), b = new UserLease(r2, n, 'alice', 'http://b:1', 5000);
    assert.ok(a.acquire()); assert.equal(b.acquire(), false); assert.equal(ownerOf(r1, n, 'alice'), 'http://a:1');
    a.backend('orders').write('v1'); assert.equal(b.backend('orders').read(), 'v1');
    r1.cmd('DEL', a.key); assert.ok(b.acquire(), 'after expiry another node can take it');   // what a missed renewal looks like
    assert.throws(() => a.backend('orders').write('stale'), /lease for alice lost/); assert.equal(b.backend('orders').read(), 'v1', 'the stale node wrote nothing');
    assert.equal(a.renew(), false); b.release(); assert.equal(ownerOf(r1, n, 'alice'), undefined);
  } finally { r1.close(); r2.close(); wipe(n); }
});

test('a node refuses a Redis without AOF unless told to accept volatile state', { skip }, async () => {
  const c = new SyncRedis(); let aof = 'unknown'; try { aof = c.cmd('CONFIG', 'GET', 'appendonly')?.[1]; } finally { c.close(); }
  if (aof === 'yes') return;   // this machine's Redis is durable: nothing to refuse
  await assert.rejects(createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns(), publicUrl: 'http://127.0.0.1:1', keys, makeAccount: practiceAccount, log: () => {} }), /appendonly=no/);
});

test('cluster: any node serves any user (one owner, others forward), orders survive a crashed node, and a drained node hands over at once', { skip, timeout: 60_000 }, async () => {
  const n = ns(); const A = await node(n), B = await node(n); let C: Awaited<ReturnType<typeof node>> | undefined;
  try {
    // alice's first request lands on A: A claims her. The same key on B is forwarded to A.
    assert.equal((await A.client(KA).overview()).userId, 'alice'); assert.ok(A.nd.owned.has('alice'));
    const viaB = await B.client(KA).overview(); assert.equal(viaB.userId, 'alice'); assert.equal(B.nd.owned.has('alice'), false); assert.ok(B.nd.metrics.proxied >= 1, 'B forwarded to the owner');
    // bob lands on B. Each node owns one user.
    await B.client(KB).overview(); assert.ok(B.nd.owned.has('bob')); assert.equal(ownerOf(new SyncRedis(), n, 'bob'), B.url);
    // alice places an order THROUGH B (forwarded, written by A into Redis)
    await B.client(KA).buy({ walletId: 'w1', token: T, amount: 20_000n, key: 'seed' });
    const o = await B.client(KA).limitSell({ id: 'keep', walletId: 'w1', token: T, amount: 1_000n, priceE18: (10n ** 30n).toString() });
    assert.equal(o.status, 'active');
    // unknown key: the API's own 401, on any node; health, readiness and metrics are open
    await assert.rejects(new MemeClient({ baseUrl: B.url, apiKey: 'not-a-real-key-0123456789' }).overview(), (e: any) => e.status === 401);
    assert.equal((await fetch(B.url + '/healthz')).status, 200); assert.equal((await fetch(B.url + '/readyz')).status, 200);
    assert.match(await (await fetch(A.url + '/metrics')).text(), /memedesk_users_owned 1/);
    // A crashes (no release): while its lease lives, B cannot reach the owner and says so; after the TTL B's sweep takes alice and restores her order from Redis
    await A.nd.crash();
    await assert.rejects(B.client(KA).overview(), (e: any) => e.status === 503 && /owner_unreachable|did not answer/.test(e.code + e.message));
    let took = false; for (let i = 0; i < 40 && !took; i++) { await sleep(250); await B.nd.sweep(); took = B.nd.owned.has('alice'); }
    assert.ok(took, 'B took alice over after the lease expired');
    const back = await B.client(KA).order('alice.keep'); assert.equal(back.status, 'active', 'the order came back from Redis on the new owner');
    // B drains (graceful): leases are released at once, so a new node C claims both users immediately, without waiting for a TTL
    await B.nd.drain(); assert.equal(ownerOf(new SyncRedis(), n, 'alice'), undefined);
    C = await node(n); assert.equal((await C.client(KA).order('alice.keep')).status, 'active'); assert.equal((await C.client(KB).overview()).userId, 'bob');
  } finally { await C?.nd.drain().catch(() => {}); await B.nd.drain().catch(() => {}); wipe(n); }
});

test('the sweep claims users with no traffic (so their orders keep being watched) and stops at the per-node cap', { skip, timeout: 30_000 }, async () => {
  const n = ns(); const A = await node(n, { maxUsers: 1 }), B = await node(n, { maxUsers: 5 });
  try {
    await A.nd.sweep(); assert.equal(A.nd.owned.size, 1, 'A is capped at one user');
    await B.nd.sweep(); assert.equal(B.nd.owned.size, 1, 'B takes the user A had no room for'); assert.equal(A.nd.owned.size + B.nd.owned.size, 2);
  } finally { await A.nd.drain().catch(() => {}); await B.nd.drain().catch(() => {}); wipe(n); }
});

test('a full node turns away a user nobody owns with 503 no_capacity and counts it', { skip, timeout: 30_000 }, async () => {
  const n = ns(); const A = await node(n, { maxUsers: 1 });
  try {
    await A.client(KA).overview(); assert.ok(A.nd.owned.has('alice'));
    await assert.rejects(A.client(KB).overview(), (e: any) => e.status === 503 && e.code === 'no_capacity');
    assert.match(await (await fetch(A.url + '/metrics')).text(), /memedesk_capacity_refusals_total 1/);
  } finally { await A.nd.drain().catch(() => {}); wipe(n); }
});

test('the /solana sample page is linked to a local terminal: page and /api/sol calls are forwarded, same-origin posts pass its CSRF check, foreign origins do not', { skip, timeout: 30_000 }, async () => {
  const { default: http } = await import('node:http'); const { isLoopback, isSolanaSamplePath } = await import('./node.ts');
  const seen: { path: string; host?: string; origin?: string; method?: string }[] = [];
  const term = http.createServer((req, res) => { seen.push({ path: req.url!, host: req.headers.host, origin: req.headers.origin as string | undefined, method: req.method });
    if (req.method === 'POST') { const o = req.headers.origin; const ok = !o || new URL(o).host === req.headers.host; res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok })); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>MINT Solana</title>'); });
  await new Promise<void>(ok => term.listen(0, '127.0.0.1', () => ok())); const termUrl = `http://127.0.0.1:${(term.address() as any).port}`;
  const n = ns(); const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, makeAccount: practiceAccount, sweepMs: 60_000, requireAof: false, log: () => {}, solanaSampleUrl: termUrl }); await nd.listen(port);
  const bare = await node(n);   // a node without the link
  try {
    const page = await fetch(url + '/solana'); assert.equal(page.status, 200); assert.match(await page.text(), /MINT Solana/);
    assert.equal(seen.at(-1)!.host, new URL(termUrl).host, 'the terminal sees its own Host');
    const same = await fetch(url + '/api/sol/status', { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: '{}' });
    assert.equal(same.status, 200, 'a same-origin post from the page passes the terminal CSRF check'); assert.equal(seen.at(-1)!.origin, termUrl);
    const evil = await fetch(url + '/api/sol/status', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403, 'a foreign origin is passed through unchanged and refused'); assert.equal(seen.at(-1)!.origin, 'https://evil.example');
    assert.equal((await fetch(bare.url + '/solana')).status, 404, 'no link configured: nothing is served');
    const root = await fetch(url + '/', { redirect: 'manual' }); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/app', 'with the app linked, / opens the trading app');
    assert.match(await (await fetch(url + '/console')).text(), /MINT API console/, 'the console stays at /console');
    assert.match(await (await fetch(bare.url + '/')).text(), /MINT API console/, 'without the app, / is still the console');
    // through a proxy or tunnel on this machine (it connects from 127.0.0.1 but adds a forwarding header): the trading app and its read-only data only
    const n0 = seen.length, via = (p: string, h: Record<string, string>, method = 'GET') => fetch(url + p, { method, headers: { 'content-type': 'application/json', ...h }, body: method === 'POST' ? '{}' : undefined });
    for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }]) {
      for (const p of ['/solana', '/views3.js', '/api/sol/kill', '/api/sol/trade/confirm', '/api/sol/tradingkey/use', '/api/sol/wallet/status', '/api/sol/privy/use']) assert.equal((await via(p, h, p.startsWith('/api/') ? 'POST' : 'GET')).status, 404, `${p} is refused through a proxy (${Object.keys(h)[0]})`);
      for (const p of ['/app', '/app.js', '/rfqdesk', '/api/sol/config']) assert.equal((await via(p, h)).status, 200, `${p} is served through a proxy`);
      assert.equal((await via('/api/sol/market/list', h, 'POST')).status, 200, 'the app\'s market data is served through a proxy');
    }
    assert.ok(!seen.slice(n0).some(s => /kill|trade|tradingkey|wallet|privy\/use|solana|views3/.test(s.path)), 'refused calls never reached the terminal');
    assert.equal((await via('/api/sol/kill', {}, 'POST')).status, 200, 'directly on this machine, without a forwarding header, the session routes still work');
    assert.ok(isSolanaSamplePath('/api/sol/trade/confirm') && isSolanaSamplePath('/views4.js') && !isSolanaSamplePath('/v1/orders'));
    assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1') && !isLoopback('10.0.3.7') && !isLoopback(undefined), 'only this machine is served');
  } finally { await nd.drain().catch(() => {}); await bare.nd.drain().catch(() => {}); term.close(); wipe(n); }
});

test('the API console is served by every node, and every API response names the node that ran it (the owner, also when forwarded)', { skip, timeout: 30_000 }, async () => {
  const n = ns(); const A = await node(n), B = await node(n);
  try {
    const page = await fetch(B.url + '/console'); assert.equal(page.status, 200); assert.match(await page.text(), /MINT API console/); assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const own = await fetch(A.url + '/v1/overview', { headers: { authorization: 'Bearer ' + KA } }); assert.equal(own.headers.get('x-memedesk-node'), A.url, 'served by the owner');
    const fwd = await fetch(B.url + '/v1/overview', { headers: { authorization: 'Bearer ' + KA } }); assert.equal(fwd.status, 200); assert.equal(fwd.headers.get('x-memedesk-node'), A.url, 'forwarded: still names the owner');
  } finally { await A.nd.drain().catch(() => {}); await B.nd.drain().catch(() => {}); wipe(n); }
});

test('review fixes: a request target that is not a path is refused (no forwarding to a host the client picks), and the /solana link needs a loopback Host too', { skip, timeout: 30_000 }, async () => {
  const { default: http } = await import('node:http'); const { isLoopbackHost } = await import('./node.ts');
  const n = ns(); const A = await node(n), B = await node(n);
  try {
    await A.client(KA).overview();   // A owns alice, so B would forward her requests
    const raw = (target: string) => new Promise<number>(ok => { const u = new URL(B.url); const rq = http.request({ host: u.hostname, port: u.port, path: target, headers: { authorization: 'Bearer ' + KA } }, r => { r.resume(); ok(r.statusCode!); }); rq.on('error', () => ok(0)); rq.end(); });
    assert.equal(await raw('//169.254.169.254/latest/meta-data'), 400); assert.equal(await raw('http://169.254.169.254/latest/meta-data'), 400); assert.equal(await raw('/v1/overview'), 200);
    assert.ok(isLoopbackHost('localhost:3500') && isLoopbackHost('127.0.0.1') && isLoopbackHost('[::1]:3500') && !isLoopbackHost('evil.example:3500') && !isLoopbackHost(undefined));
  } finally { await A.nd.drain().catch(() => {}); await B.nd.drain().catch(() => {}); wipe(n); }
});

test('practice accounts keep trading after a failover: the rebuilt simulated chain continues from the restored nonces', { skip, timeout: 30_000 }, async () => {
  const n = ns(); const A = await node(n); let B: Awaited<ReturnType<typeof node>> | undefined;
  try {
    assert.equal((await A.client(KA).buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'before' })).state, 'finalized');
    await A.nd.drain(); B = await node(n);
    const after = await B.client(KA).buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'after' });
    assert.equal(after.state, 'finalized', `the first trade on the new owner must not hang (state ${after.state})`);
  } finally { await B?.nd.drain().catch(() => {}); await A.nd.drain().catch(() => {}); wipe(n); }
});
