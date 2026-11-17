/** One node of the production execution server. Run any number of identical nodes behind a load balancer, all pointing at the same Redis.
 *
 *  Ownership: every user is owned by exactly one node at a time (a Redis lease, see lease.ts). Only the owner runs that user's Trader (orders, TWAP, bulk) and writes its state.
 *  Routing: any node accepts any request. It authenticates the key, finds the user, and then
 *    - serves it itself when it owns the user;
 *    - forwards it (one hop, streamed, SSE included) to the owner node when another node owns the user;
 *    - claims the user (loads its state from Redis and starts its Trader) when nobody owns it and this node has room.
 *  Liveness: a sweep claims unowned users even with no traffic, so standing orders keep being watched. Leases are renewed every ttl/3; a lease that cannot be renewed
 *  stops that user's Trader immediately. A node that dies stops renewing: after the TTL another node's sweep takes its users over and resumes them from Redis.
 *  Shutdown: drain() stops claiming, stops every Trader and releases every lease, so other nodes take over at once instead of after the TTL.
 *  Limits (read docs/PRODUCTION_SERVER.md): rate limits are per node; Redis is the single source of truth (run it with AOF); there is no Postgres backend. */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApi } from '../api/server.ts';
import type { ApiKey } from '../api/server.ts';
import { SyncRedis } from '../../packages/core/src/index.ts';
import type { Backend } from '../../packages/core/src/index.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';
import { UserLease, ownerOf, usersKey } from './lease.ts';

export interface Account { trader: Trader; stop?: () => void }
export interface NodeOptions {
  redisUrl: string; namespace: string;
  /** How OTHER nodes reach this one (e.g. http://10.0.3.7:3500). Must be routable from the other nodes. */
  publicUrl: string;
  keys: ApiKey[];
  /** Build a user's Trader over the given durable state. Called on the node that just took the user's lease. */
  makeAccount: (userId: string, state: (name: string) => Backend) => Account | Promise<Account>;
  leaseTtlMs?: number; maxUsers?: number; sweepMs?: number;
  /** Refuse a Redis without AOF (a Redis crash could lose recent checkpoints). Default true. */
  requireAof?: boolean;
  rate?: { perSecond: number; burst: number };
  log?: (msg: string) => void;
  /** Optional sample page: the URL of a running Solana terminal (apps/web, e.g. http://127.0.0.1:3000). When set, this node serves its /solana page and /api/sol/* calls by
   *  forwarding them there, ONLY to requests from this machine (loopback). That terminal is a single-user, real-funds wallet session: it must never be reachable through the
   *  public load balancer, so remote requests for these paths get 404. */
  solanaSampleUrl?: string;
}
/** The files and calls of the /solana page (apps/web/solana.html and the scripts it loads). */
const SOLANA_SAMPLE = new Set(['/solana', '/solana.html', '/solana.css', '/styles.css', '/solcore.js', '/views3.js', '/views4.js', '/solpro.js', '/solboot.js', '/privy.bundle.js']);
export const isSolanaSamplePath = (p: string) => SOLANA_SAMPLE.has(p) || p.startsWith('/api/sol/');
export const isLoopback = (a: string | undefined) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const sha = (s: string) => createHash('sha256').update(s).digest();
const HOP = 'x-memedesk-hop', NODE_HEADER = 'x-memedesk-node';
/** The API console (apps/server/console.html): a static page with no secrets; the user types a key and it calls this node's API. */
const CONSOLE_HTML = readFileSync(new URL('./console.html', import.meta.url), 'utf8');

