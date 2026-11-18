/** Trade history, audit log and the status page on real nodes with Redis and Postgres. Needs PG_TEST_URL (a throwaway database; the tables are created in it),
 *  e.g. postgres://memedesk:memedesk-test-pw@127.0.0.1:55432/memedesk; skipped without it. The Postgres-outage step also needs PG_TEST_DOCKER (the container name). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SyncRedis, PgClient } from '../../packages/core/src/index.ts';
import { MemeClient, PRACTICE_TOKEN as T } from '../../packages/sdk/src/index.ts';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { auditBody } from './history.ts';

const PG = process.env.PG_TEST_URL, DOCKER = process.env.PG_TEST_DOCKER;
let redis = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); redis = c.cmd('PING') === 'PONG'; c.close(); } catch { redis = false; }
const skip = !redis ? 'no local Redis' : !PG ? 'set PG_TEST_URL to a throwaway Postgres database' : false;
const wipe = (n: string) => { const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${n}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const USER = 'records-user-key-0123456789abcdef', APP = 'records-app-key-0123456789abcdef', hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(USER), userId: 'dora' }, { keyHash: hash(APP), userId: 'shop', scope: 'app' as const }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => Promise<boolean>, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) if (await f()) return true; return false; };

test('audit bodies never keep secrets or signatures', () => {
  assert.deepEqual(auditBody({ url: 'https://x', secret: 'whsec_1', signature: 'abc', mint: 'M', sol: '0.01', __session: 's', nested: { a: 1 } }), { url: 'https://x', secret: '[removed]', signature: '[removed]', mint: 'M', sol: '0.01', nested: { a: 1 } });
  assert.equal(auditBody(undefined), undefined);
});

test('trade history and audit log in Postgres, app-wide records, the status page, and trading through a Postgres outage', { skip }, async () => {
  const n = `memedesk-records-test:${Date.now()}`, pg = new PgClient(PG!);
  for (const t of ['trades', 'trade_states', 'audit_log']) await pg.query(`drop table if exists ${t}`);
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, makeAccount: practiceAccount, leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {}, pgUrl: PG, webhooks: { allowHttp: true },
      statusChecks: [{ name: 'Example dependency', run: async () => {} }] });
    await nd.listen(port); return { nd, url }; };
  const a = await mk(), b = await mk(); const live = [a, b];
  try {
    const dora = new MemeClient({ baseUrl: a.url, apiKey: USER }), shop = new MemeClient({ baseUrl: b.url, apiKey: APP });
    const t1 = await dora.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'r1' }); assert.equal(t1.state, 'finalized');
    await dora.limitBuy({ id: 'o1', walletId: 'w1', token: T, amount: 1_000n, priceE18: '1' });
    await shop.forUser('u1').buy({ walletId: 'w1', token: T, amount: 5_000n, key: 'r1' });
    await shop.setAppWebhook('http://127.0.0.1:9/hook', 'whsec_should_never_be_stored_1234');
    // the stored trade: final state, its fill, and every state it went through
    assert.ok(await until(async () => (await dora.recordTrades()).length === 1), 'dora\'s trade is stored');
    const [row] = await dora.recordTrades();
    assert.equal(row.key, 'dora.r1'); assert.equal(row.state, 'finalized'); assert.equal(row.amount_in, '10000'); assert.ok(row.fill && row.fill.received);
    const states = (await pg.query('select state from trade_states where key = $1 order by id', ['dora.r1'])).rows.map(r => r.state);
    assert.equal(states.at(-1), 'finalized', 'the states it was seen in are kept (a practice trade finishes within one call, so only the final one here)');
    // the audit log: what changed, by whom, with secrets removed; reads are not logged
    assert.ok(await until(async () => (await dora.auditLog()).length >= 2));
    const audit = await dora.auditLog();
    assert.deepEqual(audit.map((x: any) => `${x.method} ${x.path} ${x.status}`).sort(), ['POST /v1/orders/limit-buy 200', 'POST /v1/trades/buy 200']);
    assert.equal(audit.find((x: any) => x.path === '/v1/trades/buy').body.token, T); assert.match(audit[0].key_id, /^[0-9a-f]{12}$/);
    assert.ok(await until(async () => (await shop.appAuditLog()).some((x: any) => x.path === '/v1/app/webhook')));
    const hookAudit = (await shop.appAuditLog()).find((x: any) => x.path === '/v1/app/webhook');
    assert.equal(hookAudit.body.secret, '[removed]', 'the webhook secret is never stored'); assert.equal(hookAudit.user_id, 'shop');
    const dump = JSON.stringify((await pg.query('select * from audit_log')).rows); assert.ok(!dump.includes('whsec_should_never_be_stored'), 'not anywhere in the table');
    // app-wide records: every end user of the app, and nobody else
    assert.ok(await until(async () => (await shop.appRecordTrades()).length > 0), 'written by the node that runs u1');
    const appTrades = await shop.appRecordTrades(); assert.deepEqual(appTrades.map((x: any) => x.key), ['shop:u1.r1']);
    await assert.rejects(dora.appRecordTrades(), (e: any) => e.code === 'not_an_app_key');
    // the status page: both nodes, components, trades in the last hour; no node address or user data in it
    const st = await (await fetch(a.url + '/status.json')).json() as any;
    assert.equal(st.status, 'operational'); assert.equal(st.nodes.length, 2); assert.deepEqual(st.components.map((c: any) => c.name), ['Redis', 'Execution nodes', 'Trade history (Postgres)', 'Example dependency']);
    assert.ok(st.trades.lastHour.finalized >= 2); assert.equal(st.trades.successPct, 100);
    const html = await (await fetch(b.url + '/status')).text(); assert.match(html, /All systems operational/); assert.ok(!html.includes('127.0.0.1') && !html.includes('dora'), 'no addresses or users on the page');
    await b.nd.drain(); live.splice(live.indexOf(b), 1); await sleep(11_000);   // the status cache lives 10 s
    const st2 = await (await fetch(a.url + '/status.json')).json() as any; assert.equal(st2.nodes.length, 1, 'a drained node leaves the status page');
    // Postgres down: trading continues, records wait in the buffer and are written when it is back
    if (DOCKER) {
      execFileSync('docker', ['pause', DOCKER]);
      try { const t2 = await dora.buy({ walletId: 'w1', token: T, amount: 2_000n, key: 'r2' }); assert.equal(t2.state, 'finalized', 'a trade does not wait for Postgres'); }
      finally { execFileSync('docker', ['unpause', DOCKER]); }
      assert.ok(await until(async () => (await dora.recordTrades()).some((x: any) => x.key === 'dora.r2'), 40_000), 'written after Postgres came back');
    }
  } finally { for (const x of live) await x.nd.drain().catch(() => {}); await pg.close(); wipe(n); }
});
