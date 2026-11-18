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
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { ApiKey, Route } from '../api/server.ts';
import { SyncRedis } from '../../packages/core/src/index.ts';
import type { Backend } from '../../packages/core/src/index.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';
import { UserLease, ownerOf, ownersOf, usersKey } from './lease.ts';
import { Webhooks, appRoutes, appUsersKey } from './webhooks.ts';
import { History, auditBody } from './history.ts';
import { recordRoutes, clusterStatus, statusHtml, nodeKey, nodesKey, nodeId } from './status.ts';
import type { WebhookOptions } from './webhooks.ts';
import { CHAIN_SPECS, CHAIN_ID_RE, RESERVED_SEGMENTS, defaultChainKey, stateName } from './chains.ts';

/** `prepare` runs before each API call with its JSON body (a real chain must learn a token before quoting or trading it, and can refuse early). */
/** `copies` (optional): copy trading for this account (POST/GET/DELETE /v1/copies): the host builds the leader source and keeps the configs in the user's state. */
export interface Account { trader: Trader; stop?: () => void; prepare?: (body: any, path: string) => Promise<any>; copies?: AccountCopies }
export interface AccountCopies { create: (body: any) => Promise<unknown>; remove: (id: string) => unknown; list: () => unknown }
export type MakeAccount = (userId: string, state: (name: string) => Backend) => Account | Promise<Account>;
export type ExtraRoutes = (h: { state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void> }) => Route[];
/** One chain a node serves (chains.ts): its account factory and its own routes (wallet linking...). `legacyMarks`: state names only this chain writes (its wallet link),
 *  used once per namespace to refuse a default chain that would read another chain's old unprefixed state. */
export interface ChainAccounts { id: string; label?: string; makeAccount: MakeAccount; extraRoutes?: ExtraRoutes; legacyMarks?: string[] }
export interface NodeOptions {
  redisUrl: string; namespace: string;
  /** How OTHER nodes reach this one (http://, e.g. http://10.0.3.7:3500). Must be routable from the other nodes. */
  publicUrl: string;
  keys: ApiKey[];
  /** One chain: build a user's Trader over the given durable state. Called on the node that just took the user's lease. Give this OR `chains`. */
  makeAccount?: MakeAccount;
  /** Extra API routes that need the owner node's durable state for the user and a way to rebuild its account (MODE=solana-mainnet: wallet linking, solaccount.ts). */
  extraRoutes?: ExtraRoutes;
  /** Several chains at once (CHAINS=solana,base): every user gets one account per chain under one lease. The first is the default chain: paths without a
   *  /v1/<chain>/ prefix go to it and its state keeps the unprefixed names. */
  chains?: ChainAccounts[];
  /** How long a chain whose account could not be built for a user waits before it is tried again (its other chains keep running). Default 10 s. */
  chainRetryMs?: number;
  /** State names of chains this server does NOT run (their wallet links), checked once with the listed chains' legacyMarks before the default chain is pinned, so a
   *  namespace a single-chain server of another chain wrote is never handed to this default chain (main.ts passes every known chain's). */
  otherLegacyMarks?: { chain: string; mark: string }[];
  leaseTtlMs?: number; maxUsers?: number; sweepMs?: number;
  /** Refuse a Redis without AOF (a Redis crash could lose recent checkpoints). Default true. */
  requireAof?: boolean;
  rate?: { perSecond: number; burst: number };
  log?: (msg: string) => void;
  /** Optional sample page: the URL of a running Solana terminal (apps/web, e.g. http://127.0.0.1:3000). When set, this node serves its /solana page and /api/sol/* calls by
   *  forwarding them there, ONLY to requests from this machine that also name this machine (loopback peer AND loopback Host, so a DNS-rebinding page cannot use it).
   *  That terminal is a single-user, real-funds wallet session: it must never be reachable through the public load balancer. */
  solanaSampleUrl?: string;
  /** Webhooks for app keys (webhooks.ts): retry timing, http for local tests. */
  webhooks?: WebhookOptions;
  /** Trade history and audit log in Postgres (history.ts), e.g. postgres://user:pass@host:5432/db?sslmode=require. Optional. */
  pgUrl?: string;
  /** Extra checks shown on the status page (a Solana RPC, Jito, Privy...): each resolves when healthy, throws when not. */
  statusChecks?: { name: string; run: () => Promise<unknown> }[];
  /** The most end users one app key may create. Default 10,000. */
  maxUsersPerApp?: number;
  /** The highest fee an app may set on its users' trades (PUT /v1/app/fees). Default 100 bps (1%). */
  maxAppFeeBps?: number;
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

