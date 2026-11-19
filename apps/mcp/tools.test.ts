/** The MCP tools against a fake HTTP backend: argument checks, chain prefixes, the real-funds gate, the desk's read-only allow list and secret redaction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { callTool, configFromEnv, listTools, parseNdjson, redact, routeFor, secretsFromEnv, SPENDING_TOOLS, validate, type Ctx } from './tools.ts';

const KEY = 'mk_live_0123456789abcdefSECRET', HELIUS = 'hel-9f8e7d6c5b4a39281706';
interface Call { method: string; url: string; headers: Record<string, string>; body: any }
function fake(env: Record<string, string> = {}, answer: (c: Call) => { status?: number; json?: unknown; text?: string } = () => ({ json: { ok: true } })) {
  const calls: Call[] = [];
  const f = (async (url: string, init: any = {}) => {
    const c: Call = { method: init.method ?? 'GET', url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(c);
    const a = answer(c); return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const e = { MEME_API_URL: 'http://exec.test/', MEME_API_KEY: KEY, RFQ_DESK_URL: 'http://desk.test', HELIUS_API_KEY: HELIUS, ...env };
  const ctx: Ctx = { cfg: configFromEnv(e), fetch: f, secrets: secretsFromEnv(e), now: () => 1 };
  return { ctx, calls };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test('every tool lists a closed object schema; spending tools require confirm and say they spend real funds', () => {
  const tools = listTools(); assert.ok(tools.length >= 30);
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.equal(t.inputSchema.additionalProperties, false); assert.ok(t.description.length > 20, t.name); }
  assert.deepEqual(SPENDING_TOOLS.sort(), ['meme_bulk', 'meme_buy', 'meme_place_order', 'meme_sell', 'meme_twap']);
  for (const n of SPENDING_TOOLS) { const t = tools.find(x => x.name === n)!; assert.ok(t.inputSchema.required.includes('confirm')); assert.match(t.description, /SPENDS REAL FUNDS/); assert.equal(t.annotations.readOnlyHint, false); }
  for (const t of tools.filter(x => x.name.startsWith('rfq_'))) assert.equal(t.annotations.readOnlyHint, true, t.name);
});

test('argument validation: unknown tool, missing, extra, wrong type, enum, pattern, range', async () => {
  const { ctx, calls } = fake();
  assert.equal((await callTool('nope', {}, ctx)).isError, true);
  for (const [name, args, msg] of [
    ['meme_overview', {}, /chain is required/], ['meme_overview', { chain: 'solana', extra: 1 }, /extra is not an argument/], ['meme_overview', { chain: 'mars' }, /must be one of/],
    ['meme_quote', { chain: 'solana', side: 'buy', token: 'So1', amount: '1.5' }, /amount is not valid/], ['meme_trades', { chain: 'base', limit: 1000 }, /at most 200/],
    ['meme_trades', { chain: 'base', limit: 'x' }, /must be a number/], ['rfq_evm_quote', { chain: 'solana', symbol: 'NVDAc', amount: 1 }, /must be one of base, bnb, robinhood/],
    ['meme_trade', { chain: 'base', key: '../../app/webhook' }, /key is not valid/],
  ] as const) { const r = await callTool(name, args, ctx); assert.equal(r.isError, true, name); assert.equal(body(r).error.code, 'bad_arguments'); assert.match(body(r).error.message, msg); }
  assert.equal(calls.length, 0, 'nothing is sent for bad arguments');
  assert.deepEqual(validate({ type: 'object', properties: { a: { type: 'integer' } } }, { a: 1.5 }), ['arguments.a must be a whole number']);
});

test('every chain goes to /v1/<chain>/ with the key; the chain list has no prefix and no key', async () => {
  const { ctx, calls } = fake();
  for (const chain of ['solana', 'base', 'robinhood', 'bnb', 'practice']) { const r = await callTool('meme_overview', { chain }, ctx); assert.equal(r.isError, undefined, chain); }
  assert.deepEqual(calls.map(c => c.url), ['solana', 'base', 'robinhood', 'bnb', 'practice'].map(c => `http://exec.test/v1/${c}/overview`));
  assert.ok(calls.every(c => c.headers.authorization === `Bearer ${KEY}`));
  await callTool('meme_chains', {}, ctx); const last = calls.at(-1)!; assert.equal(last.url, 'http://exec.test/v1/chains'); assert.equal(last.headers.authorization, undefined);
  await callTool('meme_orders', { chain: 'bnb', status: 'active', token: '0xabc' }, ctx); assert.equal(calls.at(-1)!.url, 'http://exec.test/v1/bnb/orders?status=active&token=0xabc');
  await callTool('meme_stock', { chain: 'solana', symbol: 'TSLAx' }, ctx); assert.equal(calls.at(-1)!.url, 'http://exec.test/v1/solana/stocks/TSLAx');
  await callTool('meme_quote', { chain: 'base', side: 'buy', token: '0xabc', amount: '1000' }, ctx); assert.deepEqual(calls.at(-1)!.body, { side: 'buy', token: '0xabc', amount: '1000' });
});

test('practice on its own server: MEME_PRACTICE_URL, no prefix, its own key', () => {
  const cfg = configFromEnv({ MEME_API_URL: 'http://exec.test', MEME_API_KEY: 'a'.repeat(20), MEME_PRACTICE_URL: 'http://practice.test/', MEME_PRACTICE_API_KEY: 'p'.repeat(20) });
  assert.deepEqual(routeFor(cfg, 'practice', '/v1/trades/buy'), { url: 'http://practice.test/v1/trades/buy', key: 'p'.repeat(20) });
  assert.deepEqual(routeFor(cfg, 'base', '/v1/trades/buy'), { url: 'http://exec.test/v1/base/trades/buy', key: 'a'.repeat(20) });
  assert.throws(() => routeFor(cfg, 'mars', '/v1/x'), /unknown chain/);
});

test('without a key, keyed tools refuse before any request', async () => {
  const { ctx, calls } = fake({ MEME_API_KEY: '' });
  const r = await callTool('meme_positions', { chain: 'solana' }, ctx); assert.equal(body(r).error.code, 'no_api_key'); assert.equal(calls.length, 0);
});

test('the real-funds gate: confirm is required everywhere; real chains also need MCP_ALLOW_TRADES=1; practice does not', async () => {
  const buy = { token: 'TSLAx', amount: '0.01' };
  { // no flag
    const { ctx, calls } = fake();
    for (const chain of ['solana', 'base', 'robinhood', 'bnb']) {
      assert.equal(body(await callTool('meme_buy', { chain, ...buy }, ctx)).error.code, 'confirm_required', chain);
      assert.equal(body(await callTool('meme_buy', { chain, ...buy, confirm: false }, ctx)).error.code, 'confirm_required');
      const r = await callTool('meme_buy', { chain, ...buy, confirm: true }, ctx); assert.equal(body(r).error.code, 'trades_disabled'); assert.match(body(r).error.fix, /MCP_ALLOW_TRADES=1/);
    }
    for (const [name, a] of [['meme_sell', { token: 'x', pct: 50 }], ['meme_place_order', { type: 'stop-loss', token: 'x', pct: 100, priceUsd: '1' }], ['meme_twap', { token: 'x', side: 'buy', total: '1', slices: 2, intervalS: 60 }], ['meme_bulk', { side: 'buy', token: 'x', wallets: ['a'], total: '1' }]] as const) {
      assert.equal(body(await callTool(name, { chain: 'solana', ...a, confirm: true }, ctx)).error.code, 'trades_disabled', name);
      assert.equal(body(await callTool(name, { chain: 'base', ...a }, ctx)).error.code, 'confirm_required', name);
    }
    assert.equal(body(await callTool('meme_buy', { chain: 'base', ...buy, confirm: 'yes' }, ctx)).error.code, 'bad_arguments', 'confirm must be the boolean true');
    assert.equal(calls.length, 0, 'nothing reached the server');
    // practice: confirm only
    assert.equal(body(await callTool('meme_buy', { chain: 'practice', token: '0xMEME', amount: '1000' }, ctx)).error.code, 'confirm_required');
    const r = await callTool('meme_buy', { chain: 'practice', token: '0xMEME', amount: '1000', confirm: true }, ctx); assert.equal(r.isError, undefined);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://exec.test/v1/practice/trades/buy'); assert.deepEqual(calls[0].body, { token: '0xMEME', amount: '1000', walletId: 'w1' });
    assert.ok(calls[0].headers['idempotency-key']?.startsWith('mcp-buy-'));
  }
  { // with the flag: each chain's plain-units field, the idempotency key, the order type in the path
    const { ctx, calls } = fake({ MCP_ALLOW_TRADES: '1' });
    for (const [chain, k] of [['solana', 'sol'], ['base', 'eth'], ['robinhood', 'eth'], ['bnb', 'bnb']]) {
      const r = await callTool('meme_buy', { chain, ...buy, slippagePct: 3, key: 'k1', confirm: true }, ctx); assert.equal(r.isError, undefined, chain);
      const c = calls.at(-1)!; assert.equal(c.url, `http://exec.test/v1/${chain}/trades/buy`); assert.deepEqual(c.body, { token: 'TSLAx', slippagePct: 3, [k]: '0.01' }); assert.equal(c.headers['idempotency-key'], 'k1');
    }
    await callTool('meme_place_order', { chain: 'bnb', type: 'limit-buy', token: '0xabc', amount: '0.02', priceUsd: '1.5', confirm: true }, ctx);
    assert.equal(calls.at(-1)!.url, 'http://exec.test/v1/bnb/orders/limit-buy'); assert.deepEqual(calls.at(-1)!.body, { token: '0xabc', priceUsd: '1.5', bnb: '0.02' });
    await callTool('meme_sell', { chain: 'solana', token: 'TSLAx', pct: 25, confirm: true }, ctx); assert.deepEqual(calls.at(-1)!.body, { token: 'TSLAx', pct: 25 });
    assert.equal(body(await callTool('meme_sell', { chain: 'solana', token: 'TSLAx', confirm: true }, ctx)).error.code, 'bad_request', 'a sell must say how much');
    // practice takes pctBps only: pct becomes pctBps there (found in a live run against the practice server)
    await callTool('meme_sell', { chain: 'practice', token: '0xMEME', pct: 50, confirm: true }, ctx); assert.deepEqual(calls.at(-1)!.body, { token: '0xMEME', pctBps: 5000, walletId: 'w1' });
    await callTool('meme_bulk', { chain: 'base', side: 'sell', token: '0xabc', wallets: ['a', 'b'], pctBps: 5000, confirm: true }, ctx); assert.equal(calls.at(-1)!.url, 'http://exec.test/v1/base/bulk/sell');
    assert.ok(calls.every(c => !('confirm' in (c.body ?? {}))), 'confirm is never sent to the server');
  }
});

test('cancels need confirm but not the flag', async () => {
  const { ctx, calls } = fake();
  assert.equal(body(await callTool('meme_cancel_order', { chain: 'solana', id: 'u.o1' }, ctx)).error.code, 'bad_arguments');
  assert.equal(body(await callTool('meme_cancel_order', { chain: 'solana', id: 'u.o1', confirm: false }, ctx)).error.code, 'confirm_required');
  assert.equal((await callTool('meme_cancel_order', { chain: 'solana', id: 'u.o1', confirm: true }, ctx)).isError, undefined);
  assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.url], ['DELETE', 'http://exec.test/v1/solana/orders/u.o1']);
});

test('server errors come back as isError with code, message and fix', async () => {
  const { ctx } = fake({}, () => ({ status: 404, json: { error: { code: 'chain_not_enabled', message: 'bnb is not served here', fix: 'Use GET /v1/chains' } } }));
  const r = await callTool('meme_overview', { chain: 'bnb' }, ctx); assert.equal(r.isError, true); assert.deepEqual(body(r).error, { code: 'chain_not_enabled', message: 'bnb is not served here', fix: 'Use GET /v1/chains' });
  const down = fake(); down.ctx.fetch = (async () => { throw new TypeError('fetch failed'); }) as any;
  assert.equal(body(await callTool('meme_overview', { chain: 'base' }, down.ctx)).error.code, 'network');
});

test('desk tools: read-only paths, query strings, NDJSON stages with the transaction left out', async () => {
  const nd = [{ stage: 'rfq', out: '5' }, { stage: 'decision', useRfq: true }, { stage: 'trade', tradable: true, transaction: 'AAAA'.repeat(100) }, { stage: 'done' }].map(x => JSON.stringify(x)).join('\n') + '\n';
  const { ctx, calls } = fake({}, c => c.url.endsWith('/api/quote') ? { text: nd } : { json: { ok: 1 } });
  const all = body(await callTool('rfq_quote', { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', amount: '1000', pay: 'USDC' }, ctx));
  assert.deepEqual(all.map((s: any) => s.stage), ['rfq', 'decision', 'trade', 'done']); assert.match(all[2].transaction, /omitted/);
  assert.deepEqual(calls[0].body, { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', pay: 'USDC', amount: '1000' }); assert.equal(calls[0].headers.authorization, undefined, 'no API key goes to the desk');
  const some = body(await callTool('rfq_quote', { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', amount: '1000', stages: ['decision'] }, ctx)); assert.deepEqual(some, [{ stage: 'decision', useRfq: true }]);
  await callTool('rfq_liquidity', { chain: 'bnb', token: '0x' + 'a'.repeat(40) }, ctx); assert.equal(calls.at(-1)!.url, `http://desk.test/api/liquidity?chain=bnb&token=0x${'a'.repeat(40)}`);
  await callTool('rfq_evm_quote', { chain: 'robinhood', symbol: 'AAPL', side: 'sell', amount: 2 }, ctx); assert.deepEqual([calls.at(-1)!.url, calls.at(-1)!.body], ['http://desk.test/api/evm/quote', { chain: 'robinhood', symbol: 'AAPL', side: 'sell', amount: 2 }]);
  await callTool('rfq_gate', { tamper: 'drain' }, ctx); await callTool('rfq_config', {}, ctx); await callTool('rfq_ladder', { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', usd: 100 }, ctx);
  await callTool('rfq_evm_price', { chain: 'base', symbol: 'NVDAc' }, ctx); await callTool('rfq_token_price', { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' }, ctx);
  assert.ok(calls.every(c => !/\/api\/(execute|sol\/rpc|status)/.test(c.url)), 'never the execute route or the RPC relay');
  assert.ok(!listTools().some(t => /execute/i.test(t.name)));
  const err = fake({}, () => ({ text: JSON.stringify({ stage: 'error', error: 'enter an amount' }) + '\n' }));
  assert.equal(body(await callTool('rfq_quote', { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', amount: '1' }, err.ctx)).error.code, 'desk_error');
  assert.deepEqual(parseNdjson('{"stage":"a"}\nnot json\n'), [{ stage: 'a' }, { stage: 'unparsed', line: 'not json' }]);
});

test('secrets never come back: env values, bearer tokens, api-key query values, RPC keys in paths', async () => {
  const s = secretsFromEnv({ MEME_API_KEY: KEY, HELIUS_API_KEY: HELIUS, PRIVY_APP_SECRET: 'privy-secret-value-123', PRIVY_APP_ID: 'cmwi0zwjh01ht0hkz7zkqt62n', SHORT_KEY: 'abc', MEME_API_URL: 'http://x' });
  assert.ok(s.includes(KEY) && s.includes(HELIUS) && s.includes('privy-secret-value-123')); assert.ok(!s.includes('cmwi0zwjh01ht0hkz7zkqt62n'), 'ids are not secrets'); assert.ok(!s.includes('abc'));
  const t = redact(`k=${KEY} Bearer abcdefghijklmnop https://mainnet.helius-rpc.com/?api-key=${HELIUS} https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz12 https://x.test/?token=tok123456`, s);
  for (const leak of [KEY, HELIUS, 'abcdefghijklmnop', 'AbCdEfGhIjKlMnOpQrStUvWxYz12', 'tok123456']) assert.ok(!t.includes(leak), leak);
  // through a tool: the server echoes the key and an RPC URL in an error and in a success
  const { ctx } = fake({}, c => c.url.includes('/overview') ? { status: 500, json: { error: { code: 'boom', message: `bad key ${KEY} rpc https://mainnet.helius-rpc.com/?api-key=${HELIUS}` } } } : { json: { echo: KEY, rpc: HELIUS } });
  for (const r of [await callTool('meme_overview', { chain: 'solana' }, ctx), await callTool('meme_positions', { chain: 'solana' }, ctx), await callTool('rfq_config', {}, ctx)]) {
    assert.ok(!r.content[0].text.includes(KEY) && !r.content[0].text.includes(HELIUS)); assert.match(r.content[0].text, /\[redacted\]/);
  }
});

test('meme_events reads a few server-sent events and stops', async () => {
  const sse = 'data: {"type":"trade","key":"a"}\n\n: heartbeat\n\ndata: {"type":"order","id":"b"}\n\ndata: {"type":"order","id":"c"}\n\n';
  const { ctx } = fake(); const seen: string[] = [];
  ctx.fetch = (async (url: string, init: any) => { seen.push(url + ' ' + init.headers.authorization.slice(0, 7)); return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }); }) as any;
  const r = body(await callTool('meme_events', { chain: 'base', seconds: 1, max: 2 }, ctx));
  assert.deepEqual(seen, ['http://exec.test/v1/base/events Bearer ']); assert.equal(r.count, 2); assert.deepEqual(r.events.map((e: any) => e.type), ['trade', 'order']);
});

test('main.ts answers initialize and tools/list over stdio', { skip: !existsSync(new URL('./node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url)) && 'run npm install in apps/mcp' }, async () => {
  const p = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', new URL('./main.ts', import.meta.url).pathname], { env: { PATH: process.env.PATH, MEME_API_URL: 'http://127.0.0.1:9', RFQ_DESK_URL: 'http://127.0.0.1:9', MEME_API_KEY: KEY }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + '\n');
  const reply = (id: number) => new Promise<any>((res, rej) => { const t = setTimeout(() => rej(new Error('no reply; stderr: ' + err)), 10_000); const tick = setInterval(() => { const l = out.split('\n').find(x => x.includes(`"id":${id}`)); if (l) { clearInterval(tick); clearTimeout(t); res(JSON.parse(l)); } }, 20); });
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal((await reply(1)).result.serverInfo.name, 'memedesk');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal((await reply(2)).result.tools.length, listTools().length);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'meme_buy', arguments: { chain: 'solana', token: 'TSLAx', amount: '1', confirm: true } } });
    const r = await reply(3); assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /trades_disabled/);
    assert.ok(!err.includes(KEY) && !out.includes(KEY));
  } finally { p.kill(); }
});
