/** Execution API: the whole engine over HTTP/JSON, for your own bots, dashboards and services. Thin by design: every route calls a `Trader` method (packages/sdk), so the API can do exactly what the SDK
 *  can and is bound by the same wallet policies. Security model:
 *   - Bearer API keys, stored only as SHA-256 hashes in memory, compared in constant time. A key maps to ONE user and has a scope: `read` (GET only) or `trade`.
 *   - Tenant isolation: every id a client sends (trade key, order, bulk, TWAP, alert) is stored as `<userId>.<id>`; a client can only read or cancel ids under its own prefix.
 *   - Listens on 127.0.0.1 by default. Put TLS (a reverse proxy) in front before exposing it: API keys are bearer secrets.
 *   - 256 KB body cap, JSON only, per-key rate limit, no stack traces in errors, amounts as decimal strings (see packages/sdk/src/wire.ts). */
import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { SdkError, ID_RE, plain, toJson } from '../../packages/sdk/src/wire.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';

/** `key` is the secret; a production server can give `keyHash` (hex SHA-256 of the secret) instead, so the plain key never sits in its config. */
export interface ApiKey { key?: string; keyHash?: string; userId: string; scope?: 'read' | 'trade'; label?: string }
export interface ApiOptions {
  keys: ApiKey[]; traderFor: (userId: string) => Trader | undefined;
  /** Rate limit per key: requests per second sustained and burst. Default 20 and 40. */
  rate?: { perSecond: number; burst: number };
  /** Optional: how the host turns a JSON request into a launch or leader source. Without these, creating snipes and copy configs answers 501 with an explanation (listing still works). */
  makeSnipe?: (t: Trader, body: any) => Promise<unknown> | unknown; makeCopy?: (t: Trader, body: any) => Promise<unknown> | unknown;
  now?: () => number;
}
interface Ctx { t: Trader; userId: string; body: any; params: Record<string, string>; query: URLSearchParams; headers: http.IncomingHttpHeaders }
export interface Route { method: string; path: string; scope: 'read' | 'trade'; summary: string; body?: string; run: (c: Ctx) => Promise<unknown> | unknown }
const sha = (s: string) => createHash('sha256').update(s).digest();
const ns = (u: string, v: unknown, what: string) => { if (v === undefined) return undefined; if (typeof v !== 'string' || !ID_RE.test(v)) throw new SdkError('bad_text', `${what} must be 1 to 128 letters, digits, dot, dash, underscore or colon`); return `${u}.${v}`; };
const mine = (u: string, v: string, what: string) => { if (!v.startsWith(u + '.')) throw new SdkError('not_found', `no ${what} ${v}`, undefined, 404); return v; };
const found = <T>(o: T | undefined, what: string, id: string): T => { if (!o) throw new SdkError('not_found', `no ${what} ${id}`, undefined, 404); return o; };
const lim = (q: URLSearchParams) => { const n = q.get('limit'); return n === null ? undefined : Number(n); };

