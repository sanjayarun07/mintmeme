/** One node of the production execution server. Run any number of identical nodes behind a load balancer, all pointing at the same Redis.
 *
 *  Ownership: every user is owned by exactly one node at a time (a Redis lease, see lease.ts). Only the owner runs that user's Trader (orders, TWAP, bulk) and writes its state.
 *  Routing: any node accepts any request. It authenticates the key, finds the user, and then
 *    - serves it itself when it owns the user;
 *    - forwards it (one hop, streamed, SSE included) to the owner node when another node owns the user;
 *    - claims the user (loads its state from Redis and starts its Trader) when nobody owns it and this node has room.
 *  Liveness: a sweep claims unowned users even with no traffic, so standing orders keep being watched. Leases are renewed every ttl/3; a lease that cannot be renewed
 *  stops that user's Trader immediately. A node that dies stops renewing: after the TTL another node's sweep takes its users over and resumes them from Redis.
 *  Shutdown: drain() waits for claims in progress, stops every Trader and releases every lease, so other nodes take over at once instead of after the TTL.
 *  Limits (read docs/PRODUCTION_SERVER.md): rate limits are per node; Redis is the single source of truth (run it with AOF); there is no Postgres backend. */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createApi } from '../api/server.ts';
import type { ApiKey, Route } from '../api/server.ts';
import { SyncRedis } from '../../packages/core/src/index.ts';
import type { Backend } from '../../packages/core/src/index.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';
import { UserLease, ownerOf, ownersOf, usersKey } from './lease.ts';

/** `prepare` runs before each API call with its JSON body (a real chain must learn a token before quoting or trading it, and can refuse early). */
export interface Account { trader: Trader; stop?: () => void; prepare?: (body: any, path: string) => Promise<any> }
export interface NodeOptions {
  redisUrl: string; namespace: string;
  /** How OTHER nodes reach this one (http://, e.g. http://10.0.3.7:3500). Must be routable from the other nodes. */
  publicUrl: string;
  keys: ApiKey[];
  /** Build a user's Trader over the given durable state. Called on the node that just took the user's lease. */
  makeAccount: (userId: string, state: (name: string) => Backend) => Account | Promise<Account>;
  /** Extra API routes that need the owner node's durable state for the user and a way to rebuild its account (MODE=solana-mainnet: wallet linking, solaccount.ts). */
  extraRoutes?: (h: { state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void> }) => Route[];
  leaseTtlMs?: number; maxUsers?: number; sweepMs?: number;
  /** Refuse a Redis without AOF (a Redis crash could lose recent checkpoints). Default true. */
  requireAof?: boolean;
  rate?: { perSecond: number; burst: number };
  log?: (msg: string) => void;
  /** Optional sample page: the URL of a running Solana terminal (apps/web, e.g. http://127.0.0.1:3000). When set, this node serves its /solana page and /api/sol/* calls by
   *  forwarding them there, ONLY to requests from this machine that also name this machine (loopback peer AND loopback Host, so a DNS-rebinding page cannot use it).
   *  That terminal is a single-user, real-funds wallet session: it must never be reachable through the public load balancer. */
  solanaSampleUrl?: string;
}
/** The files and calls of the /solana page (apps/web/solana.html and the scripts it loads). */
const SOLANA_SAMPLE = new Set(['/solana', '/solana.html', '/solana.css', '/styles.css', '/solcore.js', '/views3.js', '/views4.js', '/solpro.js', '/solboot.js', '/privy.bundle.js']);
export const isSolanaSamplePath = (p: string) => SOLANA_SAMPLE.has(p) || p.startsWith('/api/sol/');
export const isLoopback = (a: string | undefined) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
export const isLoopbackHost = (h: string | undefined) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h ?? '');
const HOP = 'x-memedesk-hop', NODE_HEADER = 'x-memedesk-node';
/** The API console (apps/server/console.html): a static page with no secrets; the user types a key and it calls this node's API. */
const CONSOLE_HTML = readFileSync(new URL('./console.html', import.meta.url), 'utf8');
const CONSOLE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" };

