/** Polling trade feed for REAL tokens, built on the GeckoTerminal client in tokeninfo.ts (third party, last ~300 trades per pool, sender address as reported, NOT re-verified on-chain).
 *  Rate limit: tokeninfo.ts already spaces every GeckoTerminal call 2.2 s apart process-wide; on top of that a cycle polls at most `maxPoolsPerCycle` pools, rotating through the list.
 *  The FIRST poll of a pool only records a baseline (kept in `recent` for display, flagged fresh=false) so history is never announced as new; later polls emit only unseen trades.
 *  Dedupe key: tx hash + side + wallet + size. Read-only: nothing is signed or sent. */
import { loadTrades } from './tokeninfo.ts';
import type { Trade, InfoDeps, TokenRef } from './tokeninfo.ts';
import type { TradeSource, SourceStatus } from './indexport.ts';

export interface FeedToken { id: string; sym: string; chain: TokenRef['chain']; contract: string; pool: string; pad: string | null; chg?: number | null }
export interface FeedTrade extends Trade { key: string; tokenId: string; contract: string; sym: string; chain: TokenRef['chain']; pool: string; chg: number | null; fresh: boolean }
export interface CycleResult { fresh: FeedTrade[]; polled: number; errors: number }

export class TradeFeed implements TradeSource {
  readonly name = 'third-party (GeckoTerminal)'; private lastOkAt = 0; private lastErr: string | null = null;
  private seen = new Map<string, Set<string>>(); private cursor = 0;
  recent: FeedTrade[] = []; errors = new Map<string, string>(); lastFill = 0;
  constructor(private deps: InfoDeps, private o: { maxPoolsPerCycle?: number; recentMax?: number; seenPerPool?: number } = {}) {}
  status(): SourceStatus { return { name: this.name, serving: this.name, lastOkAt: this.lastOkAt, lastError: this.lastErr }; }
  /** Pools that have been polled at least once. */
  get loaded() { return this.seen.size; }
  async pollPool(t: FeedToken): Promise<FeedTrade[]> {
    const r = await loadTrades({ chain: t.chain, contract: t.contract, pool: t.pool, pad: t.pad }, this.deps);
    const first = !this.seen.has(t.pool), set = this.seen.get(t.pool) ?? new Set<string>(); this.seen.set(t.pool, set); const out: FeedTrade[] = [];
    for (const x of [...r.items].reverse()) {   // the feed lists newest first; emit oldest first
      const key = `${x.tx}|${x.side}|${x.wallet}|${x.usd}`; if (set.has(key)) continue; set.add(key);
      const ft: FeedTrade = { ...x, key, tokenId: t.id, contract: t.contract, sym: t.sym, chain: t.chain, pool: t.pool, chg: t.chg ?? null, fresh: !first };
      this.recent.push(ft); if (!first) out.push(ft);
    }
    const cap = this.o.seenPerPool ?? 1000; while (set.size > cap) set.delete(set.values().next().value as string);
    const max = this.o.recentMax ?? 600; if (this.recent.length > max) this.recent = this.recent.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, max);
    this.errors.delete(t.pool); this.lastOkAt = (this.deps.now ?? Date.now)(); this.lastErr = null; return out;
  }
  /** One cycle: polls the next `maxPoolsPerCycle` pools. A rate-limit answer ends the cycle early; other errors are recorded per pool and the cycle goes on. */
  async pollCycle(tokens: FeedToken[]): Promise<CycleResult> {
    const res: CycleResult = { fresh: [], polled: 0, errors: 0 }; if (!tokens.length) return res;
    const n = Math.min(this.o.maxPoolsPerCycle ?? 4, tokens.length);
    for (let i = 0; i < n; i++) {
      const tok = tokens[(this.cursor + i) % tokens.length];
      try { res.fresh.push(...await this.pollPool(tok)); res.polled++; }
      catch (e) { const m = (e as Error).message; this.errors.set(tok.pool, m); this.lastErr = m; res.errors++; if (/rate limited/i.test(m)) { this.cursor = (this.cursor + i) % tokens.length; return res; } }
    }
    this.cursor = (this.cursor + n) % tokens.length; this.lastFill = (this.deps.now ?? Date.now)(); return res;
  }
  /** Newest-first trades of at least `minUsd`, optionally limited to chains. */
  query(minUsd = 0, chains?: string[], limit = 300): FeedTrade[] { return this.recent.filter(t => t.usd >= minUsd && (!chains || chains.includes(t.chain))).sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, limit); }
}