function routes(o: ApiOptions): Route[] {
  // Every id is stored under the caller's prefix, including ids we make up: an order placed without an id must still be readable, editable and cancellable by its owner.
  const scoped = (c: Ctx) => ({ ...c.body, id: ns(c.userId, c.body?.id ?? `a-${randomUUID()}`, 'id') });
  const idem = (c: Ctx) => ns(c.userId, c.headers['idempotency-key'] ?? c.body?.key, 'Idempotency-Key');
  return [
    { method: 'GET', path: '/v1/overview', scope: 'read', summary: 'Account state: chain, block, active orders, running bulk and TWAP jobs', run: c => c.t.overview() },
    { method: 'POST', path: '/v1/quote', scope: 'read', summary: 'Best price right now for a market trade. Nothing is sent', body: 'side ("buy"|"sell"), token, amount (raw units, string), slippageBps?', run: c => c.t.quote(c.body) },
    { method: 'POST', path: '/v1/trades/buy', scope: 'trade', summary: 'Market buy. Send an Idempotency-Key header: retrying the same key never trades twice', body: 'walletId, token, amount (quote budget, raw string), slippageBps?, minOut?, deadlineS?, maxFeeBps?', run: c => c.t.buy({ ...c.body, key: idem(c) }) },
    { method: 'POST', path: '/v1/trades/sell', scope: 'trade', summary: 'Market sell an exact amount, or a percentage of the wallet balance', body: 'walletId, token, amount (raw string) OR pctBps (1..10000), slippageBps?, minOut?', run: c => c.t.sell({ ...c.body, key: idem(c) }) },
    { method: 'GET', path: '/v1/trades', scope: 'read', summary: 'Your trades, newest first (query: limit, origin, walletId)', run: c => c.t.trades({ limit: lim(c.query), origin: c.query.get('origin') ?? undefined, walletId: c.query.get('walletId') ?? undefined }) },
    { method: 'GET', path: '/v1/trades/:key', scope: 'read', summary: 'One trade: state, fill, tx hash, failure reason, state history', run: c => found(c.t.trade_(mine(c.userId, c.params.key, 'trade')), 'trade', c.params.key) },
    { method: 'POST', path: '/v1/trades/:key/advance', scope: 'trade', summary: 'Drive a trade that is waiting on the chain one more step. Safe to repeat', run: c => c.t.advance(mine(c.userId, c.params.key, 'trade')) },
    { method: 'POST', path: '/v1/wallets/:id/cancel-stuck', scope: 'trade', summary: 'Replace a stuck transaction nonce with a no-op so later trades are not blocked', body: 'force? (boolean)', run: c => c.t.cancelStuck(c.params.id, { force: c.body?.force === true }) },
    ...([['limit-buy', 'limitBuy', 'Buy when the price falls to priceE18 or lower'], ['limit-sell', 'limitSell', 'Sell when the price rises to priceE18 or higher'], ['take-profit', 'takeProfit', 'Sell at a profit target'], ['stop-loss', 'stopLoss', 'Sell if the price falls to priceE18']] as const).map(([p, m, s]): Route =>
      ({ method: 'POST', path: `/v1/orders/${p}`, scope: 'trade', summary: s, body: 'id?, walletId, token, amount (buy: quote budget; sell: tokens), priceE18 (string) OR priceUsd (decimal string, needs a USD feed) OR marketCap {target, circulating|total, supplySource}, slippageBps?, chase? {stepBps, maxBps}, ttlS?, maxDeviationBps?, maxAttempts?', run: c => (c.t as any)[m](scoped(c)) })),
    { method: 'POST', path: '/v1/orders/trailing-stop', scope: 'trade', summary: 'Sell when the price falls trailBps from its peak since placement', body: 'id?, walletId, token, amount, trailBps (1..9999), slippageBps?, ttlS?', run: c => c.t.trailingStop(scoped(c) as any) },
    { method: 'POST', path: '/v1/orders/bracket', scope: 'trade', summary: 'Take profit and/or stop loss and/or trailing stop on one position; when one fires the others are cancelled', body: 'id?, walletId, token, amount, takeProfitE18? OR takeProfitUsd?, stopLossE18? OR stopLossUsd?, trailBps?, slippageBps?, chase? {stepBps, maxBps}', run: c => c.t.bracket(scoped(c) as any) },
    { method: 'GET', path: '/v1/orders', scope: 'read', summary: 'Your orders (query: status, token)', run: c => c.t.listOrders({ status: (c.query.get('status') ?? undefined) as any, token: c.query.get('token') ?? undefined }) },
    { method: 'GET', path: '/v1/orders/:id', scope: 'read', summary: 'One order with the reason it has not fired yet', run: c => { const ord = found(c.t.getOrder(mine(c.userId, c.params.id, 'order')), 'order', c.params.id); return { ...ord, detail: c.t.orderStatus(ord.id) }; } },
    { method: 'PATCH', path: '/v1/orders/:id', scope: 'trade', summary: 'Move an active order\'s trigger. Keeps its reserved balance and bracket link. priceUsd fixes it in dollars, priceE18 in the quote token', body: 'priceE18 (string) OR priceUsd (decimal string)', run: c => c.t.editOrder(mine(c.userId, c.params.id, 'order'), { priceE18: c.body?.priceE18, priceUsd: c.body?.priceUsd }) },
    { method: 'DELETE', path: '/v1/orders/:id', scope: 'trade', summary: 'Cancel an active order and release its reserved balance', run: c => c.t.cancelOrder(mine(c.userId, c.params.id, 'order')) },
    { method: 'POST', path: '/v1/bulk/buy', scope: 'trade', summary: 'Buy one token from up to 10 wallets at once. Not atomic: the report says which legs landed', body: 'id?, token, legs [{walletId, amount}] OR wallets [..] + total, slippageBps?, maxTotal?, maxImpactBps?, onFailure?, mode?, perTick?', run: c => c.t.bulkBuy(scoped(c) as any) },
    { method: 'POST', path: '/v1/bulk/sell', scope: 'trade', summary: 'Sell one token from up to 10 wallets: exact legs, equal split, or a percentage of each balance', body: 'id?, token, legs OR wallets+total OR wallets+pctBps, slippageBps?, ...', run: c => c.t.bulkSell(scoped(c) as any) },
    { method: 'GET', path: '/v1/bulk/:id', scope: 'read', summary: 'Per-wallet status of a bulk order', run: c => c.t.bulkStatus(mine(c.userId, c.params.id, 'bulk order')) },
    { method: 'POST', path: '/v1/twap', scope: 'trade', summary: 'Buy or sell in equal slices over time from one wallet', body: 'id?, walletId, token, side, total, slices (2..100), intervalS, startAt?, windowS?, limitPriceE18?, maxSliceImpactBps?, jitterPct?, onFailure?', run: c => c.t.twap(scoped(c) as any) },
    { method: 'GET', path: '/v1/twap/:id', scope: 'read', summary: 'Slice-by-slice status, average price, next due time', run: c => c.t.twapStatus(mine(c.userId, c.params.id, 'twap order')) },
    { method: 'DELETE', path: '/v1/twap/:id', scope: 'trade', summary: 'Stop a TWAP: unsent slices are skipped, one already in flight finishes', run: c => c.t.cancelTwap(mine(c.userId, c.params.id, 'twap order')) },
    { method: 'POST', path: '/v1/alerts', scope: 'trade', summary: 'Alert when a token price crosses a threshold (delivered on /v1/events)', body: 'id?, token, direction ("above"|"below"), threshold (number, quote per token), oneShot?', run: c => ({ id: c.t.addPriceAlert(scoped(c) as any) }) },
    { method: 'DELETE', path: '/v1/alerts/:id', scope: 'trade', summary: 'Cancel a price alert', run: c => ({ cancelled: c.t.cancelPriceAlert(mine(c.userId, c.params.id, 'alert')) }) },
    { method: 'GET', path: '/v1/positions', scope: 'read', summary: 'Open positions with cost basis and P&L (unknown basis stays unknown)', run: c => c.t.positions() },
    { method: 'GET', path: '/v1/history', scope: 'read', summary: 'Confirmed trade history (query: token)', run: c => c.t.history(c.query.get('token') ?? undefined) },
    { method: 'POST', path: '/v1/entries/pause', scope: 'trade', summary: 'Pause NEW buys (manual, orders, bulk, TWAP, snipe, copy). Sells and stop losses are unaffected', run: c => { c.t.pauseEntries(); return { paused: true }; } },
    { method: 'POST', path: '/v1/entries/resume', scope: 'trade', summary: 'Resume buys', run: c => { c.t.resumeEntries(); return { paused: false }; } },
    { method: 'GET', path: '/v1/snipes', scope: 'read', summary: 'Running launch snipers and what each decided per launch', run: c => [...c.t.snipes].map(([id, s]) => ({ id, status: Object.fromEntries(s.status), results: Object.fromEntries(s.results), exitErrors: Object.fromEntries(s.exitErrors), lastError: s.lastError })) },
    { method: 'POST', path: '/v1/snipes', scope: 'trade', summary: 'Start a launch sniper (needs a launch source configured by the host)', body: 'host-defined', run: async c => { if (!o.makeSnipe) throw new SdkError('not_configured', 'this server has no launch source configured', 'Sniping needs a chain-specific launch scanner. Create it in code with trader.addSnipe(...) or pass makeSnipe to createApi.', 501); return o.makeSnipe(c.t, c.body); } },
    { method: 'GET', path: '/v1/copies', scope: 'read', summary: 'Running copy-trading configs and their last errors', run: c => [...c.t.copies].map(([id, r]) => ({ id, lastError: r.lastError, outbox: r.outbox.length, inflight: r.inflight.size })) },
    { method: 'POST', path: '/v1/copies', scope: 'trade', summary: 'Start copying leader wallets (needs a leader source configured by the host)', body: 'host-defined', run: async c => { if (!o.makeCopy) throw new SdkError('not_configured', 'this server has no leader source configured', 'Copy trading needs a chain-specific leader scanner. Create it in code with trader.addCopy(...) or pass makeCopy to createApi.', 501); return o.makeCopy(c.t, c.body); } },
  ];
}