export async function createNode(o: NodeOptions) {
  // maxUsers default 300: the most users per node measured (npm run server:loadtest, docs/PRODUCTION_SERVER.md)
  const ttl = o.leaseTtlMs ?? 15_000, maxUsers = o.maxUsers ?? 300, log = o.log ?? (m => console.log(`[node ${o.publicUrl}] ${m}`));
  const r = new SyncRedis(o.redisUrl, 5000);
  if (r.cmd('PING') !== 'PONG') throw new Error('redis: unexpected reply to PING');
  let aof = 'unknown'; try { aof = r.cmd('CONFIG', 'GET', 'appendonly')?.[1] ?? 'unknown'; } catch { /* CONFIG may be disabled on managed Redis */ }
  if ((o.requireAof ?? true) && aof !== 'yes') { r.close(); throw new Error(`redis durability check failed: appendonly=${aof}. Enable AOF, or set REDIS_REQUIRE_AOF=false to accept that a Redis crash can lose recent order state.`); }
  // every user that has a key is registered, so the sweep can find users nobody owns yet
  for (const u of new Set(o.keys.map(k => k.userId))) r.cmd('SADD', usersKey(o.namespace), u);

  const owned = new Map<string, { lease: UserLease; acct: Account }>(); const claiming = new Map<string, Promise<boolean>>();
  const m = { requests: 0, proxied: 0, proxyErrors: 0, claims: 0, leasesLost: 0, released: 0, refusedNoCapacity: 0 };
  let draining = false;
  const stopAcct = (a: Account | undefined) => { try { a?.trader.stop(); a?.stop?.(); } catch { /* stopping must never throw out of a loop */ } };
  /** Rebuild an owned user's account from Redis (after its wallet link changed). The lease stays; the old Trader stops before the new one reads the state. */
  const reload = async (user: string) => {
    const x = owned.get(user); if (!x) throw new Error(`${user} is not owned by this node`);
    stopAcct(x.acct); api.endStreams(user); const acct = await o.makeAccount(user, n => x.lease.backend(n)); await acct.trader.resume();
    if (owned.get(user) !== x) { stopAcct(acct); throw new Error('ownership changed while reloading'); }
    acct.trader.start(1000); acct.trader.on(e => { if (e.type === 'error' && /lease for .* lost/.test(e.message)) drop(user, 'lost'); }); x.acct = acct;
  };
  const extra = o.extraRoutes?.({ state: u => { const x = owned.get(u); return x ? (n: string) => x.lease.backend(n) : undefined; }, reload });
  const api = createApi({ keys: o.keys, traderFor: u => owned.get(u)?.acct.trader, rate: o.rate, extraRoutes: extra, prepare: (u, body, path) => owned.get(u)?.acct.prepare?.(body, path) });

  /** Take the user's lease and start its Trader from the state in Redis. Concurrent claims for one user share one attempt. */
  const claim = (user: string): Promise<boolean> => {
    if (owned.has(user)) return Promise.resolve(true); if (draining) return Promise.resolve(false);
    const pending = claiming.get(user); if (pending) return pending;
    if (owned.size + claiming.size >= maxUsers) { m.refusedNoCapacity++; return Promise.resolve(false); }   // claims in flight count against the cap
    const p = (async () => {
      const lease = new UserLease(r, o.namespace, user, o.publicUrl, ttl); let acct: Account | undefined;
      try {
        if (!lease.acquire()) return false;
        acct = await o.makeAccount(user, n => lease.backend(n)); await acct.trader.resume();
        // the awaits above may outlast the TTL or a drain: only keep the user if the lease is still ours and we are not shutting down
        if (draining || !lease.renew()) throw new Error(draining ? 'node is draining' : 'lease expired while starting');
        acct.trader.start(1000);
        acct.trader.on(e => { if (e.type === 'error' && /lease for .* lost/.test(e.message)) drop(user, 'lost'); });
        owned.set(user, { lease, acct }); m.claims++; log(`owns ${user} (${owned.size} users)`); return true;
      } catch (e) { stopAcct(acct); lease.release(); log(`could not start ${user}: ${(e as Error).message}`); return false; }
    })().finally(() => claiming.delete(user));
    claiming.set(user, p); return p;
  };
  const drop = (user: string, why: 'lost' | 'released') => {
    const x = owned.get(user); if (!x) return; owned.delete(user); stopAcct(x.acct); api.endStreams(user);
    x.lease.release();   // also on 'lost': if a renewal merely errored the lease may still be ours, and holding it would lock the user out until the TTL
    if (why === 'released') m.released++; else { m.leasesLost++; log(`LOST the lease for ${user}: its Trader is stopped here`); }
  };
  const renewTimer = setInterval(() => {
    const list = [...owned]; let held: boolean[]; try { held = UserLease.renewAll(r, list.map(([, x]) => x.lease)); } catch { held = list.map(() => false); }
    list.forEach(([u], i) => { if (!held[i]) drop(u, 'lost'); });
  }, Math.max(500, Math.floor(ttl / 3)));
  const sweep = async () => {
    if (draining) return;
    const users = (r.cmd('SMEMBERS', usersKey(o.namespace)) as string[] | null ?? []).filter(u => !owned.has(u));
    const owners = ownersOf(r, o.namespace, users);
    for (let i = 0; i < users.length && owned.size + claiming.size < maxUsers; i++) if (!owners[i]) await claim(users[i]);
  };
  const sweepTimer = setInterval(() => { sweep().catch(e => log(`sweep skipped: ${(e as Error).message}`)); }, o.sweepMs ?? 2000); renewTimer.unref?.(); sweepTimer.unref?.();

  const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
  /** Stream a request to `base` (same path and query only: the target host is never taken from the request), and the answer back. Connect timeout only, so SSE stays open;
   *  a client that goes away closes the upstream request too. */
  const forward = (req: http.IncomingMessage, res: http.ServerResponse, base: string, headers: http.OutgoingHttpHeaders, onError: () => void) => {
    const p = new URL(req.url ?? '/', 'http://x'), u = new URL(base); u.pathname = p.pathname; u.search = p.search;
    const out = http.request(u, { method: req.method, headers: { ...headers, host: u.host } }, up => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    out.on('socket', s => { if (s.connecting) { s.setTimeout(3000, () => out.destroy(new Error('connect timeout'))); s.once('connect', () => s.setTimeout(0)); } });
    out.on('error', () => { if (!res.headersSent) onError(); else res.end(); });
    res.on('close', () => out.destroy());
    req.pipe(out);
  };
  const toOwner = (req: http.IncomingMessage, res: http.ServerResponse, owner: string) => {
    m.proxied++;
    forward(req, res, owner, { ...req.headers, [HOP]: '1' }, () => { m.proxyErrors++; json(res, 503, { error: { code: 'owner_unreachable', message: 'The node that runs this account did not answer.', fix: `Retry in a few seconds: ownership moves to a live node within ${Math.ceil(ttl / 1000)} s.` } }, { 'retry-after': String(Math.ceil(ttl / 1000)) }); });
  };
  /** The /solana page: the browser sees this node's origin, the terminal must see its own (its CSRF check is Origin host == Host, Host is localhost). So Host becomes the
   *  terminal's, and only an Origin equal to this node's own loopback address is rewritten; any other Origin passes unchanged and the terminal refuses it. */
  const toTerminal = (req: http.IncomingMessage, res: http.ServerResponse, base: string) => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }, origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host === req.headers.host) headers.origin = new URL(base).origin; } catch { /* malformed: pass through, the terminal refuses it */ } }
    forward(req, res, base, headers, () => json(res, 502, { error: { code: 'terminal_unreachable', message: `The Solana terminal at ${base} did not answer.`, fix: 'Start it with: npm run web' } }));
  };
  // event-loop delay since the last scrape: Redis calls are synchronous and every owned Trader ticks on this loop, so this is the node's load signal
  const ELD_RES = 10, eld = monitorEventLoopDelay({ resolution: ELD_RES }); eld.enable();
  const metrics = () => {
    const ms = (n: number) => Math.max(0, n / 1e6 - ELD_RES).toFixed(1);   // the sampler's own interval is not delay: report only the time beyond it
    let orders = 0; for (const x of owned.values()) orders += x.acct.trader.listOrders({ status: 'active' }).length;
    const out = [
    '# TYPE memedesk_users_owned gauge', `memedesk_users_owned ${owned.size}`,
    '# TYPE memedesk_orders_active gauge', `memedesk_orders_active ${orders}`,
    '# TYPE memedesk_event_loop_delay_ms gauge', `memedesk_event_loop_delay_ms{quantile="0.5"} ${ms(eld.percentile(50))}`, `memedesk_event_loop_delay_ms{quantile="0.99"} ${ms(eld.percentile(99))}`, `memedesk_event_loop_delay_ms{quantile="1"} ${ms(eld.max)}`,
    '# TYPE memedesk_requests_total counter', `memedesk_requests_total ${m.requests}`,
    '# TYPE memedesk_proxied_total counter', `memedesk_proxied_total ${m.proxied}`,
    '# TYPE memedesk_proxy_errors_total counter', `memedesk_proxy_errors_total ${m.proxyErrors}`,
    '# TYPE memedesk_claims_total counter', `memedesk_claims_total ${m.claims}`,
    '# TYPE memedesk_leases_lost_total counter', `memedesk_leases_lost_total ${m.leasesLost}`,
    '# TYPE memedesk_capacity_refusals_total counter', `memedesk_capacity_refusals_total ${m.refusedNoCapacity}`,
    '# TYPE memedesk_draining gauge', `memedesk_draining ${draining ? 1 : 0}`, ''].join('\n');
    eld.reset(); return out;
  };
  const serveLocal = (req: http.IncomingMessage, res: http.ServerResponse) => { res.setHeader(NODE_HEADER, o.publicUrl); api.server.emit('request', req, res); };

  const server = http.createServer(async (req, res) => {
    try {
      // origin-form targets only ("/path"): "//host/..." or "http://host/..." would make forwarding reach a host the client chose
      if (!/^\/(?!\/)/.test(req.url ?? '')) return json(res, 400, { error: { code: 'bad_request', message: 'Request target must be a path.' } });
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/healthz') return json(res, 200, { ok: true, node: o.publicUrl, users: owned.size });
      if (path === '/readyz') { let ok = !draining; try { ok = ok && r.cmd('PING') === 'PONG'; } catch { ok = false; } return json(res, ok ? 200 : 503, { ready: ok, draining }); }
      if (path === '/metrics') { const body = metrics(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(body); }   // build first: a throw must not leave a half-sent response
      if (path === '/console' || path === '/') { res.writeHead(200, CONSOLE_HEADERS); return res.end(CONSOLE_HTML); }
      if (isSolanaSamplePath(path)) {
        if (!o.solanaSampleUrl || !isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) return json(res, 404, { error: { code: 'not_found', message: `No route ${path}.` } });
        return toTerminal(req, res, o.solanaSampleUrl);
      }
      m.requests++;
      const user = api.userOf(req);
      if (!user || path === '/v1/health' || path === '/v1/openapi.json') return void api.server.emit('request', req, res);   // unknown keys get the API's own 401
      if (owned.has(user)) return serveLocal(req, res);
      const owner = ownerOf(r, o.namespace, user);
      if (owner && owner !== o.publicUrl) { if (req.headers[HOP]) return json(res, 503, { error: { code: 'routing_loop', message: 'Ownership is moving between nodes.', fix: 'Retry in a few seconds.' } }, { 'retry-after': '2' }); return toOwner(req, res, owner); }
      if (await claim(user)) return serveLocal(req, res);
      const now = ownerOf(r, o.namespace, user); if (now && now !== o.publicUrl && !req.headers[HOP]) return toOwner(req, res, now);   // another node won the race
      return json(res, 503, { error: { code: draining ? 'draining' : 'no_capacity', message: draining ? 'This node is shutting down.' : 'No node has room for this account right now.', fix: 'Retry shortly; add nodes or raise MAX_USERS_PER_NODE if this persists.' } }, { 'retry-after': '5' });
    } catch (e) { log(`request failed: ${(e as Error).message}`); if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'The server could not complete this request.', fix: 'Retry; if it keeps failing, check the node log.' } }); else res.end(); }   // never leave a request hanging
  });
  const stopServing = async () => { draining = true; clearInterval(sweepTimer); clearInterval(renewTimer); eld.disable(); await Promise.allSettled(claiming.values()); };
  const closeHttp = () => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); });

  return {
    server, owned, metrics: m, sweep, claim,
    listen: (port: number, host = '127.0.0.1') => new Promise<number>(ok => server.listen(port, host, () => ok((server.address() as any).port))),
    /** Graceful shutdown: stop claiming (after claims in progress settle), stop every Trader, release every lease (others take over at once), close HTTP and Redis. */
    async drain() { await stopServing(); for (const u of [...owned.keys()]) drop(u, 'released'); await closeHttp(); await api.close().catch(() => {}); r.close(); log('drained'); },
    /** Test hook: stop renewing and serving WITHOUT releasing (what a crashed or frozen node looks like to the others). */
    async crash() { await stopServing(); for (const x of owned.values()) stopAcct(x.acct); owned.clear(); await closeHttp(); r.close(); },
  };
}