  const chains = chainsOf(o, r), multi = chains.length > 1, defaultChain = chains[0].id, chainIds = new Set(chains.map(c => c.id));
  /** Per user: the lease, and one slot per chain (an account, or why it could not be built and when to try again). */
  type Slot = { acct?: Account; error?: string; retryAt?: number };
  const owned = new Map<string, { lease: UserLease; slots: Map<string, Slot> }>(); const claiming = new Map<string, Promise<boolean>>(), reviving = new Map<string, Promise<void>>();
  const m = { requests: 0, proxied: 0, proxyErrors: 0, claims: 0, leasesLost: 0, released: 0, refusedNoCapacity: 0, chainErrors: 0 };
  const RETRY_MS = o.chainRetryMs ?? 10_000;
  let draining = false;
  const stopAcct = (a: Account | undefined) => { try { a?.trader.stop(); a?.stop?.(); } catch { /* stopping must never throw out of a loop */ } };
  const accountsOf = (x: { slots: Map<string, Slot> }) => [...x.slots.values()].flatMap(s => (s.acct ? [s.acct] : []));
  const acctOf = (user: string, chain: string) => owned.get(user)?.slots.get(chain)?.acct;
  const stateOf = (lease: UserLease, chain: string) => (n: string) => lease.backend(stateName(chain, chain === defaultChain, n));
  const build = async (user: string, lease: UserLease, c: ChainAccounts) => { const acct = await c.makeAccount(user, stateOf(lease, c.id)); try { await acct.trader.resume(); } catch (e) { stopAcct(acct); throw e; } return acct; };
  const activate = (user: string, chain: string, acct: Account) => { acct.trader.start(1000); wire(user, chain, acct.trader); acct.trader.on(e => { if (e.type === 'error' && /lease for .* lost/.test(e.message)) drop(user, 'lost'); }); };
  /** Rebuild one chain's account of an owned user from Redis (after its wallet link changed, or to retry a chain that failed to start). The lease stays; the old Trader
   *  stops before the new one reads the state. A failure leaves that chain unavailable (retried later); the user's other chains keep running. */
  /** Reloads of one user's chain run one at a time: two overlapping ones (a link call and the sweep's retry) would otherwise both activate a Trader on one journal. */
  const reloadQueue = new Map<string, Promise<unknown>>();
  const reload = (user: string, chain = defaultChain): Promise<void> => {
    const k = `${user}\n${chain}`, prev = reloadQueue.get(k) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => reloadNow(user, chain));
    const tail = p.catch(() => {}).finally(() => { if (reloadQueue.get(k) === tail) reloadQueue.delete(k); }); reloadQueue.set(k, tail);
    return p;
  };
  const reloadNow = async (user: string, chain: string) => {
    const x = owned.get(user); if (!x) throw new Error(`${user} is not owned by this node`);
    const c = chains.find(k => k.id === chain); if (!c) throw new Error(`chain ${chain} is not served here`);
    stopAcct(x.slots.get(chain)?.acct); apis.get(chain)!.endStreams(user);
    let acct: Account; try { acct = await build(user, x.lease, c); } catch (e) { if (owned.get(user) === x) x.slots.set(chain, { error: (e as Error).message, retryAt: Date.now() + RETRY_MS }); m.chainErrors++; throw e; }
    if (owned.get(user) !== x) { stopAcct(acct); throw new Error('ownership changed while reloading'); }
    const was = x.slots.get(chain)?.acct; if (was && was !== acct) stopAcct(was);   // never two Traders for one chain
    activate(user, chain, acct); x.slots.set(chain, { acct });
  };
  /** Try again to build a chain that failed for this user, at most every RETRY_MS. */
  const revive = (user: string, chain: string): Promise<void> => {
    const s = owned.get(user)?.slots.get(chain); if (!s?.error || (s.retryAt ?? 0) > Date.now()) return Promise.resolve();
    const k = `${user}\n${chain}`, p0 = reviving.get(k); if (p0) return p0;
    const p = reload(user, chain).then(() => log(`${chain} account of ${user} is running again`), e => log(`${chain} account of ${user} still unavailable: ${(e as Error).message}`)).finally(() => reviving.delete(k));
    reviving.set(k, p); return p;
  };
  const hooks = new Webhooks(r, o.namespace, { log, ...o.webhooks });
  /** An app's end users become accounts the first time they call: registered so the sweep keeps their orders watched, up to maxUsersPerApp per app. */
  const registered = new Set<string>(), perApp = o.maxUsersPerApp ?? 10_000;
  const register = (user: string): { code: string; message: string; fix: string } | undefined => {
    const app = user.slice(0, user.indexOf(':')), k = appUsersKey(o.namespace, app);
    if (!r.cmd('SISMEMBER', k, user)) { if (Number(r.cmd('SCARD', k)) >= perApp) return { code: 'app_user_limit', message: `this app already has ${perApp} users`, fix: 'Ask the operator to raise MAX_USERS_PER_APP.' }; r.cmd('SADD', k, user); r.cmd('SADD', usersKey(o.namespace), user); }
    registered.add(user); return undefined;
  };
  /** Every event of an app's end user goes to the app's webhook (if it set one). Internal error events are not sent. */
  const history = o.pgUrl ? new History(o.pgUrl, { log }) : undefined; if (history) await history.start();
  // with several chains every webhook event and stored trade says which chain it is on; trade keys of non-default chains are stored as <chain>/<key> in Postgres
  const named = !!o.chains?.length;
  const wire = (user: string, chain: string, t: Trader) => t.on(e => { if (e.type !== 'error') void hooks.emit(user, e.type, multi ? { ...e, chain } : e); if (e.type === 'trade') history?.recordTrade(user, t.trade_(e.key), named ? { chain, prefixKey: chain !== defaultChain } : undefined); });
  /** One API per chain (same keys, one shared rate budget per key): routes, wallet linking and event streams are per chain; app routes and records are the same on all. */
  const buckets = new Map<string, { tokens: number; at: number }>(), apps = [...appRoutes(hooks, r, o.namespace, o.maxAppFeeBps ?? 100), ...recordRoutes(history, true)];
  const apis = new Map(chains.map(c => {
    const copiesOf = (u: string) => { const cp = acctOf(u, c.id)?.copies; if (!cp) throw new SdkError('not_configured', `copy trading is not available for this account on ${c.id}`, 'Copy trading needs a leader source for this chain (Solana has one).', 501); return cp; };
    const extra = c.extraRoutes?.({ state: u => { const x = owned.get(u); return x ? stateOf(x.lease, c.id) : undefined; }, reload: u => reload(u, c.id) });
    const audit = history ? (e: Parameters<NonNullable<Parameters<typeof createApi>[0]['onChange']>>[0]) => history.audit({ ...e, path: multi ? e.path.replace(/^\/v1\//, `/v1/${c.id}/`) : e.path, node: o.publicUrl, body: auditBody(e.body) }) : undefined;
    return [c.id, createApi({ keys: o.keys, buckets, traderFor: u => acctOf(u, c.id)?.trader, rate: o.rate, extraRoutes: [...(extra ?? []), ...recordRoutes(history)], onChange: audit, prepare: (u, body, path) => acctOf(u, c.id)?.prepare?.(body, path),
      makeCopy: (_t, body, u) => copiesOf(u).create(body), removeCopy: (_t, id, u) => copiesOf(u).remove(id), listCopies: (t, u) => acctOf(u, c.id)?.copies?.list() ?? [...t.copies].map(([id, x]) => ({ id, lastError: x.lastError })), appRoutes: apps })] as const;
  }));
  const api = apis.get(defaultChain)!;
  const endAllStreams = (user: string) => { for (const a of apis.values()) a.endStreams(user); };

  /** Take the user's lease and start its Trader from the state in Redis. Concurrent claims for one user share one attempt. */
  const claim = (user: string): Promise<boolean> => {
    if (owned.has(user)) return Promise.resolve(true); if (draining) return Promise.resolve(false);
    const pending = claiming.get(user); if (pending) return pending;
    if (owned.size + claiming.size >= maxUsers) { m.refusedNoCapacity++; return Promise.resolve(false); }   // claims in flight count against the cap
    const p = (async () => {
      const lease = new UserLease(r, o.namespace, user, o.publicUrl, ttl), slots = new Map<string, Slot>();
      try {
        if (!lease.acquire()) return false;
        // every chain's account at once; one that fails (its RPC is down...) is retried later and does not keep the user's other chains from running
        const built = await Promise.allSettled(chains.map(c => build(user, lease, c)));
        built.forEach((b, i) => slots.set(chains[i].id, b.status === 'fulfilled' ? { acct: b.value } : { error: (b.reason as Error)?.message ?? String(b.reason), retryAt: Date.now() + RETRY_MS }));
        const errs = [...slots].filter(([, s]) => s.error).map(([c, s]) => `${c}: ${s.error}`);
        if (errs.length === chains.length) throw new Error(errs.join('; '));
        // the awaits above may outlast the TTL or a drain: only keep the user if the lease is still ours and we are not shutting down
        if (draining || !lease.renew()) throw new Error(draining ? 'node is draining' : 'lease expired while starting');
        for (const [c, s] of slots) if (s.acct) activate(user, c, s.acct);
        owned.set(user, { lease, slots }); m.claims++; m.chainErrors += errs.length;
        log(`owns ${user} (${owned.size} users)${errs.length ? `; unavailable for now: ${errs.join('; ')}` : ''}`); return true;
      } catch (e) { for (const s of slots.values()) stopAcct(s.acct); lease.release(); log(`could not start ${user}: ${(e as Error).message}`); return false; }
    })().finally(() => claiming.delete(user));
    claiming.set(user, p); return p;
  };
  const drop = (user: string, why: 'lost' | 'released') => {
    const x = owned.get(user); if (!x) return; owned.delete(user); for (const a of accountsOf(x)) stopAcct(a); endAllStreams(user);
    x.lease.release();   // also on 'lost': if a renewal merely errored the lease may still be ours, and holding it would lock the user out until the TTL
    if (why === 'released') m.released++; else { m.leasesLost++; log(`LOST the lease for ${user}: its Trader is stopped here`); }
  };
  // heartbeat for the status page: every node says it is alive (and how busy) every 5 s; the key expires 15 s after the last one
  const startedAt = Date.now();
  const activeOrders = () => { let n = 0; for (const x of owned.values()) for (const a of accountsOf(x)) n += a.trader.listOrders({ status: 'active' }).length; return n; };
  const heartbeat = () => { const orders = activeOrders();
    r.cmd('SET', nodeKey(o.namespace, o.publicUrl), JSON.stringify({ id: nodeId(o.publicUrl), startedAt, users: owned.size, orders, draining, webhooks: hooks.stats, history: history?.stats ?? null, at: Date.now() }), 'PX', '15000'); r.cmd('SADD', nodesKey(o.namespace), o.publicUrl); };
  heartbeat(); const beat = setInterval(() => { try { heartbeat(); } catch { /* the next beat retries */ } }, 5_000); beat.unref?.();
  let statusCache: { at: number; v: Awaited<ReturnType<typeof clusterStatus>> } | undefined;
  const status = async () => { if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.v; const v = await clusterStatus({ r, ns: o.namespace, history, checks: o.statusChecks ?? [] }); statusCache = { at: Date.now(), v }; return v; };
  const renewTimer = setInterval(() => {
    const list = [...owned]; let held: boolean[]; try { held = UserLease.renewAll(r, list.map(([, x]) => x.lease)); } catch { held = list.map(() => false); }
    list.forEach(([u], i) => { if (!held[i]) drop(u, 'lost'); });
  }, Math.max(500, Math.floor(ttl / 3)));
  const sweep = async () => {
    if (draining) return;
    const users = (r.cmd('SMEMBERS', usersKey(o.namespace)) as string[] | null ?? []).filter(u => !owned.has(u));
    const owners = ownersOf(r, o.namespace, users);
    for (let i = 0; i < users.length && owned.size + claiming.size < maxUsers; i++) if (!owners[i]) await claim(users[i]);
    // chains that failed to start for a user are retried here too, so standing orders on them resume without waiting for a request
    for (const [u, x] of owned) for (const [c, s] of x.slots) if (s.error) void revive(u, c);
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
    const orders = activeOrders(); let down = 0; for (const x of owned.values()) for (const s of x.slots.values()) if (s.error) down++;
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
    '# TYPE memedesk_webhooks_total counter', `memedesk_webhooks_total{result="delivered"} ${hooks.stats.delivered}`, `memedesk_webhooks_total{result="retried"} ${hooks.stats.retried}`, `memedesk_webhooks_total{result="failed"} ${hooks.stats.failed}`,
    '# TYPE memedesk_chain_accounts_unavailable gauge', `memedesk_chain_accounts_unavailable ${down}`,
    '# TYPE memedesk_draining gauge', `memedesk_draining ${draining ? 1 : 0}`, ''].join('\n');
    eld.reset(); return out;
  };
  /** Serve on this node with the chain's API; a /v1/<chain>/ prefix is taken off (the chain's API has the plain routes). */
  const serveLocal = (req: http.IncomingMessage, res: http.ServerResponse, at: { chain: string; rest?: string }) => {
    res.setHeader(NODE_HEADER, o.publicUrl); if (at.rest !== undefined) req.url = at.rest + new URL(req.url!, 'http://x').search;
    apis.get(at.chain)!.server.emit('request', req, res);
  };
  /** A user owned here: serve it, unless that chain's account is unavailable for now (tried again first when due). */
  const serveOwned = async (req: http.IncomingMessage, res: http.ServerResponse, user: string, at: { chain: string; rest?: string }) => {
    const s = owned.get(user)?.slots.get(at.chain); if (s?.error) await revive(user, at.chain);
    const now = owned.get(user)?.slots.get(at.chain);
    if (now?.error) return json(res, 503, { error: { code: 'chain_unavailable', message: `Your ${at.chain} account could not be started on this node: ${now.error}`, fix: `Retry in ${Math.ceil(RETRY_MS / 1000)} s; your other chains are not affected.` } }, { 'retry-after': String(Math.ceil(RETRY_MS / 1000)) });
    serveLocal(req, res, at);
  };
  const chainList = () => ({ default: defaultChain, chains: chains.map(c => ({ id: c.id, label: c.label ?? CHAIN_SPECS[c.id]?.label ?? c.id, prefix: `/v1/${c.id}/`, default: c.id === defaultChain })) });

  const server = http.createServer(async (req, res) => {
    try {
      // origin-form targets only ("/path"): "//host/..." or "http://host/..." would make forwarding reach a host the client chose
      if (!/^\/(?!\/)/.test(req.url ?? '')) return json(res, 400, { error: { code: 'bad_request', message: 'Request target must be a path.' } });
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/healthz') return json(res, 200, { ok: true, node: o.publicUrl, users: owned.size, chains: [...chainIds] });
      if (path === '/status.json' || path === '/status') { const s = await status(); if (path === '/status.json') return json(res, 200, s); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(statusHtml(s)); }
      if (path === '/readyz') { let ok = !draining; try { ok = ok && r.cmd('PING') === 'PONG'; } catch { ok = false; } return json(res, ok ? 200 : 503, { ready: ok, draining }); }
      if (path === '/metrics') { const body = metrics(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(body); }   // build first: a throw must not leave a half-sent response
      if (path === '/console' || path === '/') { res.writeHead(200, CONSOLE_HEADERS); return res.end(CONSOLE_HTML); }
      if (isSolanaSamplePath(path)) {
        if (!o.solanaSampleUrl || !isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) return json(res, 404, { error: { code: 'not_found', message: `No route ${path}.` } });
        return toTerminal(req, res, o.solanaSampleUrl);
      }
      m.requests++;
      const at = splitChain(path, chainIds, defaultChain);
      if ('unknown' in at) return json(res, 404, { error: { code: 'chain_not_enabled', message: `This server does not serve ${at.unknown}.`, fix: `Chains here: ${[...chainIds].join(', ')} (GET /v1/chains).` } });
      const plainPath = at.rest ?? path;
      if (plainPath === '/v1/chains') return json(res, 200, chainList());
      if (at.rest !== undefined && plainPath.startsWith('/v1/app/')) return json(res, 404, { error: { code: 'not_found', message: 'App routes are the same for every chain and have no chain prefix.', fix: `Call ${plainPath}.` } });
      const user = api.userOf(req);
      if (!user || plainPath === '/v1/health' || plainPath === '/v1/openapi.json') return serveLocal(req, res, at);   // unknown keys get the API's own 401
      if (!registered.has(user) && user.includes(':')) { const refuse = register(user); if (refuse) return json(res, 403, { error: refuse }); }
      if (owned.has(user)) return await serveOwned(req, res, user, at);
      const owner = ownerOf(r, o.namespace, user);
      if (owner && owner !== o.publicUrl) { if (req.headers[HOP]) return json(res, 503, { error: { code: 'routing_loop', message: 'Ownership is moving between nodes.', fix: 'Retry in a few seconds.' } }, { 'retry-after': '2' }); return toOwner(req, res, owner); }
      if (await claim(user)) return await serveOwned(req, res, user, at);
      const now = ownerOf(r, o.namespace, user); if (now && now !== o.publicUrl && !req.headers[HOP]) return toOwner(req, res, now);   // another node won the race
      return json(res, 503, { error: { code: draining ? 'draining' : 'no_capacity', message: draining ? 'This node is shutting down.' : 'No node has room for this account right now.', fix: 'Retry shortly; add nodes or raise MAX_USERS_PER_NODE if this persists.' } }, { 'retry-after': '5' });
    } catch (e) { log(`request failed: ${(e as Error).message}`); if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'The server could not complete this request.', fix: 'Retry; if it keeps failing, check the node log.' } }); else res.end(); }   // never leave a request hanging
  });
  const stopServing = async () => { draining = true; clearInterval(sweepTimer); clearInterval(renewTimer); eld.disable(); await Promise.allSettled([...claiming.values(), ...reviving.values()]); };
  const closeHttp = () => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); });

  return {
    server, owned, metrics: m, sweep, claim, chains: [...chainIds], defaultChain,
    listen: (port: number, host = '127.0.0.1') => new Promise<number>(ok => server.listen(port, host, () => ok((server.address() as any).port))),
    /** Graceful shutdown: stop claiming (after claims in progress settle), stop every Trader, release every lease (others take over at once), close HTTP and Redis. */
    async drain() { await stopServing(); hooks.stop(); clearInterval(beat); try { r.cmd('DEL', nodeKey(o.namespace, o.publicUrl)); } catch { /* going away anyway */ } await history?.stop().catch(() => {}); for (const u of [...owned.keys()]) drop(u, 'released'); await closeHttp(); for (const x of apis.values()) await x.close().catch(() => {}); r.close(); log('drained'); },
    /** Test hook: stop renewing and serving WITHOUT releasing (what a crashed or frozen node looks like to the others). */
    async crash() { await stopServing(); hooks.stop(); clearInterval(beat); history?.abort(); for (const x of owned.values()) for (const a of accountsOf(x)) stopAcct(a); owned.clear(); await closeHttp(); r.close(); },
  };
}