export function openapi(rs: Route[]) {
  const paths: Record<string, any> = {};
  for (const r of rs) (paths[r.path.replace(/:(\w+)/g, '{$1}')] ??= {})[r.method.toLowerCase()] = { summary: r.summary, description: r.body ? `Body: ${r.body}. Amounts and prices are decimal strings of raw base units.` : undefined, security: [{ bearer: [] }], 'x-scope': r.scope,
    parameters: [...(r.path.match(/:(\w+)/g) ?? []).map(p => ({ name: p.slice(1), in: 'path', required: true, schema: { type: 'string' } })), ...(r.path.endsWith('/buy') || r.path.endsWith('/sell') ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }] : [])],
    requestBody: r.method === 'POST' || r.method === 'PATCH' || r.method === 'DELETE' ? { content: { 'application/json': { schema: { type: 'object' } } } } : undefined, responses: { 200: { description: 'OK' }, 400: { description: 'Invalid request: the body says what to send instead' }, 401: { description: 'Missing or unknown API key' }, 403: { description: 'Key is read-only' }, 404: { description: 'Not found (also for ids that belong to another user)' }, 429: { description: 'Rate limit' } } };
  paths['/v1/events'] = { get: { summary: 'Server-sent events: trade, order, bulk, twap, snipe, alert and error events for your account', security: [{ bearer: [] }], responses: { 200: { description: 'text/event-stream' } } } };
  return { openapi: '3.0.3', info: { title: 'Meme execution API', version: '1.0.0', description: 'Whole-engine trading API. Amounts are raw base units as decimal strings. Practice or real depends on the chain the server is wired to.' }, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, paths };
}

