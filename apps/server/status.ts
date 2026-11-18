/** STATUS PAGE and RECORD ROUTES.
 *  /status (HTML, refreshes itself) and /status.json on every node: the cluster as the nodes see it, safe to show publicly. No user data, no secrets, and node
 *  addresses are shown only as short hashes. Components: Redis, the nodes (each writes a heartbeat every 5 s; one not heard from for 15 s is down), Postgres
 *  (the trade record), and the host's own checks (Solana RPC, Jito, Privy). Trades in the last hour by outcome come from Postgres when it is configured.
 *  /v1/records/* (and /v1/app/records/* for an app's users) read the stored trade history and audit log. */
import { createHash } from 'node:crypto';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { SyncRedis } from '../../packages/core/src/index.ts';
import type { Route } from '../api/server.ts';
import type { History } from './history.ts';

export const nodeKey = (ns: string, url: string) => `${ns}:node:${url}`;
export const nodesKey = (ns: string) => `${ns}:nodes`;
export const nodeId = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 8);

export function recordRoutes(h: History | undefined, app = false): Route[] {
  const need = () => { if (!h) throw new SdkError('not_configured', 'this server keeps no trade history (no PG_URL)', 'Ask the operator to configure Postgres.', 501); return h; };
  const lim = (q: URLSearchParams) => (q.get('limit') === null ? undefined : Number(q.get('limit')));
  const base = app ? '/v1/app/records' : '/v1/records', who = app ? 'all end users of the app' : 'your account';
  return [
    { method: 'GET', path: `${base}/trades`, scope: 'read', summary: `Stored trade history of ${who}, newest first (query: limit up to 500, before = an updated_at to page back)`, run: c => need().tradesOf(c.userId, { limit: lim(c.query), before: c.query.get('before') ?? undefined, prefix: app }) },
    { method: 'GET', path: `${base}/audit`, scope: 'read', summary: `Audit log of ${who}: every call that changed something, newest first (query: limit up to 500, before = an id to page back). Secrets and signatures are never stored`, run: c => need().auditOf(c.userId, { limit: lim(c.query), before: c.query.get('before') ?? undefined, prefix: app }) },
  ];
}

