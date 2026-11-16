/** IndexPort: where the app gets market data that an INDEXER can serve better than polled third-party APIs (recent trades for the whale feed and Buy Bot, later wallet history and holders).
 *  - `TradeSource` is the shape `TradeFeed` (GeckoTerminal polling) already had; the Whale page and the Buy Bot only use this shape, so any source that implements it can be swapped in.
 *  - `HttpTradeSource` is a client for OUR indexer's HTTP contract (docs/INDEXER_CONTRACT.md). The indexer service is a separate program; nothing here trusts what it returns beyond validating it.
 *  - `FallbackTradeSource` serves from the indexer while it is healthy and current, and from the third-party feed otherwise, saying which one answered.
 *  - `makeTradeSource` picks: no INDEX_URL -> the third-party feed exactly as before; INDEX_URL set -> indexer with the third-party feed as fallback.
 *  Read-only: nothing here signs or sends. */
import { TradeFeed } from './tradefeed.ts';
import type { FeedToken, FeedTrade, CycleResult } from './tradefeed.ts';
import type { InfoDeps } from './tokeninfo.ts';
export type { FeedToken, FeedTrade, CycleResult };

export interface SourceStatus {
  /** this source's own name */ name: string;
  /** which source actually answered the last cycle (differs from `name` on a fallback source) */ serving: string;
  /** ms timestamp of the last successful cycle, 0 if none */ lastOkAt: number;
  /** last failure, plain text; null when the last cycle worked */ lastError: string | null;
  /** how far the indexer is behind the chain head, in seconds, when it reports it */ lagS?: number;
}
export interface TradeSource {
  readonly name: string;
  readonly loaded: number; lastFill: number; recent: FeedTrade[]; errors: Map<string, string>;
  /** One cycle for these tokens. Returns only FRESH trades; the first sight of a pool is a silent baseline (fresh=false) so history is never announced as new. */
  pollCycle(tokens: FeedToken[]): Promise<CycleResult>;
  /** Newest-first trades of at least `minUsd`, optionally limited to chains. */
  query(minUsd?: number, chains?: string[], limit?: number): FeedTrade[];
  status(): SourceStatus;
}

/* ---------------- indexer over HTTP ---------------- */
export interface HttpOpts { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number; maxItems?: number }
const SIDES = new Set(['buy', 'sell']), CHAINS = new Set(['ethereum', 'bnb', 'solana']);
/** Validate one trade from the indexer. Untrusted input: wrong shape, a non-finite number or an unknown chain is dropped, never passed on. */
export function parseTrade(x: any, byPool: Map<string, FeedToken>): Omit<FeedTrade, 'fresh'> | null {
  if (!x || typeof x !== 'object') return null;
  const tok = typeof x.pool === 'string' ? byPool.get(x.pool.toLowerCase()) : undefined;
  if (!tok || !SIDES.has(x.side) || !CHAINS.has(x.chain) || x.chain !== tok.chain) return null;
  const usd = Number(x.usd); if (!Number.isFinite(usd) || usd < 0 || usd > 1e12) return null;
  if (typeof x.tx !== 'string' || !x.tx || x.tx.length > 100 || typeof x.wallet !== 'string' || !x.wallet || x.wallet.length > 100) return null;
  if (typeof x.t !== 'string' || !Number.isFinite(Date.parse(x.t))) return null;
  const key = `${x.tx}|${x.side}|${x.wallet}|${usd}`;
  return { t: new Date(x.t).toISOString(), side: x.side, wallet: x.wallet, usd, tx: x.tx, key, tokenId: tok.id, contract: tok.contract, sym: tok.sym, chain: tok.chain, pool: tok.pool, chg: tok.chg ?? null };
}
export class HttpTradeSource implements TradeSource {
  readonly name = 'our indexer'; recent: FeedTrade[] = []; errors = new Map<string, string>(); lastFill = 0;
  private seen = new Set<string>(); private pools = new Set<string>(); private lastOkAt = 0; private lastErr: string | null = null; private lagS: number | undefined; private sinceMs = 0;
  constructor(private base: string, private o: HttpOpts = {}) { if (!/^https?:\/\//.test(base)) throw new Error('INDEX_URL must start with http:// or https://'); this.base = base.replace(/\/+$/, ''); }
  get loaded() { return this.pools.size; }
  status(): SourceStatus { return { name: this.name, serving: this.name, lastOkAt: this.lastOkAt, lastError: this.lastErr, lagS: this.lagS }; }
  private async get(path: string): Promise<any> {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 8000);
    try { const r = await (this.o.fetchFn ?? fetch)(this.base + path, { signal: ctl.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`the indexer answered HTTP ${r.status}`); return await r.json(); }
    catch (e) { throw new Error((e as Error).name === 'AbortError' ? 'the indexer did not answer in time' : `the indexer is unreachable: ${(e as Error).message}`); }
    finally { clearTimeout(tm); }
  }
  async pollCycle(tokens: FeedToken[]): Promise<CycleResult> {
    const res: CycleResult = { fresh: [], polled: 0, errors: 0 }; if (!tokens.length) return res;
    const byPool = new Map(tokens.map(t => [t.pool.toLowerCase(), t])), max = this.o.maxItems ?? 2000, now = (this.o.now ?? Date.now)();
    try {
      const q = new URLSearchParams({ pools: [...byPool.keys()].join(','), limit: String(Math.min(max, 1000)) }); if (this.sinceMs) q.set('since', new Date(this.sinceMs).toISOString());
      const j = await this.get('/trades?' + q); if (!j || !Array.isArray(j.items)) throw new Error('the indexer answered with an unexpected shape');
      const lag = Number(j.health?.lagS); this.lagS = Number.isFinite(lag) && lag >= 0 ? lag : undefined;
      const items = j.items.slice(0, max).map((x: any) => parseTrade(x, byPool)).filter(Boolean) as Omit<FeedTrade, 'fresh'>[];
      items.sort((a, b) => (a.t < b.t ? -1 : 1));                                                    // oldest first, like the polling feed
      const baseline = new Set(tokens.map(t => t.pool.toLowerCase()).filter(p => !this.pools.has(p)));   // pools never seen before: their history is not announced
      for (const x of items) {
        const first = baseline.has(x.pool.toLowerCase()); if (this.seen.has(x.key)) continue; this.seen.add(x.key);
        const ft: FeedTrade = { ...x, fresh: !first }; this.recent.push(ft); if (ft.fresh) res.fresh.push(ft);
        this.sinceMs = Math.max(this.sinceMs, Date.parse(x.t));
      }
      for (const t of tokens) this.pools.add(t.pool.toLowerCase());
      if (!this.sinceMs) this.sinceMs = now - 1;                                                     // nothing seen yet: from now on, anything newer is fresh
      while (this.seen.size > 20000) this.seen.delete(this.seen.values().next().value as string);
      if (this.recent.length > 600) this.recent = this.recent.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 600);
      res.polled = tokens.length; this.lastOkAt = now; this.lastFill = now; this.lastErr = null; this.errors.clear();
    } catch (e) { this.lastErr = (e as Error).message; res.errors = 1; this.errors.set('indexer', this.lastErr); throw e; }
    return res;
  }
  query(minUsd = 0, chains?: string[], limit = 300): FeedTrade[] { return this.recent.filter(t => t.usd >= minUsd && (!chains || chains.includes(t.chain))).sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, limit); }
}

