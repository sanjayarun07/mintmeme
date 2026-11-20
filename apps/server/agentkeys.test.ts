/** Agent keys (agentkeys.ts) and the hosted MCP endpoint (apps/mcp/http.ts): a signed-in user makes a capped key; the server, not the agent, enforces what it may do.
 *  Unit tests use an in-memory Redis stand-in; the node test uses the local Redis (skipped when there is none) in its own namespace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { agentGuard, createAgentKey, listAgentKeys, lookupAgentKey, nano, parseAgentRequest, revokeAgentKey, agentSpentToday, MAX_KEYS_PER_USER } from './agentkeys.ts';
import { openSession, parsePrivyUsers } from './privyauth.ts';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { handleMcp } from '../mcp/http.ts';

function memRedis() {
  const kv = new Map<string, string>(), sets = new Map<string, Set<string>>(), ttl = new Map<string, number>();
  return { kv, sets, ttl, cmd: (...a: (string | number)[]): any => {
    const [c, k, ...rest] = a.map(String);
    switch (c) {
      case 'SET': kv.set(k, rest[0]); if (rest[1] === 'EX') ttl.set(k, Number(rest[2])); return 'OK';
      case 'GET': return kv.get(k) ?? null;
      case 'DEL': return kv.delete(k) ? 1 : 0;
      case 'SADD': { const s = sets.get(k) ?? new Set(); const had = s.has(rest[0]); s.add(rest[0]); sets.set(k, s); return had ? 0 : 1; }
      case 'SREM': return sets.get(k)?.delete(rest[0]) ? 1 : 0;
      case 'SMEMBERS': return [...(sets.get(k) ?? [])];
      case 'INCRBY': { const v = BigInt(kv.get(k) ?? '0') + BigInt(rest[0]); kv.set(k, v.toString()); return Number(v); }
      case 'DECRBY': { const v = BigInt(kv.get(k) ?? '0') - BigInt(rest[0]); kv.set(k, v.toString()); return Number(v); }
      case 'EXPIRE': ttl.set(k, Number(rest[0])); return 1;
      default: throw new Error('unexpected ' + c);
    }
  } };
}
const served = ['solana', 'base', 'bnb'];
const caps = { solana: { perTrade: '0.05', daily: '0.12' }, base: { perTrade: '0.002', daily: '0.004' } };

test('a create request is checked: real chains this server runs, plain amounts, perTrade within daily, sane slippage and expiry', () => {
  const ok = parseAgentRequest({ label: 'my bot', caps, maxSlippagePct: 3, ttlDays: 7 }, served);
  assert.deepEqual(ok, { label: 'my bot', caps: { solana: { perTrade: '0.05', daily: '0.12' }, base: { perTrade: '0.002', daily: '0.004' } }, maxSlippagePct: 3, ttlDays: 7 });
  assert.equal(parseAgentRequest({ caps: { solana: { perTrade: '0.050', daily: '1' } } }, served).caps.solana.perTrade, '0.05', 'normalised');
  assert.deepEqual([parseAgentRequest({ caps }, served).maxSlippagePct, parseAgentRequest({ caps }, served).ttlDays], [5, 30], 'defaults');
  for (const [b, re] of [
    [{ caps: {} }, /at least one chain/], [{ caps: { robinhood: { perTrade: '1', daily: '1' } } }, /not a real-funds chain this server runs/], [{ caps: { practice: { perTrade: '1', daily: '1' } } }, /not a real-funds chain/],
    [{ caps: { solana: { perTrade: '1e3', daily: '1' } } }, /plain amounts/], [{ caps: { solana: { perTrade: '0', daily: '1' } } }, /above 0/], [{ caps: { solana: { perTrade: '2', daily: '1' } } }, /cannot be more than daily/],
    [{ caps, maxSlippagePct: 50 }, /0\.1 to 20/], [{ caps, ttlDays: 365 }, /1 to 90/], [{ caps, label: '<script>' }, /label/],
  ] as const) assert.throws(() => parseAgentRequest(b, served), re);
});

test('keys: the token is shown once and only its hash is stored; list, lookup, expiry, revoke, and at most 10 per user', () => {
  const r = memRedis(), t0 = Date.parse('2026-11-20T10:00:00Z');
  const { token, key } = createAgentKey(r, 'ns', 'alice', parseAgentRequest({ label: 'bot', caps, ttlDays: 2 }, served), t0);
  assert.match(token, /^mta_[A-Za-z0-9_-]{43}$/); assert.ok(![...r.kv.keys(), ...r.kv.values(), ...[...r.sets.values()].flatMap(s => [...s])].some(x => x.includes(token)), 'the token itself is never stored');
  const h = createHash('sha256').update(token).digest();
  assert.equal(r.ttl.get(`ns:agentkey:${h.toString('hex')}`), 2 * 86_400, 'Redis expires the record with the key');
  assert.equal(lookupAgentKey(r, 'ns', h, t0)?.userId, 'alice'); assert.equal(lookupAgentKey(r, 'ns', h, t0 + 3 * 86_400_000), undefined, 'expired');
  assert.equal(lookupAgentKey({ cmd: () => { throw new Error('down'); } }, 'ns', h), undefined, 'Redis down: refused');
  assert.deepEqual(listAgentKeys(r, 'ns', 'alice').map(k => k.id), [key.id]); assert.equal(key.id.length, 16);
  assert.equal(revokeAgentKey(r, 'ns', 'bob', key.id), false, 'another user cannot revoke it');
  assert.equal(revokeAgentKey(r, 'ns', 'alice', key.id), true); assert.equal(lookupAgentKey(r, 'ns', h, t0), undefined, 'revoked'); assert.deepEqual(listAgentKeys(r, 'ns', 'alice'), []);
  for (let i = 0; i < MAX_KEYS_PER_USER; i++) createAgentKey(r, 'ns', 'alice', parseAgentRequest({ caps }, served));
  assert.throws(() => createAgentKey(r, 'ns', 'alice', parseAgentRequest({ caps }, served)), (e: any) => e.code === 'too_many_keys');
});

test('the guard: reads pass; only market buys and sells; chain, per-buy, daily, slippage, units and risky-token limits; a failed buy is refunded', () => {
  const r = memRedis(); let now = Date.parse('2026-11-20T10:00:00Z');
  const { key } = createAgentKey(r, 'ns', 'alice', parseAgentRequest({ caps, maxSlippagePct: 5 }, served), now), k = { ...key, hash: 'ab'.repeat(32) };
  const g = (chain: string) => agentGuard(r, 'ns', chain, () => now), buy = { method: 'POST', path: '/v1/trades/buy', scope: 'trade' }, sell = { method: 'POST', path: '/v1/trades/sell', scope: 'trade' };
  const code = (f: () => unknown) => { try { f(); return 'passed'; } catch (e: any) { return e.code; } };
  assert.equal(g('solana')(k, { method: 'GET', path: '/v1/positions', scope: 'read' }, {}), undefined, 'reads pass');
  for (const p of ['/v1/orders/limit-buy', '/v1/twap', '/v1/bulk/buy', '/v1/wallet/link/start', '/v1/entries/resume', '/v1/copies']) assert.equal(code(() => g('solana')(k, { method: 'POST', path: p, scope: 'trade' }, {})), 'agent_not_allowed', p);
  assert.equal(code(() => g('solana')(k, { method: 'DELETE', path: '/v1/orders/:id', scope: 'trade' }, {})), 'agent_not_allowed', 'cannot cancel a stop loss');
  assert.equal(code(() => g('bnb')(k, buy, { bnb: '0.001' })), 'agent_chain_not_allowed', 'bnb is not in this key');
  assert.equal(code(() => g('solana')(k, buy, { sol: '0.051' })), 'agent_cap_trade');
  assert.equal(code(() => g('solana')(k, buy, { amount: '1000' })), 'agent_amount_units', 'raw units refused: the cap is in plain SOL');
  assert.equal(code(() => g('solana')(k, buy, {})), 'bad_request');
  assert.equal(code(() => g('solana')(k, buy, { sol: '0.01', slippagePct: 6 })), 'agent_slippage'); assert.equal(code(() => g('solana')(k, buy, { sol: '0.01', slippageBps: 600 })), 'agent_slippage');
  assert.equal(code(() => g('solana')(k, buy, { sol: '0.01', allowRiskyToken: true })), 'agent_not_allowed');
  assert.equal(code(() => g('solana')(k, sell, { pct: 100, slippagePct: 20 })), 'agent_slippage', 'sells keep the slippage limit');
  assert.equal(g('solana')(k, sell, { pct: 100 }), undefined, 'a sell needs no budget');
  // daily: 0.05 + 0.05 fit 0.12, a third 0.05 does not; refunding the second makes room again
  assert.equal(typeof g('solana')(k, buy, { sol: '0.05' }), 'function'); const refund = g('solana')(k, buy, { sol: '0.05', slippagePct: 5 })!;
  assert.equal(code(() => g('solana')(k, buy, { sol: '0.05' })), 'agent_cap_daily');
  assert.match((() => { try { g('solana')(k, buy, { sol: '0.05' }); } catch (e: any) { return e.message; } })()!, /0\.02 left today/);
  refund(); assert.equal(code(() => g('solana')(k, buy, { sol: '0.05' })), 'passed', 'refunded');
  assert.equal(code(() => g('solana')(k, buy, { sol: '0.03' })), 'agent_cap_daily', 'the refused one was not counted (0.10 spent, 0.02 left)');
  assert.equal(code(() => g('base')(k, buy, { eth: '0.002' })), 'passed', 'each chain has its own budget');
  now += 86_400_000; assert.equal(code(() => g('solana')(k, buy, { sol: '0.05' })), 'passed', 'a new UTC day');
  assert.equal(nano('0.000000001'), 1n); assert.equal(nano('12.5'), 12_500_000_000n);
});

test('the hosted MCP endpoint: agent keys only; initialize, tools/list without confirm, and tool calls go to the API with the same key', async () => {
  const agent = { label: 'bot', caps, maxSlippagePct: 5, expiresAt: '2026-12-20T00:00:00Z' }, token = 'mta_' + 'k'.repeat(43);
  const calls: { url: string; auth: string; body: any }[] = [];
  const f = (async (url: string, init: any) => { calls.push({ url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined }); return new Response(JSON.stringify({ ok: true, key: 'k1' }), { status: 200 }); }) as any;
  const call = (body: unknown, o: Partial<Parameters<typeof handleMcp>[0]> = {}) => handleMcp({ method: 'POST', body: JSON.stringify(body), agent, token, apiUrl: 'http://127.0.0.1:9', fetch: f, ...o });
  assert.equal((await call({}, { agent: undefined })).status, 401, 'no agent key: refused');
  assert.equal((await handleMcp({ method: 'GET', body: '', agent, token, apiUrl: 'x' })).status, 405);
  const init: any = (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).body;
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools);
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools: any[] = ((await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body as any).result.tools, names = tools.map(t => t.name);
  assert.ok(names.includes('meme_buy') && names.includes('meme_sell') && names.includes('meme_positions'));
  for (const n of ['meme_place_order', 'meme_twap', 'meme_bulk', 'meme_cancel_order', 'meme_wallet_link_start', 'rfq_quote']) assert.ok(!names.includes(n), n + ' is not offered');
  const b = tools.find(t => t.name === 'meme_buy'); assert.ok(!('confirm' in b.inputSchema.properties) && !b.inputSchema.required.includes('confirm')); assert.match(b.description, /within this agent key's caps/);
  const res: any = (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'meme_buy', arguments: { chain: 'solana', token: 'So11111111111111111111111111111111111111112', amount: '0.01', slippagePct: 2 } } })).body;
  assert.equal(res.result.isError, undefined, res.result.content[0].text);
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:9/v1/solana/trades/buy'); assert.equal(calls.at(-1)!.auth, 'Bearer ' + token); assert.deepEqual(calls.at(-1)!.body, { token: 'So11111111111111111111111111111111111111112', slippagePct: 2, sol: '0.01' });
  const refused: any = (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'meme_place_order', arguments: { chain: 'solana', type: 'limit-buy', token: 'x', confirm: true } } })).body;
  assert.equal(refused.result.isError, true, 'a tool outside the hosted set is unknown here');
  const chains: any = (await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'meme_chains', arguments: {} } })).body;
  assert.deepEqual(JSON.parse(chains.result.content[0].text).mcp.agent.caps, caps, 'the agent sees its caps');
  assert.ok(!JSON.stringify(chains).includes(token), 'the key never comes back');
  const batch: any = (await call([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])).body; assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 6, result: {} }]);
  assert.equal(((await call({ jsonrpc: '2.0', id: 7, method: 'nope' })).body as any).error.code, -32601);
});

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
test('through a node: a session makes, lists and revokes agent keys; the key reads, is held to its caps, and is the only key /mcp accepts', { skip: up ? false : 'no local Redis' }, async () => {
  const n = `memedesk-agent-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const port = await new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); }), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys: [{ key: 'plain-trade-key-0000000000', userId: 'alice' }], chains: [{ id: 'solana', makeAccount: practiceAccount }], leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {},
    privyAuth: { users: parsePrivyUsers('did:privy:cmuser0000000000000000001=alice'), ttlS: 600, verify: async () => ({ did: 'did:privy:cmuser0000000000000000001' }) } });
  await nd.listen(port);
  const c = new SyncRedis(); const sess = openSession(c, n, 'alice', 'did:privy:cmuser0000000000000000001', 600).session;
  const H = (k: string) => ({ authorization: 'Bearer ' + k, 'content-type': 'application/json' });
  try {
    assert.equal((await fetch(url + '/v1/auth/agent-keys', { method: 'POST', headers: H('plain-trade-key-0000000000'), body: '{}' })).status, 401, 'an API key cannot make agent keys');
    const made: any = await (await fetch(url + '/v1/auth/agent-keys', { method: 'POST', headers: H(sess), body: JSON.stringify({ label: 'bot', caps: { solana: { perTrade: '0.05', daily: '0.06' } } }) })).json();
    assert.match(made.token, /^mta_/);
    assert.equal((await fetch(url + '/v1/auth/agent-keys', { method: 'POST', headers: H(made.token), body: '{}' })).status, 401, 'an agent key cannot make agent keys');
    const list: any = await (await fetch(url + '/v1/auth/agent-keys', { headers: H(sess) })).json(); assert.equal(list.keys[0].id, made.key.id); assert.deepEqual(list.keys[0].spentToday, { solana: '0' });
    assert.equal((await fetch(url + '/v1/solana/positions', { headers: H(made.token) })).status, 200, 'the agent key reads');
    const tr = (b: unknown, p = '/v1/solana/trades/buy') => fetch(url + p, { method: 'POST', headers: H(made.token), body: JSON.stringify(b) }).then(async r => ({ status: r.status, j: await r.json() as any }));
    assert.equal((await tr({ token: 'x', sol: '0.06' })).j.error.code, 'agent_cap_trade');
    assert.equal((await tr({ token: 'x', walletId: 'w1', amount: '5', priceE18: '1' }, '/v1/solana/orders/limit-buy')).j.error.code, 'agent_not_allowed');
    const within = await tr({ token: 'x', sol: '0.04' }); assert.notEqual(within.j.error?.code?.startsWith('agent_'), true, 'within the caps it reaches the trader (the practice stand-in refuses the body itself)');
    assert.deepEqual(((await (await fetch(url + '/v1/auth/agent-keys', { headers: H(sess) })).json()) as any).keys[0].spentToday, { solana: '0' }, 'the failed buy was given back');
    // /mcp: the agent key works; a plain API key and a session are refused
    const rpc = (k: string, body: unknown) => fetch(url + '/mcp', { method: 'POST', headers: { ...H(k), accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    assert.equal((await rpc('plain-trade-key-0000000000', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    assert.equal((await rpc(sess, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    const pos: any = await (await rpc(made.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'meme_positions', arguments: { chain: 'solana' } } })).json();
    assert.equal(pos.result.isError, undefined, pos.result.content[0].text);
    const over: any = await (await rpc(made.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'meme_buy', arguments: { chain: 'solana', token: 'x', amount: '1' } } })).json();
    assert.equal(over.result.isError, true); assert.match(over.result.content[0].text, /agent_cap_trade/);
    // revoke: the key stops working at once
    assert.equal((await fetch(url + `/v1/auth/agent-keys/${made.key.id}`, { method: 'DELETE', headers: H(sess) })).status, 200);
    assert.equal((await fetch(url + '/v1/solana/positions', { headers: H(made.token) })).status, 401);
    assert.equal((await rpc(made.token, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).status, 401);
  } finally { await nd.drain?.(); try { for (const k of (c.cmd('KEYS', `${n}:*`) as string[] ?? [])) c.cmd('DEL', k); } finally { c.close(); } }
});
