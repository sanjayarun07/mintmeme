import { CopyEngine } from './copy.ts';
import type { CopyConfig, LeaderEvent, Market } from './copy.ts';
import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent, Venue } from './types.ts';
import { rep, rev } from './store.ts';
import { toBackend } from './durable.ts';
import type { Backend, Persist } from './durable.ts';

const TERMINAL = new Set(['finalized', 'failed', 'expired']);
/** Where leader events come from (e.g. evm LeaderWatcher). poll() may throw; progress must only advance for what it returned. */
export interface LeaderSource {
  poll(): Promise<{ events: LeaderEvent[]; reorged: { chain: string; txHash: string }[] }>;
  snapshot(): unknown; load(s: any): void;
}

/**
 * Glue between a leader-event source, the CopyEngine rules, and the (possibly networked) execution Engine.
 * One tick = refresh pools -> poll leaders -> apply reorgs and events -> WRITE-AHEAD checkpoint -> hand intents to the engine -> settle outcomes.
 * Durable (persistPath): copy attribution state, outbox, in-flight keys and the source cursor are one atomic file, so a crash at any point either
 * re-reads the same blocks (events dedupe by tx:logIndex) or re-submits the same idempotency keys; a trade can never be copied twice.
 * Rules on purpose: one confirmation policy and one quote token per (chain); no automatic selling on a leader reorg (positions are flagged 'orphaned').
 */
export class CopyRunner {
  copy: CopyEngine; outbox: Intent[] = []; inflight = new Set<string>(); lastError?: string;
  private backend?: Backend;
  constructor(private d: { engine: Engine; chain: ChainPort; source: LeaderSource; cfgs: CopyConfig[]; persistPath?: Persist; probeAmount?: bigint;
    /** Optional per-token data the chain port does not have (market cap in quote units, measured taxes). Absent fields make configured checks skip the buy. */
    info?: (chain: string, token: string) => { marketCap?: bigint; buyTaxBps?: number; sellTaxBps?: number } | undefined }) {
    const quotes = new Set(d.cfgs.map(c => `${c.chain}|${c.quoteToken}`)); if (quotes.size > new Set(d.cfgs.map(c => c.chain)).size) throw new Error('all copy configs on one chain must use the same quote token');
    this.copy = new CopyEngine(d.cfgs, (chain, token) => this.market(chain, token), i => { this.outbox.push(i); }, () => d.chain.time);
    this.backend = d.persistPath === undefined ? undefined : toBackend(d.persistPath);
    const saved = this.backend?.read();
    if (saved) {
      const o = JSON.parse(saved, rev); if (o.v !== 1) throw new Error(`unsupported copy state version ${o.v}`);
      this.copy.load(o.copy); this.outbox = o.outbox; this.inflight = new Set(o.inflight); d.source.load(o.source);
    }
  }
  checkpoint() {
    if (!this.backend) return;
    this.backend.write(JSON.stringify({ v: 1, copy: this.copy.snapshot(), outbox: this.outbox, inflight: [...this.inflight], source: this.d.source.snapshot() }, rep));
  }
  /** Price and depth from the freshest pool state. No authorised venue can quote it = zero liquidity = the copy is skipped (fail closed). */
  private market(chain: string, token: string): Market {
    const cfgs = this.d.cfgs.filter(c => c.chain === chain), quote = cfgs[0]?.quoteToken; if (!quote) return { priceE18: 0n, liquidity: 0n };
    const allowed = new Set(cfgs.flatMap(c => c.venues)); let best: Market | undefined; let bestV: Venue | undefined;
    for (const v of this.d.chain.venues()) {
      if (v.status !== 'active' || !(allowed.has(v.id) || allowed.has(v.family)) || !v.supports(quote, token) || !v.spotPriceE18) continue;
      try { const q = v.quote(quote, token, this.d.probeAmount ?? 10n ** 12n); const m = { priceE18: v.spotPriceE18(token, quote), liquidity: q.liquidity }; if (!best || m.liquidity > best.liquidity) { best = m; bestV = v; } } catch { /* unquotable */ }
    }
    if (!best || !bestV) return { priceE18: 0n, liquidity: 0n };
    const v = bestV, extra = this.d.info?.(chain, token);
    // price impact for the amount the copy would actually spend, from the same venue that supplies the price; a throwing quote is "unavailable"
    return { ...best, ...(extra ?? {}), impactBps: (amt: bigint) => { try { return v.quote(quote, token, amt).priceImpactBps; } catch { return undefined; } } };
  }

  async tick(): Promise<{ events: number; reorged: number; submitted: string[]; error?: string }> {
    try { await this.d.chain.refresh?.('venues'); } catch (e) { this.lastError = `node unreachable: ${(e as Error).message}`; await this.settle().catch(() => {}); return { events: 0, reorged: 0, submitted: [], error: this.lastError }; }
    let r: Awaited<ReturnType<LeaderSource['poll']>>;
    try { r = await this.d.source.poll(); } catch (e) { this.lastError = `leader scan failed: ${(e as Error).message}`; await this.settle(); return { events: 0, reorged: 0, submitted: [], error: this.lastError }; }
    this.lastError = undefined;
    for (const x of r.reorged) this.copy.onReorg(x.chain, x.txHash);
    for (const e of r.events) this.copy.onEvent(e);
    this.checkpoint();                       // write-ahead: attribution state, cursor and intents hit disk before anything is submitted
    const submitted = await this.flushOutbox(); await this.settle();
    return { events: r.events.length, reorged: r.reorged.length, submitted };
  }
  private async flushOutbox() {
    const done: string[] = [];
    for (const i of [...this.outbox]) {
      await this.d.engine.submit(i);
      this.inflight.add(i.idempotencyKey); this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey); done.push(i.idempotencyKey); this.checkpoint();
    }
    return done;
  }
  /** After a restart with the same persistPath and engine store: finish the hand-over, re-attach, settle. */
  async resume() { await this.flushOutbox(); this.adopt(); this.checkpoint(); await this.settle(); }
  adopt() { for (const [k, r] of this.d.engine.d.store.records) if (k.startsWith('copy:') && !TERMINAL.has(r.state) && !k.endsWith(':approve') && !this.inflight.has(k) && this.copy.intentInfo(k)) this.inflight.add(k); }
  /** Advance in-flight copies; attribute each outcome to the leader exactly once (the checkpoint removes it from inflight in the same write). */
  async settle() {
    for (const key of [...this.inflight]) {
      const r = await this.d.engine.advance(key); if (!TERMINAL.has(r.state)) continue;
      const info = this.copy.intentInfo(key);
      if (info) {
        if (r.state === 'finalized' && r.fill) {
          if (info.side === 'buy') this.copy.recordFill(info.c, info.token, 'buy', r.fill.received, r.fill.spent, '', key);
          else this.copy.recordFill(info.c, info.token, 'sell', r.fill.spent, r.fill.received, '', key);
        } else this.copy.recordFailure(key);
      }
      this.inflight.delete(key); this.checkpoint();
    }
  }
}