export async function createNode(o: NodeOptions) {
  const ttl = o.leaseTtlMs ?? 15_000, maxUsers = o.maxUsers ?? 500, log = o.log ?? (m => console.log(`[node ${o.publicUrl}] ${m}`));
  const r = new SyncRedis(o.redisUrl, 5000);
  if (r.cmd('PING') !== 'PONG') throw new Error('redis: unexpected reply to PING');
  let aof = 'unknown'; try { aof = r.cmd('CONFIG', 'GET', 'appendonly')?.[1] ?? 'unknown'; } catch { /* CONFIG may be disabled on managed Redis */ }
  if ((o.requireAof ?? true) && aof !== 'yes') { r.close(); throw new Error(`redis durability check failed: appendonly=${aof}. Enable AOF, or set REDIS_REQUIRE_AOF=false to accept that a Redis crash can lose recent order state.`); }
  // every user that has a key is registered, so the sweep can find users nobody owns yet
  for (const u of new Set(o.keys.map(k => k.userId))) r.cmd('SADD', usersKey(o.namespace), u);

  const owned = new Map<string, { lease: UserLease; acct: Account }>(); const claiming = new Map<string, Promise<boolean>>();
  const m = { requests: 0, proxied: 0, proxyErrors: 0, claims: 0, leasesLost: 0, released: 0, refusedNoCapacity: 0 };
  let draining = false;
  const api = createApi({ keys: o.keys, traderFor: u => owned.get(u)?.acct.trader, rate: o.rate });
  const keyHashes = o.keys.map(k => ({ h: k.keyHash ? Buffer.from(k.keyHash, 'hex') : sha(k.key!), userId: k.userId }));
  const userOf = (req: http.IncomingMessage) => { const mm = /^Bearer (.{16,200})$/.exec(String(req.headers.authorization ?? '')); if (!mm) return undefined; const h = sha(mm[1]); return keyHashes.find(k => timingSafeEqual(k.h, h))?.userId; };

  /** Take the user's lease and start its Trader from the state in Redis. Concurrent claims for one user share one attempt. */
  const claim = (user: string): Promise<boolean> => {
    if (owned.has(user)) return Promise.resolve(true); if (draining) return Promise.resolve(false);
    const pending = claiming.get(user); if (pending) return pending;
    const p = (async () => {
      if (owned.size >= maxUsers) { m.refusedNoCapacity++; return false; }
      const lease = new UserLease(r, o.namespace, user, o.publicUrl, ttl); if (!lease.acquire()) return false;
      try {
        const acct = await o.makeAccount(user, n => lease.backend(n)); await acct.trader.resume(); acct.trader.start(1000);
        acct.trader.on(e => { if (e.type === 'error' && /lease for .* lost/.test(e.message)) drop(user, 'lost'); });
        owned.set(user, { lease, acct }); m.claims++; log(`owns ${user} (${owned.size} users)`); return true;
      } catch (e) { lease.release(); log(`could not start ${user}: ${(e as Error).message}`); return false; }
    })().finally(() => claiming.delete(user));
    claiming.set(user, p); return p;
  };
  const drop = (user: string, why: 'lost' | 'released') => {
    const x = owned.get(user); if (!x) return; owned.delete(user);
    try { x.acct.trader.stop(); x.acct.stop?.(); } catch { /* stopping must not throw out of the loop */ }
    if (why === 'released') { x.lease.release(); m.released++; } else { m.leasesLost++; log(`LOST the lease for ${user}: its Trader is stopped here`); }
  };
  const renewTimer = setInterval(() => { for (const [u, x] of owned) { let ok = false; try { ok = x.lease.renew(); } catch { ok = false; } if (!ok) drop(u, 'lost'); } }, Math.max(500, Math.floor(ttl / 3)));
  const sweep = async () => { if (draining) return; let users: string[] = []; try { users = r.cmd('SMEMBERS', usersKey(o.namespace)) ?? []; } catch { return; }
    for (const u of users) { if (owned.size >= maxUsers) break; if (!owned.has(u) && !ownerOf(r, o.namespace, u)) await claim(u); } };
  const sweepTimer = setInterval(() => { void sweep(); }, o.sweepMs ?? 2000); renewTimer.unref?.(); sweepTimer.unref?.();

  const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
  const proxy = (req: http.IncomingMessage, res: http.ServerResponse, owner: string) => {
    m.proxied++; const u = new URL(req.url ?? '/', owner);
    const out = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host, [HOP]: '1' } }, up => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    // connect timeout only (a dead owner's address often never answers); once connected, no timeout, so /v1/events streams stay open
    out.on('socket', s => { if (s.connecting) { s.setTimeout(3000, () => out.destroy(new Error('owner connect timeout'))); s.once('connect', () => s.setTimeout(0)); } });
    out.on('error', () => { m.proxyErrors++; if (!res.headersSent) json(res, 503, { error: { code: 'owner_unreachable', message: 'The node that runs this account did not answer.', fix: `Retry in a few seconds: ownership moves to a live node within ${Math.ceil(ttl / 1000)} s.` } }, { 'retry-after': String(Math.ceil(ttl / 1000)) }); else res.end(); });
    req.pipe(out);
  };
  /** Forward a /solana page request to the local terminal. The browser sees one origin (this node); the terminal must see itself as that origin too, or its CSRF check
   *  (Origin host == Host, Host is localhost) refuses every POST. So Host is the terminal's, and an Origin that matched THIS node's host is rewritten to the terminal's;
   *  any other Origin is passed through unchanged and the terminal refuses it, exactly as it would directly. */
  const sampleProxy = (req: http.IncomingMessage, res: http.ServerResponse, base: string) => {
    const u = new URL(req.url ?? '/', base), headers: http.OutgoingHttpHeaders = { ...req.headers, host: u.host };
    const origin = req.headers.origin; if (origin) { try { if (new URL(origin).host === req.headers.host) headers.origin = u.origin; } catch { /* malformed: pass through, the terminal refuses it */ } }
    const out = http.request(u, { method: req.method, headers }, up => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    out.on('socket', s => { if (s.connecting) { s.setTimeout(3000, () => out.destroy(new Error('terminal connect timeout'))); s.once('connect', () => s.setTimeout(0)); } });
    out.on('error', () => { if (!res.headersSent) json(res, 502, { error: { code: 'terminal_unreachable', message: `The Solana terminal at ${base} did not answer.`, fix: 'Start it with: npm run web (or the command you use for apps/web/server.ts).' } }); else res.end(); });
    req.pipe(out);
  };
  const metrics = () => [
    '# TYPE memedesk_users_owned gauge', `memedesk_users_owned ${owned.size}`,
    '# TYPE memedesk_requests_total counter', `memedesk_requests_total ${m.requests}`,
    '# TYPE memedesk_proxied_total counter', `memedesk_proxied_total ${m.proxied}`,
    '# TYPE memedesk_proxy_errors_total counter', `memedesk_proxy_errors_total ${m.proxyErrors}`,
    '# TYPE memedesk_claims_total counter', `memedesk_claims_total ${m.claims}`,
    '# TYPE memedesk_leases_lost_total counter', `memedesk_leases_lost_total ${m.leasesLost}`,
    '# TYPE memedesk_capacity_refusals_total counter', `memedesk_capacity_refusals_total ${m.refusedNoCapacity}`,
    '# TYPE memedesk_draining gauge', `memedesk_draining ${draining ? 1 : 0}`, ''].join('\n');

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/healthz') return json(res, 200, { ok: true, node: o.publicUrl, users: owned.size });
      if (path === '/readyz') { let ok = !draining; try { ok = ok && r.cmd('PING') === 'PONG'; } catch { ok = false; } return json(res, ok ? 200 : 503, { ready: ok, draining }); }
      if (path === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metrics()); }
      if (path === '/console' || path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); return res.end(CONSOLE_HTML); }
      if (isSolanaSamplePath(path)) {
        if (!o.solanaSampleUrl || !isLoopback(req.socket.remoteAddress)) return json(res, 404, { error: { code: 'not_found', message: `No route ${path}.` } });
        return sampleProxy(req, res, o.solanaSampleUrl);
      }
      m.requests++;
      const user = userOf(req);
      if (owned.has(user ?? '')) res.setHeader(NODE_HEADER, o.publicUrl);   // which node ran it: a forwarded response keeps the owner's value
      if (!user || path === '/v1/health' || path === '/v1/openapi.json' || owned.has(user)) return void api.server.emit('request', req, res);   // unknown keys get the API's own 401
      const owner = ownerOf(r, o.namespace, user);
      if (owner && owner !== o.publicUrl) { if (req.headers[HOP]) return json(res, 503, { error: { code: 'routing_loop', message: 'Ownership is moving between nodes.', fix: 'Retry in a few seconds.' } }, { 'retry-after': '2' }); return proxy(req, res, owner); }
      if (await claim(user)) { res.setHeader(NODE_HEADER, o.publicUrl); return void api.server.emit('request', req, res); }
      const now = ownerOf(r, o.namespace, user); if (now && now !== o.publicUrl && !req.headers[HOP]) return proxy(req, res, now);   // another node won the race
      return json(res, 503, { error: { code: draining ? 'draining' : 'no_capacity', message: draining ? 'This node is shutting down.' : 'No node has room for this account right now.', fix: 'Retry shortly; add nodes or raise MAX_USERS_PER_NODE if this persists.' } }, { 'retry-after': '5' });
    } catch (e) { log(`request failed: ${(e as Error).message}`); if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'The server could not complete this request.', fix: 'Retry; if it keeps failing, check the node log.' } }); }
  });

  return {
    server, owned, metrics: m, sweep, claim,
    listen: (port: number, host = '127.0.0.1') => new Promise<number>(ok => server.listen(port, host, () => ok((server.address() as any).port))),
    /** Graceful shutdown: stop claiming, stop every Trader, release every lease (others take over at once), close HTTP and Redis. */
    async drain() {
      draining = true; clearInterval(sweepTimer); clearInterval(renewTimer);
      for (const u of [...owned.keys()]) drop(u, 'released');
      await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); });
      await api.close().catch(() => {}); r.close(); log('drained');
    },
    /** Test hook: stop renewing and serving without releasing (what a crashed or frozen node looks like to the others). */
    async crash() { draining = true; clearInterval(sweepTimer); clearInterval(renewTimer); for (const x of owned.values()) { try { x.acct.trader.stop(); x.acct.stop?.(); } catch { /* */ } } owned.clear(); await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); }); r.close(); },
  };
}
