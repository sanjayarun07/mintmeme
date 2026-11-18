/** TRADE HISTORY AND AUDIT LOG IN POSTGRES (optional: PG_URL). Redis stays the source of truth for running accounts; Postgres is the long-term record:
 *   - trades: one row per trade (upserted as its state changes: quoted, signed, submitted, finalized or failed) with its fill, and trade_states for every change;
 *   - audit_log: one row per API call that changes something (POST, PUT, PATCH, DELETE): who (account and key id), what (method, path, a summary of the body with
 *     secrets and signatures removed), the answer's status, how long it took, and which node served it.
 *  Writes are buffered and flushed in batches every second, never on the trading path: if Postgres is slow or down, trading continues and the buffer waits (bounded;
 *  the oldest entries are dropped beyond `maxBuffer`, and counted). Rows can therefore arrive a moment after the event, and a node that crashes loses its last
 *  unflushed second. */
import { PgClient } from '../../packages/core/src/pg.ts';
import type { TradeView } from '../../packages/sdk/src/trader.ts';

export interface AuditEntry { userId: string; keyId: string; method: string; path: string; status: number; ms: number; node: string; body?: Record<string, unknown>; ip?: string }
const SCHEMA = [
  `create table if not exists trades (key text primary key, user_id text not null, wallet text, chain text, origin text, token_in text, token_out text, amount_in numeric,
     state text not null, venue text, tx_hash text, failure text, fill jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create index if not exists trades_user_time on trades (user_id, updated_at desc)`,
  `create table if not exists trade_states (id bigserial primary key, key text not null, user_id text not null, state text not null, at timestamptz not null default now())`,
  `create index if not exists trade_states_key on trade_states (key, id)`,
  `create table if not exists audit_log (id bigserial primary key, at timestamptz not null default now(), user_id text not null, key_id text, node text, method text not null,
     path text not null, status int not null, ms int, body jsonb, ip text)`,
  `create index if not exists audit_user_time on audit_log (user_id, at desc)`,
];
/** Body fields never stored in the audit log. */
const SECRET = /secret|signature|password|apikey|authkey|private|seed|mnemonic/i;
export function auditBody(b: unknown): Record<string, unknown> | undefined {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined; const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) { if (k.startsWith('__')) continue; out[k] = SECRET.test(k) ? '[removed]' : typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : typeof v === 'bigint' ? v.toString() : v; }
  return out;
}

export class History {
  private pg: PgClient; private trades = new Map<string, { user: string; v: TradeView }>(); private states: [string, string, string][] = []; private audits: AuditEntry[] = [];
  private timer?: ReturnType<typeof setInterval>; private flushing = false;
  stats = { written: 0, dropped: 0, errors: 0, lastError: '' as string, lastFlushAt: 0, buffered: 0 };
  constructor(url: string, private o: { flushMs?: number; maxBuffer?: number; log?: (m: string) => void } = {}) { this.pg = new PgClient(url); }
  async start() { for (const s of SCHEMA) await this.pg.query(s); this.timer = setInterval(() => { void this.flush(); }, this.o.flushMs ?? 1000); this.timer.unref?.(); }
  async stop() { clearInterval(this.timer); await this.flush(); await this.pg.close(); }
  /** Stop at once without writing what is buffered (what a crashed node looks like). */
  abort() { clearInterval(this.timer); void this.pg.close(); }

