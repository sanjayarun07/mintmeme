/** Merging single-chain namespaces into one multi-chain namespace (merge.ts, npm run server:merge), and the rule that every node of a namespace serves the same
 *  chains (node.ts sameChainsAsPeers). Needs the local Redis (skipped without one). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { createNode } from './node.ts';
import type { ChainAccounts, MakeAccount } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { planMerge, applyMerge, MERGED_PREFIX } from './merge.ts';
import { defaultChainKey } from './chains.ts';

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const wipe = (...ns: string[]) => { const c = new SyncRedis(); try { for (const n of ns) for (const k of (c.cmd('KEYS', `${n}:*`) as string[] ?? [])) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const KA = 'alice-secret-key-0123456789abcdef', hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(KA), userId: 'alice' }];
const node = (namespace: string, chains: ChainAccounts[], publicUrl = 'http://127.0.0.1:1') => createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace, publicUrl, keys, chains, sweepMs: 60_000, requireAof: false, log: () => {} });

test('merge: each source chain lands under @<chain>:, app users are joined, sources are marked, and a multi-chain node reads every chain\'s old state', { skip }, async () => {
  const t = Date.now(), sol = `mm-sol-${t}`, base = `mm-base-${t}`, rh = `mm-rh-${t}`, r = new SyncRedis();
  try {
    // three single-chain namespaces as their servers left them (users alice and app shop's end user shop:bo)
    r.cmd('SET', defaultChainKey(sol), 'solana'); r.cmd('SADD', `${sol}:users`, 'alice'); r.cmd('SET', `${sol}:u:alice:marker`, 'sol-state'); r.cmd('SET', `${sol}:u:alice:solwallet`, '{"w":1}');
    r.cmd('SADD', `${base}:users`, 'alice', 'shop', 'shop:bo'); r.cmd('SET', `${base}:u:alice:marker`, 'base-state'); r.cmd('SET', `${base}:u:alice:basewallet`, '{"w":2}');
    r.cmd('SET', `${base}:u:shop:bo:marker`, 'bo-base'); r.cmd('SADD', `${base}:app:shop:users`, 'bo'); r.cmd('SET', `${base}:app:shop:webhook`, '{"url":"x"}');
    r.cmd('SET', `${base}:u:alice:lockish`, 'kept');                                 // a state name that merely starts with "lock"
    r.cmd('SET', defaultChainKey(rh), 'robinhood'); r.cmd('SADD', `${rh}:users`, 'alice'); r.cmd('SET', `${rh}:u:alice:marker`, 'rh-state'); r.cmd('SADD', `${rh}:app:shop:users`, 'cy');

    const p = planMerge(r, sol, [{ ns: base }, { ns: rh }]);   // base has no pinned chain: found from its basewallet
    assert.deepEqual(p.problems, []); assert.equal(p.intoChain, 'solana'); assert.deepEqual(p.sources.map(s => [s.chain, s.keys]), [['base', 4], ['robinhood', 1]]);
    assert.equal(r.cmd('GET', `${sol}:u:alice:@base:marker`), null, 'a plan writes nothing');
    assert.equal(applyMerge(r, p).copied, 6);   // 4 + 1 user keys, and shop's webhook
    assert.equal(r.cmd('GET', `${sol}:u:alice:@base:basewallet`), '{"w":2}'); assert.equal(r.cmd('GET', `${sol}:u:shop:bo:@base:marker`), 'bo-base', 'end user shop:bo is not read as shop');
    assert.equal(r.cmd('GET', `${sol}:u:alice:@robinhood:marker`), 'rh-state'); assert.equal(r.cmd('GET', `${sol}:u:alice:marker`), 'sol-state', 'the target\'s own state is untouched');
    assert.deepEqual((r.cmd('SMEMBERS', `${sol}:app:shop:users`) as string[]).sort(), ['bo', 'cy']); assert.equal(r.cmd('GET', `${sol}:app:shop:webhook`), '{"url":"x"}');
    assert.deepEqual((r.cmd('SMEMBERS', `${sol}:users`) as string[]).sort(), ['alice', 'shop', 'shop:bo']);
    assert.equal(r.cmd('GET', `${base}:u:alice:marker`), 'base-state', 'sources are kept'); assert.equal(r.cmd('GET', defaultChainKey(base)), MERGED_PREFIX + sol);
    assert.match(planMerge(r, sol, [{ ns: base }]).problems.join(), /already merged/, 'a second run is refused');

    // a server on a merged source refuses; a CHAINS=solana,base,robinhood node on the target gives each chain its old state
    const seen: Record<string, string | undefined> = {};
    const reads = (id: string): MakeAccount => (u, st) => { if (u === 'alice') seen[id] = st('marker').read(); return practiceAccount(u, st); };
    await assert.rejects(node(base, [{ id: 'base', makeAccount: practiceAccount }]), /was merged into/);
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await node(sol, [{ id: 'solana', makeAccount: reads('solana') }, { id: 'base', makeAccount: reads('base') }, { id: 'robinhood', makeAccount: reads('robinhood') }], url);
    await nd.listen(port);
    try {
      const res = await fetch(url + '/v1/base/overview', { headers: { authorization: `Bearer ${KA}` } }); assert.equal(res.status, 200);
      assert.deepEqual(seen, { solana: 'sol-state', base: 'base-state', robinhood: 'rh-state' });
    } finally { await nd.drain().catch(() => {}); }
  } finally { r.close(); wipe(sol, base, rh); }
});

test('merge refuses, writing nothing: a running node, a held lease, an existing target key, a chain twice, a different webhook', { skip }, async () => {
  const t = Date.now(), a = `mm2-a-${t}`, b = `mm2-b-${t}`, c = `mm2-c-${t}`, r = new SyncRedis();
  try {
    r.cmd('SET', defaultChainKey(a), 'solana'); r.cmd('SET', defaultChainKey(b), 'base'); r.cmd('SET', defaultChainKey(c), 'base');
    r.cmd('SADD', `${b}:users`, 'alice'); r.cmd('SET', `${b}:u:alice:engine`, 'b');
    r.cmd('SET', `${a}:u:alice:@base:engine`, 'already'); r.cmd('SET', `${a}:app:shop:fees`, '{"bps":10}'); r.cmd('SET', `${b}:app:shop:fees`, '{"bps":20}');
    r.cmd('SET', `${b}:u:alice:lock`, 'tok', 'PX', 60_000); r.cmd('SADD', `${b}:nodes`, 'http://n1'); r.cmd('SET', `${b}:node:http://n1`, '{}', 'PX', 60_000);
    const p = planMerge(r, a, [{ ns: b }, { ns: c }]), all = p.problems.join('\n');
    for (const re of [/node http:\/\/n1 is running/, /lease is still held/, /@base:engine already exists/, /both base/, /different fees/]) assert.match(all, re);
    assert.throws(() => applyMerge(r, p), /has problems/);
    assert.equal(r.cmd('GET', `${a}:u:alice:@base:engine`), 'already'); assert.equal(r.cmd('GET', defaultChainKey(b)), 'base', 'nothing marked');
    assert.match(planMerge(r, `mm2-none-${t}`, [{ ns: b }]).problems.join(), /cannot tell its chain/);
  } finally { r.close(); wipe(a, b, c); }
});

test('every node of a namespace serves the same chains: a node with a different list refuses to start while another is alive', { skip }, async () => {
  const n = `mm-same-${Date.now()}`, r = new SyncRedis();
  const sol: ChainAccounts = { id: 'solana', makeAccount: practiceAccount }, base: ChainAccounts = { id: 'base', makeAccount: practiceAccount };
  try {
    const n1 = await node(n, [sol, base], 'http://127.0.0.1:2');
    try {
      await assert.rejects(node(n, [sol], 'http://127.0.0.1:3'), /node http:\/\/127\.0\.0\.1:2 is running with chains solana,base and this node has solana\. Every node/);
      const n2 = await node(n, [sol, base], 'http://127.0.0.1:3'); await n2.drain();   // the same list (any order of the non-default chains) is fine
    } finally { await n1.drain(); }
    // after every node stopped (heartbeats expire 15 s after the last one; removed here), the namespace can start with a new list
    r.cmd('DEL', `${n}:node:http://127.0.0.1:2`, `${n}:node:http://127.0.0.1:3`);
    const n3 = await node(n, [sol], 'http://127.0.0.1:4'); await n3.drain();
    // a heartbeat from a node from before chain lists were recorded counts as the default chain alone
    r.cmd('SADD', `${n}:nodes`, 'http://old'); r.cmd('SET', `${n}:node:http://old`, '{"id":"x"}', 'PX', 60_000);
    await assert.rejects(node(n, [sol, base], 'http://127.0.0.1:5'), /running with chains solana and this node has solana,base/);
  } finally { r.close(); wipe(n); }
});
