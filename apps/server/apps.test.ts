/** App keys and webhooks on real nodes sharing the local Redis (skipped without one). Practice accounts, fake funds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { MemeClient, PRACTICE_TOKEN as T, verifyWebhook } from '../../packages/sdk/src/index.ts';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { checkWebhookUrl, signWebhook } from './webhooks.ts';
import { parseKeyFile } from './main.ts';

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const wipe = (n: string) => { const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${n}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const APP = 'shop-app-key-0123456789abcdef', USER = 'plain-user-key-0123456789abcdef', hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(APP), userId: 'shop', scope: 'app' as const }, { keyHash: hash(USER), userId: 'carol' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('webhook urls: https to public hosts only; signatures verify and expire', async () => {
  assert.equal(checkWebhookUrl('https://hooks.example.com/x'), 'https://hooks.example.com/x');
  for (const bad of ['http://hooks.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://172.20.0.1/x', 'https://[::1]/x', 'https://u:p@example.com/x', 'not a url'])
    assert.throws(() => checkWebhookUrl(bad), /https|public host|credentials|full URL/, bad);
  assert.equal(checkWebhookUrl('http://127.0.0.1:9/x', true), 'http://127.0.0.1:9/x', 'allowed only when the server allows http for local tests');
  const body = '{"a":1}', t = 1_800_000_000, h = `t=${t},v1=${signWebhook('whsec_test_secret_123', t, body)}`;
  assert.equal(await verifyWebhook('whsec_test_secret_123', body, h, 300, t + 10), true);
  assert.equal(await verifyWebhook('whsec_test_secret_123', body + ' ', h, 300, t + 10), false, 'a changed body fails');
  assert.equal(await verifyWebhook('other_secret_000000000', body, h, 300, t + 10), false, 'another secret fails');
  assert.equal(await verifyWebhook('whsec_test_secret_123', body, h, 300, t + 301), false, 'too old');
  assert.deepEqual(parseKeyFile(`${hash(APP)}:shop:app\n`), [{ keyHash: hash(APP), userId: 'shop', scope: 'app' }]);
});

test('app keys: one key acts for many end users, each a separate account; app routes; per-app user cap; signed webhooks with retries', { skip }, async () => {
  const n = `memedesk-apps-test:${Date.now()}`, got: { id: string; sig: string; body: string }[] = []; let failNext = 1;
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { got.push({ id: String(req.headers['x-memedesk-event-id']), sig: String(req.headers['x-memedesk-signature']), body: b }); if (failNext > 0) { failNext--; res.writeHead(500); return res.end(); } res.writeHead(200); res.end('ok'); }); });
  await new Promise<void>(ok => recv.listen(0, '127.0.0.1', () => ok())); const hookUrl = `http://127.0.0.1:${(recv.address() as any).port}/hook`;
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, makeAccount: practiceAccount, leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {}, maxUsersPerApp: 2, webhooks: { allowHttp: true, retryMs: [50, 50] } });
    await nd.listen(port); return { nd, url }; };
  const a = await mk(), b = await mk();
  try {
    const app = new MemeClient({ baseUrl: a.url, apiKey: APP }), u1 = app.forUser('u1'), u2 = new MemeClient({ baseUrl: b.url, apiKey: APP, userId: 'u2' });
    await assert.rejects(app.overview(), (e: any) => e.code === 'missing_user' && e.status === 400, 'an app key must name its end user');
    await assert.rejects(app.forUser('bad:user').overview(), (e: any) => e.code === 'missing_user', 'end user ids cannot contain a colon');
    // a webhook first, so the trades below are delivered
    const set = await app.setAppWebhook(hookUrl); assert.equal(set.url, hookUrl); assert.match(set.secret, /^whsec_/);
    assert.deepEqual(await app.appWebhook(), { url: hookUrl, configured: true }, 'the secret is not shown again');
    await assert.rejects(new MemeClient({ baseUrl: a.url, apiKey: USER }).appWebhook(), (e: any) => e.code === 'not_an_app_key');
    // two end users, two separate accounts (u2 through the other node)
    const t1 = await u1.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'b1' }); assert.equal(t1.key, 'shop:u1.b1'); assert.equal(t1.state, 'finalized');
    assert.equal((await u2.trades()).length, 0, 'u2 does not see u1\'s trades');
    await assert.rejects(u2.trade('shop:u1.b1'), (e: any) => e.status === 404, 'nor can it read them by id');
    const t2 = await u2.buy({ walletId: 'w1', token: T, amount: 5_000n, key: 'b1' }); assert.equal(t2.key, 'shop:u2.b1', 'same key, different user: a different trade');
    assert.deepEqual((await app.appUsers()).users, ['shop:u1', 'shop:u2']);
    await assert.rejects(app.forUser('u3').overview(), (e: any) => e.code === 'app_user_limit' && e.status === 403, 'maxUsersPerApp');
    // webhooks: every trade event, signed; the first delivery got a 500 and was retried with the same event id
    for (let i = 0; i < 60 && !got.some(g => JSON.parse(g.body).data?.state === 'finalized' && JSON.parse(g.body).userId === 'u2'); i++) await sleep(50);
    const evs = got.map(g => ({ ...g, j: JSON.parse(g.body) }));
    assert.ok(evs.some(e => e.j.type === 'trade' && e.j.userId === 'u1' && e.j.appId === 'shop' && e.j.data.key === 'shop:u1.b1'), 'u1 trade events');
    assert.ok(evs.some(e => e.j.type === 'trade' && e.j.userId === 'u2' && e.j.data.state === 'finalized'), 'u2 events come from the node that runs u2');
    for (const e of evs) assert.equal(await verifyWebhook(set.secret, e.body, e.sig), true, 'every delivery is signed with the app secret');
    for (let i = 0; i < 40 && got.filter(g => g.id === got[0].id).length < 2; i++) await sleep(25);   // the retry follows the 500 after 50 ms
    assert.ok(got.filter(g => g.id === got[0].id).length >= 2, 'the first delivery got a 500 and was retried later with the same event id: ' + JSON.stringify(got.map(g => [g.id.slice(0, 6), JSON.parse(g.body).type, JSON.parse(g.body).userId, JSON.parse(g.body).data?.state])));
    // a plain user key is unchanged and sends no webhooks
    const before = got.length; await new MemeClient({ baseUrl: a.url, apiKey: USER }).buy({ walletId: 'w1', token: T, amount: 1_000n }); await sleep(200); assert.equal(got.length, before);
    const tst = await app.testAppWebhook(); assert.equal(tst.delivered, true);
    await app.deleteAppWebhook(); assert.equal((await app.appWebhook()).configured, false);
  } finally { await a.nd.drain().catch(() => {}); await b.nd.drain().catch(() => {}); recv.close(); wipe(n); }
});