type Level = 'ok' | 'degraded' | 'down';
export interface ClusterStatus {
  status: 'operational' | 'degraded' | 'down'; checkedAt: string;
  components: { name: string; status: Level; detail: string; ms: number | null }[];
  nodes: { id: string; users: number; orders: number; draining: boolean; uptimeS: number; lastSeenS: number }[];
  trades: { lastHour: Record<string, number>; successPct: number | null } | null;
  webhooks: { delivered: number; retried: number; failed: number };
}
export async function clusterStatus(o: { r: SyncRedis; ns: string; history?: History; checks: { name: string; run: () => Promise<unknown> }[] }): Promise<ClusterStatus> {
  const components: ClusterStatus['components'] = [], now = Date.now();
  const timed = async (name: string, f: () => Promise<string | void>, slowMs = 1500) => {
    const t = Date.now(); try { const d = await Promise.race([f(), new Promise<never>((_, no) => setTimeout(() => no(new Error('no answer in 5 s')), 5_000))]); const ms = Date.now() - t;
      components.push({ name, status: ms > slowMs ? 'degraded' : 'ok', detail: d || (ms > slowMs ? 'slow' : 'ok'), ms }); }
    catch (e) { components.push({ name, status: 'down', detail: (e as Error).message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 120), ms: null }); }
  };
  let nodes: ClusterStatus['nodes'] = [], hooks = { delivered: 0, retried: 0, failed: 0 };
  await timed('Redis', async () => { if (o.r.cmd('PING') !== 'PONG') throw new Error('unexpected reply'); });
  try {
    const urls = (o.r.cmd('SMEMBERS', nodesKey(o.ns)) as string[] | null) ?? [], vals = urls.length ? (o.r.cmd('MGET', ...urls.map(u => nodeKey(o.ns, u))) as (string | null)[]) : [];
    urls.forEach((u, i) => { const v = vals[i]; if (!v) { o.r.cmd('SREM', nodesKey(o.ns), u); return; } const j = JSON.parse(v);
      nodes.push({ id: j.id, users: j.users, orders: j.orders, draining: !!j.draining, uptimeS: Math.round((now - j.startedAt) / 1000), lastSeenS: Math.round((now - j.at) / 1000) });
      for (const k of ['delivered', 'retried', 'failed'] as const) hooks[k] += Number(j.webhooks?.[k] ?? 0); });
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    const live = nodes.filter(n => !n.draining).length;
    components.push({ name: 'Execution nodes', status: live === 0 ? 'down' : live < nodes.length ? 'degraded' : 'ok', detail: `${live} of ${nodes.length} serving`, ms: null });
  } catch (e) { components.push({ name: 'Execution nodes', status: 'down', detail: (e as Error).message.slice(0, 120), ms: null }); }
  let trades: ClusterStatus['trades'] = null;
  if (o.history) await timed('Trade history (Postgres)', async () => {
    const h = await o.history!.health(), done = (h.lastHour.finalized ?? 0), bad = (h.lastHour.failed ?? 0) + (h.lastHour.expired ?? 0);
    trades = { lastHour: h.lastHour, successPct: done + bad ? Math.round(done * 1000 / (done + bad)) / 10 : null };
    const st = o.history!.stats; if (st.buffered > 1_000 || (st.lastFlushAt && now - st.lastFlushAt > 30_000)) return `behind: ${st.buffered} records waiting`;
  });
  for (const c of o.checks) await timed(c.name, async () => { await c.run(); });
  const worst = components.some(c => c.status === 'down') ? 'down' : components.some(c => c.status !== 'ok') ? 'degraded' : 'ok';
  return { status: worst === 'ok' ? 'operational' : worst === 'degraded' || components.find(c => c.name === 'Execution nodes')?.status !== 'down' ? 'degraded' : 'down', checkedAt: new Date(now).toISOString(), components, nodes, trades, webhooks: hooks };
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export function statusHtml(s: ClusterStatus): string {
  const label = { operational: 'All systems operational', degraded: 'Some systems degraded', down: 'Major outage' }[s.status];
  const dot = (l: string) => `<span class="dot ${esc(l)}" aria-hidden="true"></span>`;
  const rows = s.components.map(c => `<tr><td>${dot(c.status)}${esc(c.name)}</td><td>${esc(c.status === 'ok' ? 'Operational' : c.status === 'degraded' ? 'Degraded' : 'Down')}</td><td class="muted">${esc(c.detail)}${c.ms !== null ? ` · ${c.ms} ms` : ''}</td></tr>`).join('');
  const nodes = s.nodes.map(n => `<tr><td class="mono">${esc(n.id)}</td><td>${n.draining ? 'Draining' : 'Serving'}</td><td>${n.users}</td><td>${n.orders}</td><td class="muted">${Math.floor(n.uptimeS / 3600)} h ${Math.floor(n.uptimeS % 3600 / 60)} m</td></tr>`).join('');
  const t = s.trades, trades = t ? `<p>${esc(t.successPct === null ? 'No trades finished in the last hour.' : `${t.successPct}% of trades in the last hour landed`)} <span class="muted">(${esc(Object.entries(t.lastHour).map(([k, v]) => `${v} ${k}`).join(', ') || 'none')})</span></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>Status</title>
<style>:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3dc;--ok:#2f7d4f;--warn:#b7791f;--bad:#b4362d}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9a9993;--line:#2c2b29;--ok:#5bbf86;--warn:#e0a54a;--bad:#ef6a5f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}
.banner{display:flex;gap:10px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-radius:8px;margin:20px 0 28px;font-weight:600}
table{width:100%;border-collapse:collapse;margin:8px 0 28px}td,th{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
h2{font-size:15px;margin:0}.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,monospace}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;vertical-align:1px}
.ok{background:var(--ok)}.degraded{background:var(--warn)}.down{background:var(--bad)}.operational{background:var(--ok)}</style></head><body><main>
<h1>Trading service status</h1><div class="muted">Checked ${esc(s.checkedAt.replace('T', ' ').slice(0, 19))} UTC · refreshes every 15 s · <a href="/status.json">JSON</a></div>
<div class="banner">${dot(s.status === 'operational' ? 'ok' : s.status)}${esc(label)}</div>
<h2>Components</h2><table><tbody>${rows}</tbody></table>
${trades ? `<h2>Trades</h2>${trades}` : ''}
<h2>Nodes</h2><table><thead><tr><th>Node</th><th>State</th><th>Accounts</th><th>Active orders</th><th>Up</th></tr></thead><tbody>${nodes || '<tr><td colspan="5" class="muted">No node has reported in.</td></tr>'}</tbody></table>
<p class="muted">Webhooks since the nodes started: ${s.webhooks.delivered} delivered, ${s.webhooks.retried} retried, ${s.webhooks.failed} failed.</p></main></body></html>`;
}
