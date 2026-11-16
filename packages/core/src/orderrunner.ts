import { Reservations } from './reservations.ts';
import { OrderManager } from './orders.ts';
import type { Order, Snapshot } from './orders.ts';
import { Engine } from './engine.ts';
import type { ChainPort } from './port.ts';
import type { Intent, Venue } from './types.ts';
import { rep, rev } from './store.ts';
import { toBackend } from './durable.ts';
import type { Backend, Persist } from './durable.ts';

const TERMINAL = new Set(['finalized', 'failed', 'expired']);
const orderIdOf = (key: string) => key.startsWith('order:') ? key.slice(6, key.lastIndexOf(':a')) : undefined;

/**
 * Glue between price-triggered orders and a (possibly networked) chain: refreshes pool state, builds each order's Snapshot from real venue
 * reserves, hands fired intents to the Engine, and reports the engine outcome back to the OrderManager (bounded retries, reservation release).
 * Orders and reservations are in memory: after a restart re-place them. In-flight executions ARE durable (engine store) and are re-adopted by adopt();
 * re-placing an order reuses its idempotency keys, so it cannot execute twice.
 */
export class OrderRunner {
  orders: OrderManager; reservations: Reservations;
  inflight = new Map<string, string>();      // engine key -> order id
  lastVenueRefreshMs = 0; skipped = new Map<string, string>();   // order id -> why it could not be evaluated
  outbox: Intent[] = []; vetoed: string[] = []; private bal = new Map<string, bigint>();
  private backend?: Backend;
  constructor(private d: { engine: Engine; chain: ChainPort; clockMs: () => number; gate?: ConstructorParameters<typeof OrderManager>[4]; persistPath?: Persist;
    /** Optional veto at hand-over time (e.g. 'pause new automated entries'). A refused intent is NOT sent; the order is told it failed (bounded retries, reservation released). */
    entryGate?: (i: Intent) => boolean }) {
    this.reservations = new Reservations((w, t) => this.bal.get(`${w}:${t}`) ?? 0n);
    this.orders = new OrderManager(this.reservations, i => this.outbox.push(i), () => d.chain.time, d.clockMs, d.gate);
    this.backend = d.persistPath === undefined ? undefined : toBackend(d.persistPath);
    const saved = this.backend?.read();
    if (saved) {
      const o = JSON.parse(saved, rev); if (o.v !== 1) throw new Error(`unsupported order state version ${o.v}`);
      this.orders.load(o.orders); this.reservations.load(o.held); this.outbox = o.outbox; this.inflight = new Map(o.inflight);
    }
  }
  /** Atomically write all order state. No-op without persistPath. A write failure propagates: callers stop BEFORE acting (fail closed). */
  checkpoint() {
    if (!this.backend) return;
    this.backend.write(JSON.stringify({ v: 1, orders: this.orders.snapshot(), held: this.reservations.snapshot(), outbox: this.outbox, inflight: [...this.inflight] }, rep));
  }
  cancel(id: string) { this.orders.cancel(id); this.checkpoint(); }
  private async sync(wallet: string, token: string) {
    if (!this.d.chain.balanceOf) throw new Error('this chain cannot report balances; orders need balances to reserve against');
    this.bal.set(`${wallet}:${token}`, BigInt(await this.d.chain.balanceOf(wallet, token)));
  }
  /** Reserve against the CURRENT on-chain balance, then place. */
  async place(o: Order) {
    await this.d.chain.refresh?.('head');
    await this.sync(o.walletId, o.kind === 'limit_buy' ? o.quoteToken : o.token);
    const placed = this.orders.place(o); this.checkpoint(); return placed;
  }
  async refresh() { await this.d.chain.refresh?.('venues'); this.lastVenueRefreshMs = this.d.clockMs(); }