export function createApi(o: ApiOptions) {
  const now = o.now ?? Date.now, rate = o.rate ?? { perSecond: 20, burst: 40 };
  const keys = o.keys.map(k => {
    if (k.keyHash !== undefined) { if (!/^[0-9a-f]{64}$/i.test(k.keyHash)) throw new Error('keyHash must be 64 hex characters (SHA-256)'); return { h: Buffer.from(k.keyHash, 'hex'), userId: k.userId, scope: k.scope ?? 'trade' as const, label: k.label }; }
    if (!k.key || k.key.length < 16) throw new Error('API keys must be at least 16 characters'); return { h: sha(k.key), userId: k.userId, scope: k.scope ?? 'trade' as const, label: k.label }; });
  const rs = routes(o), compiled = rs.map(r => ({ r, re: new RegExp('^' + r.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') }));
  const buckets = new Map<string, { tokens: number; at: number }>(); const streams = new Map<string, Set<http.ServerResponse>>(); const wired = new Set<string>();
  const send = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(typeof body === 'string' ? body : toJson(body)); };
  const fail = (res: http.ServerResponse, e: unknown) => { if (e instanceof SdkError) return send(res, e.status || 400, { error: e.toJSON() }); send(res, 500, { error: { code: 'internal', message: 'The server could not complete this request.', fix: 'Retry; if it keeps failing, check the server log.' } }); console.error('[api] internal error:', (e as Error)?.message); };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((ok, no) => { let n = 0; const ch: Buffer[] = []; req.on('data', d => { n += d.length; if (n > 256 * 1024) { no(new SdkError('too_large', 'request body is over 256 KB', undefined, 413)); req.destroy(); } else ch.push(d); }); req.on('end', () => { if (!n) return ok({}); try { const j = JSON.parse(Buffer.concat(ch).toString('utf8')); if (j === null || typeof j !== 'object' || Array.isArray(j)) throw 0; ok(j); } catch { no(new SdkError('bad_json', 'the body must be a JSON object', 'Send Content-Type: application/json with an object body.')); } }); req.on('error', no); });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname;
      if (path === '/v1/health') return send(res, 200, { ok: true });
      if (path === '/v1/openapi.json') return send(res, 200, openapi(rs));
      const m = /^Bearer (.{16,200})$/.exec(String(req.headers.authorization ?? '')); const h = m ? sha(m[1]) : undefined;
      const k = h && keys.find(x => timingSafeEqual(x.h, h)); if (!k) return send(res, 401, { error: { code: 'unauthorized', message: 'Missing or unknown API key.', fix: 'Send Authorization: Bearer <your key>.' } }, { 'www-authenticate': 'Bearer' });
      const bk = k.h.toString('hex'), b = buckets.get(bk) ?? { tokens: rate.burst, at: now() }; b.tokens = Math.min(rate.burst, b.tokens + (now() - b.at) / 1000 * rate.perSecond); b.at = now(); buckets.set(bk, b);
      if (b.tokens < 1) return send(res, 429, { error: { code: 'rate_limited', message: 'Too many requests.', fix: `Slow down to ${rate.perSecond} requests per second.` } }, { 'retry-after': '1' }); b.tokens -= 1;
      const t = o.traderFor(k.userId); if (!t) throw new SdkError('no_account', 'no trading account is set up for this key', undefined, 403);
      if (!wired.has(k.userId)) { wired.add(k.userId); t.on(e => { const sub = streams.get(k.userId); if (sub) for (const r of sub) r.write(`data: ${toJson(e)}\n\n`); }); }
      if (path === '/v1/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(': connected\n\n');
        const set = streams.get(k.userId) ?? new Set(); set.add(res); streams.set(k.userId, set); const hb = setInterval(() => res.write(': hb\n\n'), 15_000); hb.unref?.();
        req.on('close', () => { clearInterval(hb); set.delete(res); }); return;
      }
      const hit = compiled.find(x => x.r.method === req.method && x.re.test(path));
      if (!hit) { const other = compiled.some(x => x.re.test(path)); return send(res, other ? 405 : 404, { error: { code: other ? 'method_not_allowed' : 'not_found', message: other ? `${req.method} is not allowed here.` : `No route ${path}.`, fix: 'See GET /v1/openapi.json for the list of routes.' } }); }
      if (hit.r.scope === 'trade' && k.scope === 'read') return send(res, 403, { error: { code: 'read_only_key', message: 'This API key is read-only.', fix: 'Use a key with the trade scope for this call.' } });
      const params = Object.fromEntries(Object.entries(hit.re.exec(path)!.groups ?? {}).map(([a, v]) => [a, decodeURIComponent(v!)]));
      const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE' ? await readBody(req) : {};
      send(res, 200, plain(await hit.r.run({ t, userId: k.userId, body, params, query: url.searchParams, headers: req.headers })));
    } catch (e) { fail(res, e); }
  });
  return { server, routes: rs, listen: (port = 0, host = '127.0.0.1') => new Promise<number>(ok => server.listen(port, host, () => ok((server.address() as any).port))), close: () => { for (const s of streams.values()) for (const r of s) r.end(); return new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); }); } };
}