/** Which chain a path is for: `/v1/<chain>/rest` for a chain served here (rest = `/v1/rest`), `unknown` for a known chain that is not, else the default chain. */
export function splitChain(path: string, served: Set<string>, defaultChain: string): { chain: string; rest?: string } | { unknown: string } {
  const mt = /^\/v1\/([^/]+)(\/.*)$/.exec(path); if (!mt) return { chain: defaultChain };
  if (served.has(mt[1])) return { chain: mt[1], rest: '/v1' + mt[2] };
  if (CHAIN_SPECS[mt[1]] && !RESERVED_SEGMENTS.has(mt[1])) return { unknown: mt[1] };
  return { chain: defaultChain };
}

/** The node's chains: `o.chains`, or the one chain of `o.makeAccount`. Named chains are checked, and the namespace's default chain is pinned in Redis (chains.ts). */
function chainsOf(o: NodeOptions, r: SyncRedis): ChainAccounts[] {
  if (!o.chains?.length) { if (!o.makeAccount) throw new Error('createNode needs makeAccount or chains'); return [{ id: 'default', makeAccount: o.makeAccount, extraRoutes: o.extraRoutes }]; }
  if (o.makeAccount || o.extraRoutes) throw new Error('createNode: give chains OR makeAccount/extraRoutes, not both');
  const seen = new Set<string>();
  for (const c of o.chains) { if (!CHAIN_ID_RE.test(c.id) || RESERVED_SEGMENTS.has(c.id)) throw new Error(`chain id ${c.id} is not allowed`); if (seen.has(c.id)) throw new Error(`chain ${c.id} is listed twice`); seen.add(c.id); }
  const def = o.chains[0].id, key = defaultChainKey(o.namespace);
  if (r.cmd('GET', key) == null) {
    // first start of this namespace with chains: its unprefixed state belongs to whichever chain ran here before. Refuse if that was clearly another chain.
    const users = (r.cmd('SMEMBERS', `${o.namespace}:users`) as string[] | null) ?? [];
    const marks = [...o.chains.slice(1).flatMap(c => (c.legacyMarks ?? []).map(mark => ({ chain: c.id, mark }))), ...(o.otherLegacyMarks ?? []).filter(m => m.chain !== def)];
    for (const { chain, mark } of marks) for (const u of users)
      if (Number(r.cmd('EXISTS', `${o.namespace}:u:${u}:${mark}`)) === 1) throw new Error(`NAMESPACE ${o.namespace} holds ${chain} accounts from a single-chain server (user ${u} has ${mark}): ${o.chains.some(c => c.id === chain) ? `list ${chain} first in CHAINS` : `add ${chain} first in CHAINS, or use another NAMESPACE`}, so its state is not read as ${def}'s`);
    r.cmd('SET', key, def, 'NX');
  }
  const was = r.cmd('GET', key);
  if (was !== def) throw new Error(`NAMESPACE ${o.namespace} was started with ${was} as its default (first) chain, and its unprefixed state is ${was}'s: list ${was} first in CHAINS (now ${def}). Changing it needs a state migration.`);
  return o.chains;
}