  /** Snapshot from the freshest pool state. Undefined (with a recorded reason) when the order cannot be honestly evaluated. */
  snapshot(o: Order): Snapshot | undefined {
    const sell = o.kind !== 'limit_buy', tin = sell ? o.token : o.quoteToken, tout = sell ? o.quoteToken : o.token;
    let best: { v: Venue; out: bigint; liq: bigint } | undefined;
    for (const v of this.d.chain.venues()) {
      if (v.status !== 'active' || !(o.venues.includes(v.id) || o.venues.includes(v.family)) || !v.supports(tin, tout)) continue;
      try { const q = v.quote(tin, tout, o.amount); if (!best || q.amountOut > best.out) best = { v, out: q.amountOut, liq: q.liquidity }; } catch { /* unquotable (e.g. no liquidity): skip venue */ }
    }
    if (!best) { this.skipped.set(o.id, 'no authorized venue can quote this order'); return undefined; }
    if (!best.v.spotPriceE18) { this.skipped.set(o.id, `venue ${best.v.id} cannot report a spot price`); return undefined; }
    this.skipped.delete(o.id);
    const { v } = best;
    // A one-direction venue (Jupiter) only reports a spot price the way it was built: when the token->quote price is unavailable, invert the quote->token one.
    const spot = (): bigint => { try { return v.spotPriceE18!(o.token, o.quoteToken); } catch { const inv = v.spotPriceE18!(o.quoteToken, o.token); return inv > 0n ? 10n ** 36n / inv : 0n; } };
    return { priceE18: spot(), ts: this.lastVenueRefreshMs, liquidity: best.liq, executableOut: od => { const s = od.kind !== 'limit_buy'; try { return v.quote(s ? od.token : od.quoteToken, s ? od.quoteToken : od.token, od.amount).amountOut; } catch { return 0n; } } };
  }

  /** One pass: refresh -> evaluate -> execute fired -> settle what is in flight. */
  async tick(): Promise<{ fired: string[]; submitted: string[] }> {
    try { await this.refresh(); } catch (e) { return { fired: [], submitted: [] }; /* node unreachable: evaluate nothing on stale data */ }
    const fired = this.orders.tick(o => this.snapshot(o));
    this.checkpoint();   // write-ahead: the fired state AND its intents are on disk before anything is submitted
    const submitted = await this.flushOutbox();
    await this.settle();
    return { fired, submitted };
  }
  /** Hand outbox intents to the engine (idempotent per key), then move them to in-flight. Safe to repeat after a crash. */
  private async flushOutbox(): Promise<string[]> {
    const done: string[] = [];
    for (const i of [...this.outbox]) {
      if (this.d.entryGate && !this.d.entryGate(i)) {
        this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey); const id = orderIdOf(i.idempotencyKey); if (id && this.orders.orders.has(id)) this.orders.onResult(id, false);
        this.vetoed.push(i.idempotencyKey); this.checkpoint(); continue;
      }
      await this.d.engine.submit(i);
      this.inflight.set(i.idempotencyKey, orderIdOf(i.idempotencyKey)!); this.outbox = this.outbox.filter(x => x.idempotencyKey !== i.idempotencyKey); done.push(i.idempotencyKey);
      this.checkpoint();
    }
    return done;
  }
  /** After a crash/restart: finish handing over the outbox, re-attach unfinished executions, settle. Call once after constructing with the same persistPath and engine store. */
  async resume() { await this.flushOutbox(); this.adopt(); this.checkpoint(); await this.settle(); }
  /** Re-attach to unfinished order executions after a restart. */
  adopt() { for (const [k, r] of this.d.engine.d.store.records) { const id = orderIdOf(k); if (id && !TERMINAL.has(r.state) && !this.inflight.has(k)) this.inflight.set(k, id); } }
  /** Advance in-flight executions; report outcomes to the OrderManager exactly once. */
  async settle() {
    for (const [key, id] of [...this.inflight]) {
      const r = await this.d.engine.advance(key);
      if (!TERMINAL.has(r.state)) continue;
      this.inflight.delete(key);
      const o = this.orders.orders.get(id); if (!o) { this.checkpoint(); continue; }
      this.orders.onResult(id, r.state === 'finalized');
      try { await this.sync(o.walletId, o.kind === 'limit_buy' ? o.quoteToken : o.token); } catch { /* balance refreshed on next place() */ }
      this.checkpoint();
    }
  }
}