  recordTrade(user: string, v: TradeView | undefined) {
    if (!v) return; const prev = this.trades.get(v.key); if (!prev || prev.v.state !== v.state) this.states.push([v.key, user, v.state]);
    this.trades.set(v.key, { user, v }); this.bound();
  }
  audit(e: AuditEntry) { this.audits.push(e); this.bound(); }
  private bound() {
    const max = this.o.maxBuffer ?? 10_000;
    while (this.audits.length + this.states.length + this.trades.size > max) { if (this.audits.length) this.audits.shift(); else if (this.states.length) this.states.shift(); else this.trades.delete(this.trades.keys().next().value!); this.stats.dropped++; }
    this.stats.buffered = this.audits.length + this.states.length + this.trades.size;
  }
  /** Write everything buffered, in batches of up to 500 rows per statement. On failure the batch is put back (and retried next second). */
  async flush() {
    if (this.flushing) return; this.flushing = true;
    try {
      while (this.trades.size) {
        const batch = [...this.trades.entries()].slice(0, 500), p: unknown[] = [];
        const vals = batch.map(([, { user, v }], i) => { p.push(v.key, user, v.walletId, null, v.origin, v.tokenIn, v.tokenOut, v.amountIn.toString(), v.state, v.venue ?? null, v.txHash ?? null, v.failure ?? null, v.fill ?? null); const b = i * 13; return `(${Array.from({ length: 13 }, (_, k) => `$${b + k + 1}`).join(',')})`; });
        await this.pg.query(`insert into trades (key,user_id,wallet,chain,origin,token_in,token_out,amount_in,state,venue,tx_hash,failure,fill) values ${vals.join(',')}
          on conflict (key) do update set state=excluded.state, venue=coalesce(excluded.venue,trades.venue), tx_hash=coalesce(excluded.tx_hash,trades.tx_hash), failure=excluded.failure, fill=coalesce(excluded.fill,trades.fill), updated_at=now()`, p);
        for (const [k, x] of batch) if (this.trades.get(k) === x) this.trades.delete(k); this.stats.written += batch.length;
      }
      while (this.states.length) {
        const batch = this.states.slice(0, 500), p = batch.flat();
        await this.pg.query(`insert into trade_states (key,user_id,state) values ${batch.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(',')}`, p);
        this.states.splice(0, batch.length); this.stats.written += batch.length;
      }
      while (this.audits.length) {
        const batch = this.audits.slice(0, 500), p: unknown[] = [];
        const vals = batch.map((e, i) => { p.push(e.userId, e.keyId, e.node, e.method, e.path, e.status, Math.round(e.ms), e.body ?? null, e.ip ?? null); const b = i * 9; return `(${Array.from({ length: 9 }, (_, k) => `$${b + k + 1}`).join(',')})`; });
        await this.pg.query(`insert into audit_log (user_id,key_id,node,method,path,status,ms,body,ip) values ${vals.join(',')}`, p);
        this.audits.splice(0, batch.length); this.stats.written += batch.length;
      }
      this.stats.lastFlushAt = Date.now();
    } catch (e) { this.stats.errors++; this.stats.lastError = (e as Error).message.slice(0, 200); this.o.log?.(`history: write failed, will retry: ${this.stats.lastError}`); }
    finally { this.flushing = false; this.stats.buffered = this.audits.length + this.states.length + this.trades.size; }
  }
  /** Newest first. `prefix` (an app id) reads every end user of that app. */
  async tradesOf(user: string, o: { limit?: number; before?: string; prefix?: boolean } = {}) {
    const lim = Math.min(500, Math.max(1, o.limit ?? 50));
    const r = await this.pg.query(`select key,user_id,wallet,origin,token_in,token_out,amount_in,state,venue,tx_hash,failure,fill,created_at,updated_at from trades
      where ${o.prefix ? '(user_id = $1 or user_id like $1 || \':%\')' : 'user_id = $1'} and ($2::timestamptz is null or updated_at < $2::timestamptz) order by updated_at desc limit ${lim}`, [user, o.before ?? null]);
    return r.rows.map(x => ({ ...x, fill: x.fill ? JSON.parse(x.fill) : null }));
  }
  async auditOf(user: string, o: { limit?: number; before?: string; prefix?: boolean } = {}) {
    const lim = Math.min(500, Math.max(1, o.limit ?? 50));
    const r = await this.pg.query(`select id,at,user_id,key_id,node,method,path,status,ms,body from audit_log where ${o.prefix ? '(user_id = $1 or user_id like $1 || \':%\')' : 'user_id = $1'}
      and ($2::bigint is null or id < $2::bigint) order by id desc limit ${lim}`, [user, o.before ?? null]);
    return r.rows.map(x => ({ ...x, body: x.body ? JSON.parse(x.body) : null }));
  }
  /** For the status page: trades in the last hour by final state, and a round trip time. */
  async health() {
    const t = Date.now(); const r = await this.pg.query(`select state, count(*)::int as n from trades where updated_at > now() - interval '1 hour' and state in ('finalized','failed','expired') group by state`);
    return { ms: Date.now() - t, lastHour: Object.fromEntries(r.rows.map(x => [x.state!, Number(x.n)])) as Record<string, number> };
  }
}