/* ---------------- indexer first, third party as fallback ---------------- */
export class FallbackTradeSource implements TradeSource {
  readonly name = 'indexer with third-party fallback'; private using: TradeSource; private primaryErr: string | null = null;
  constructor(private primary: TradeSource, private fallback: TradeSource, private o: { maxLagS?: number } = {}) { this.using = primary; }
  get loaded() { return this.using.loaded; }
  get lastFill() { return this.using.lastFill; } set lastFill(v: number) { this.primary.lastFill = v; this.fallback.lastFill = v; }
  get recent() { return this.using.recent; } set recent(v: FeedTrade[]) { this.using.recent = v; }
  get errors() { return this.using.errors; }
  /** The indexer answers while it is reachable and not too far behind the chain; any failure or a lag past `maxLagS` (default 60 s) sends this cycle to the third-party feed. The next cycle tries the indexer again. */
  async pollCycle(tokens: FeedToken[]): Promise<CycleResult> {
    try {
      const r = await this.primary.pollCycle(tokens), lag = this.primary.status().lagS;
      if (lag !== undefined && lag > (this.o.maxLagS ?? 60)) throw new Error(`the indexer is ${Math.round(lag)} s behind the chain`);
      this.using = this.primary; this.primaryErr = null; return r;
    } catch (e) { this.primaryErr = (e as Error).message; this.using = this.fallback; return this.fallback.pollCycle(tokens); }
  }
  query(minUsd?: number, chains?: string[], limit?: number) { return this.using.query(minUsd, chains, limit); }
  status(): SourceStatus { const s = this.using.status(); return { ...s, name: this.name, serving: this.using.name, lastError: this.primaryErr ?? s.lastError }; }
}

/** The trade source for this process. Without INDEX_URL: the third-party feed, exactly as before. With it: our indexer first, the third-party feed as fallback. */
export function makeTradeSource(deps: InfoDeps, o: { maxPoolsPerCycle?: number } = {}, env: Record<string, string | undefined> = process.env, http: HttpOpts = {}): TradeSource {
  const third = new TradeFeed(deps, o); const url = env.INDEX_URL?.trim(); if (!url) return third;
  return new FallbackTradeSource(new HttpTradeSource(url, http), third, { maxLagS: Number(env.INDEX_MAX_LAG_S) > 0 ? Number(env.INDEX_MAX_LAG_S) : 60 });
}
