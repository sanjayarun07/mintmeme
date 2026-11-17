/** WEBHOOKS FOR APPS. An app (an `app` API key) sets one HTTPS URL; every event of every one of its end users (trades, orders, bulk, TWAP, alerts) is POSTed there
 *  by the node that runs that end user. Each delivery is signed so the app can check it came from us and is fresh:
 *    x-memedesk-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *    x-memedesk-event-id: <uuid>   (the same id on every retry: deduplicate on it)
 *  Delivery is at least once while the node runs: a non-2xx answer or a timeout is retried after 2 s, 10 s and 60 s. It is NOT durable: events still waiting when a node
 *  stops are dropped (the state itself is always readable through the API, and /v1/events streams the same events). The secret is kept in Redis (it must sign).
 *  Only https URLs to public hosts are accepted (no localhost or private-range IP literals), unless the server allows http for local testing. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { toJson } from '../../packages/sdk/src/wire.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { SyncRedis } from '../../packages/core/src/index.ts';
import type { Route } from '../api/server.ts';

export interface WebhookConfig { url: string; secret: string }
export interface WebhookOptions { fetchFn?: typeof fetch; allowHttp?: boolean; retryMs?: number[]; timeoutMs?: number; log?: (m: string) => void; cacheMs?: number }
const hookKey = (ns: string, app: string) => `${ns}:app:${app}:webhook`;
export const appUsersKey = (ns: string, app: string) => `${ns}:app:${app}:users`;

/** Refuse URLs that would make the server call itself or a private network (literal IPs and localhost; DNS names that resolve privately are not checked). */
export function checkWebhookUrl(raw: unknown, allowHttp = false): string {
  let u: URL; try { u = new URL(String(raw)); } catch { throw new SdkError('bad_url', 'url must be a full URL such as https://example.com/hooks/memedesk'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new SdkError('bad_url', 'webhook urls must use https');
  if (u.username || u.password) throw new SdkError('bad_url', 'webhook urls must not contain credentials');
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const priv = h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  if (priv && !allowHttp) throw new SdkError('bad_url', 'webhook urls must point at a public host');
  return u.toString();
}
export const signWebhook = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export class Webhooks {
  private cache = new Map<string, { at: number; v: WebhookConfig | null }>();
  stats = { delivered: 0, failed: 0, retried: 0, dropped: 0 }; private pending = new Set<ReturnType<typeof setTimeout>>(); private stopped = false;
  constructor(private r: SyncRedis, private ns: string, private o: WebhookOptions = {}) {}
  get(app: string): WebhookConfig | null {
    const c = this.cache.get(app); if (c && Date.now() - c.at < (this.o.cacheMs ?? 10_000)) return c.v;
    let v: WebhookConfig | null = null; try { const s = this.r.cmd('GET', hookKey(this.ns, app)); v = typeof s === 'string' ? JSON.parse(s) : null; } catch { v = c?.v ?? null; }
    this.cache.set(app, { at: Date.now(), v }); return v;
  }
  set(app: string, url: unknown, secret?: unknown): WebhookConfig {
    const s = secret === undefined ? 'whsec_' + randomBytes(24).toString('base64url') : String(secret);
    if (s.length < 16 || s.length > 200) throw new SdkError('bad_secret', 'secret must be 16 to 200 characters');
    const v = { url: checkWebhookUrl(url, this.o.allowHttp), secret: s }; this.r.cmd('SET', hookKey(this.ns, app), JSON.stringify(v)); this.cache.set(app, { at: Date.now(), v }); return v;
  }
  delete(app: string) { this.r.cmd('DEL', hookKey(this.ns, app)); this.cache.set(app, { at: Date.now(), v: null }); }
  /** Send one event for `user` (`<app>:<endUser>`) if its app has a webhook. Plain users (no app) have none. Returns the delivery promise (tests and /test await it). */
  emit(user: string, type: string, data: unknown): Promise<boolean> | undefined {
    const i = user.indexOf(':'); if (i < 0 || this.stopped) return undefined; const app = user.slice(0, i), cfg = this.get(app); if (!cfg) return undefined;
    const body = toJson({ id: randomUUID(), type, appId: app, userId: user.slice(i + 1), at: new Date().toISOString(), data });
    return this.deliver(cfg, body, JSON.parse(body).id, 0);
  }
  private async deliver(cfg: WebhookConfig, body: string, id: string, attempt: number): Promise<boolean> {
    const t = Math.floor(Date.now() / 1000);
    try {
      const r = await (this.o.fetchFn ?? fetch)(cfg.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.o.timeoutMs ?? 5_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'memedesk-webhooks/1', 'x-memedesk-event-id': id, 'x-memedesk-signature': `t=${t},v1=${signWebhook(cfg.secret, t, body)}` }, body });
      if (r.status >= 200 && r.status < 300) { this.stats.delivered++; return true; }
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      const waits = this.o.retryMs ?? [2_000, 10_000, 60_000];
      if (attempt >= waits.length || this.stopped) { this.stats.failed++; this.o.log?.(`webhook ${id} to ${new URL(cfg.url).host} failed for good: ${(e as Error).message}`); return false; }
      this.stats.retried++;
      return new Promise<boolean>(ok => { const h = setTimeout(() => { this.pending.delete(h); ok(this.deliver(cfg, body, id, attempt + 1)); }, waits[attempt]); h.unref?.(); this.pending.add(h); });
    }
  }
  /** Stop: retries still waiting are dropped (counted). */
  stop() { this.stopped = true; this.stats.dropped += this.pending.size; for (const h of this.pending) clearTimeout(h); this.pending.clear(); }
}

/** /v1/app/* routes (app keys only): the webhook, a test delivery, and the app's end users. */
export function appRoutes(h: Webhooks, r: SyncRedis, ns: string): Route[] {
  return [
    { method: 'GET', path: '/v1/app/webhook', scope: 'read', summary: 'The app\'s webhook URL (the secret is never shown again)', run: c => { const v = h.get(c.userId); return { url: v?.url ?? null, configured: !!v }; } },
    { method: 'PUT', path: '/v1/app/webhook', scope: 'trade', summary: 'Set the webhook. Returns the signing secret ONCE (generated unless you pass one)', body: 'url (https), secret? (16 to 200 characters)', run: c => h.set(c.userId, c.body?.url, c.body?.secret) },
    { method: 'DELETE', path: '/v1/app/webhook', scope: 'trade', summary: 'Stop sending webhooks', run: c => { h.delete(c.userId); return { configured: false }; } },
    { method: 'POST', path: '/v1/app/webhook/test', scope: 'trade', summary: 'Send a signed "ping" event now and report whether it was accepted (no retries)', run: async c => {
      const v = h.get(c.userId); if (!v) throw new SdkError('not_configured', 'no webhook is set', 'PUT /v1/app/webhook first.', 409);
      const t = Math.floor(Date.now() / 1000), body = toJson({ id: randomUUID(), type: 'ping', appId: c.userId, at: new Date().toISOString(), data: {} });
      try { const res = await fetch(v.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: { 'content-type': 'application/json', 'x-memedesk-signature': `t=${t},v1=${signWebhook(v.secret, t, body)}` }, body }); return { delivered: res.status >= 200 && res.status < 300, status: res.status }; }
      catch (e) { return { delivered: false, status: null, error: (e as Error).message }; }
    } },
    { method: 'GET', path: '/v1/app/users', scope: 'read', summary: 'The app\'s end users that have called the API (up to 1,000)', run: c => { const all = (r.cmd('SMEMBERS', appUsersKey(ns, c.userId)) as string[] | null) ?? []; return { users: all.slice(0, 1000).sort(), total: all.length }; } },
  ];
}
