/** The Trader: one object that exposes the whole execution engine (market buy and sell, limit buy and sell, take profit, stop loss, trailing stop, brackets, bulk buy and sell, TWAP,
 *  launch sniping, copy trading, price alerts, portfolio) with validated inputs, idempotency and the same safety rules as the Telegram bot and the terminal: every trade is an
 *  Engine intent, so the wallet policy signer (per-tx and daily limits, allowed venues, automation switch), write-ahead checkpoints and idempotency keys apply to ALL of it.
 *  The Trader adds no trading logic of its own. It owns the runners, drives them (`tick()` or `start()`), and reports what happened as events. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE, rep, rev, fileBackend, OrderRunner, BulkRunner, TwapRunner, SnipeRunner, CopyRunner, Portfolio, PriceAlerts, splitEqual, MAX_BULK_WALLETS, MAX_TWAP_SLICES } from '../../core/src/index.ts';
import type { Backend, Engine, ChainPort, Intent, Order, OrderKind, Fill, TxRecord, BulkSpec, TwapSpec, BulkSummary, TwapSummary, SnipeConfig, CopyConfig, LaunchSource, LeaderSource, Launch, SupplyInfo } from '../../core/src/index.ts';
import { SdkError, amount, int, id as idOf } from './wire.ts';

export type Amount = bigint | string | number;
export interface TraderConfig {
  engine: Engine; chain: ChainPort; userId: string;
  /** The token the platform prices everything in. Default: the chain's native token. */
  quoteToken?: string;
  /** Venue ids or families this Trader may use. Required: the engine only routes through venues you name (the wallet policy must also allow them). */
  venues: string[];
  clockMs?: () => number;
  /** Practice chains have no clock of their own: pass a function that mines blocks so trades can confirm. Real chains leave this out (the network produces blocks). */
  advanceChain?: () => void | Promise<void>;
  /** Directory for durable runner state. Without it everything is in memory and a restart forgets orders, bulk and TWAP jobs (in-flight trades are still safe: the engine store is the record). */
  persistDir?: string;
  /** Where durable state goes when it is not a folder: a function that returns a Backend for a name such as "orders", "trader" or "bulk-b1" (for example `name => redisState.backend(name)`). Wins over persistDir. */
  state?: (name: string) => Backend;
  /** Plan limits: called before an order is placed with the user's active order count. */
  orderGate?: ConstructorParameters<typeof OrderRunner>[0]['gate'];
  defaults?: { slippageBps?: number; orderTtlS?: number; maxDeviationBps?: number; maxAttempts?: number; maxQuoteAgeMs?: number; minLiquidity?: bigint };
}
export interface TradeView { key: string; state: string; walletId: string; origin: string; tokenIn: string; tokenOut: string; amountIn: bigint; fill?: Fill; venue?: string; txHash?: string; failure?: string; history: { state: string; note?: string }[] }
export interface QuoteView { venue: string; amountOut: bigint; minOut: bigint; priceImpactBps: number; platformFee: bigint; venueFee: bigint; liquidity: bigint; alternatives: { venue: string; amountOut: bigint }[] }
export type TraderEvent =
  | { type: 'trade'; key: string; state: string; walletId: string; origin: string; failure?: string }
  | { type: 'order'; id: string; status: Order['status']; reason?: string; attempts: number }
  | { type: 'bulk'; id: string; filled: number; failed: number; skipped: number; open: number; done: boolean }
  | { type: 'twap'; id: string; filled: number; failed: number; skipped: number; open: number; done: boolean }
  | { type: 'snipe'; id: string; launch: string; status: string }
  | { type: 'alert'; id: string; token: string; direction: 'above' | 'below'; threshold: number; price: number }
  | { type: 'error'; where: string; message: string };

const TERMINAL = new Set(['finalized', 'failed', 'expired']);
const E18 = 10n ** 18n;

export class Trader {
  readonly orders: OrderRunner; readonly portfolio: Portfolio; readonly alerts = new PriceAlerts();
  readonly bulks = new Map<string, BulkRunner>(); private readonly sides = new Map<string, 'buy' | 'sell'>(); readonly twaps = new Map<string, TwapRunner>(); readonly snipes = new Map<string, SnipeRunner>(); readonly copies = new Map<string, CopyRunner>();
  private paused = false; private listeners = new Set<(e: TraderEvent) => void>(); private timer?: ReturnType<typeof setInterval>; private busy = false; private seen = new Map<string, string>();
  private priceAlertSpecs = new Map<string, { token: string }>(); readonly quoteToken: string; readonly userId: string;
  constructor(private c: TraderConfig) {
    this.quoteToken = c.quoteToken ?? NATIVE; this.userId = c.userId;
    if (!c.venues?.length) throw new SdkError('config', 'venues is required: name the venue ids or families this trader may route through (for example ["uniswap-v2"])');
    if (c.persistDir) mkdirSync(c.persistDir, { recursive: true });
    this.orders = new OrderRunner({ engine: c.engine, chain: c.chain, clockMs: c.clockMs ?? Date.now, gate: c.orderGate, persistPath: this.store('orders'),
      entryGate: i => !(this.paused && i.tokenIn === this.quoteToken) });
    this.portfolio = new Portfolio([this.quoteToken]);
    this.meta = this.store('trader'); this.loadMeta();
  }
  private meta?: Backend;
  /** The durable store for one named piece of state, or undefined when this Trader is in-memory only. */
  private store(name: string): Backend | undefined { return this.c.state ? this.c.state(name) : this.c.persistDir ? fileBackend(join(this.c.persistDir, `${name}.json`)) : undefined; }
  /** Account-level state that nothing else owns: the pause switch, price alerts (with armed/active), and the bulk and TWAP jobs so a restart can find them again. Written before the change is reported. */
  private saveMeta() {
    if (!this.meta) return;
    this.meta.write(JSON.stringify({ v: 1, paused: this.paused, alerts: this.alerts.snapshot(), alertTokens: [...this.priceAlertSpecs], bulks: [...this.bulks].map(([id, r]) => ({ id, side: this.sides.get(`bulk:${id}`), spec: r.spec })), twaps: [...this.twaps].map(([id, r]) => ({ id, side: this.sides.get(`twap:${id}`), spec: r.spec })) }, rep));
  }
  private loadMeta() {
    const raw = this.meta?.read(); if (!raw) return;
    const m = JSON.parse(raw, rev); if (m.v !== 1) throw new SdkError('state_version', `unsupported trader state version ${m.v}`);
    this.paused = !!m.paused; this.alerts.load(m.alerts ?? []); this.priceAlertSpecs = new Map(m.alertTokens ?? []);
    for (const b of m.bulks ?? []) { this.bulks.set(b.id, new BulkRunner({ engine: this.c.engine, chain: this.c.chain, spec: b.spec, persistPath: this.path('bulk', b.id) })); if (b.side) this.sides.set(`bulk:${b.id}`, b.side); }
    for (const t of m.twaps ?? []) { this.twaps.set(t.id, new TwapRunner({ engine: this.c.engine, chain: this.c.chain, spec: t.spec, persistPath: this.path('twap', t.id) })); if (t.side) this.sides.set(`twap:${t.id}`, t.side); }
  }
  private get chain() { return this.c.chain; }
  private get engine() { return this.c.engine; }
  private d() { return { slippageBps: 300, orderTtlS: 7 * 86_400, maxDeviationBps: 1500, maxAttempts: 3, maxQuoteAgeMs: 15_000, minLiquidity: 0n, ...this.c.defaults }; }
  private path(kind: string, id: string) { return this.store(`${kind}-${id}`); }
  private slip(v: unknown) { return v === undefined ? this.d().slippageBps : int(v, 'slippageBps', 0, 5000); }

  // ───────────────────────── events ─────────────────────────
  on(fn: (e: TraderEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(e: TraderEvent) { for (const f of this.listeners) { try { f(e); } catch { /* a listener must not break the engine loop */ } } }
  private changed(key: string, sig: string) { if (this.seen.get(key) === sig) return false; this.seen.set(key, sig); return true; }

  // ───────────────────────── market trades ─────────────────────────
  private intent(p: { key?: string; walletId: string; side: 'buy' | 'sell'; token: string; amount: bigint; slippageBps?: unknown; minOut?: unknown; deadlineS?: unknown; maxFeeBps?: unknown; origin?: Intent['origin'] }): Intent {
    const sell = p.side === 'sell'; const tok = idOf(p.token, 'token');
    return { idempotencyKey: p.key ? idOf(p.key, 'key') : `m-${randomUUID()}`, userId: this.userId, walletId: idOf(p.walletId, 'walletId'), chain: this.chain.id, tokenIn: sell ? tok : this.quoteToken, tokenOut: sell ? this.quoteToken : tok,
      amountIn: p.amount, minOut: p.minOut === undefined ? 0n : amount(p.minOut, 'minOut', { allowZero: true }), slippageBps: this.slip(p.slippageBps), deadline: this.chain.time + (p.deadlineS === undefined ? 120 : int(p.deadlineS, 'deadlineS', 10, 3600)),
      maxFeeBps: p.maxFeeBps === undefined ? 200 : int(p.maxFeeBps, 'maxFeeBps', 0, 1000), venues: this.c.venues, origin: p.origin ?? 'manual' };
  }
  /** What a market trade would return right now, from the best authorized venue. Nothing is sent. */
  async quote(p: { side: 'buy' | 'sell'; token: string; amount: Amount; slippageBps?: number; walletId?: string }): Promise<QuoteView> {
    await this.chain.refresh?.('venues');
    const i = this.intent({ walletId: p.walletId ?? 'quote', side: p.side, token: p.token, amount: amount(p.amount, 'amount'), slippageBps: p.slippageBps });
    let r; try { r = this.engine.d.router.route(i, this.engine.d.platformFeeBps); } catch (e) { throw new SdkError('no_route', (e as Error).message, 'Check the token address and that an authorized venue has a pool for it.'); }
    const fee = i.amountIn * BigInt(this.engine.d.platformFeeBps) / 10_000n;
    return { venue: r.best.venue, amountOut: r.best.amountOut, minOut: r.best.amountOut * BigInt(10_000 - i.slippageBps) / 10_000n, priceImpactBps: r.best.priceImpactBps, platformFee: fee, venueFee: r.best.venueFee, liquidity: r.best.liquidity, alternatives: r.all.slice(1).map(q => ({ venue: q.venue, amountOut: q.amountOut })) };
  }
  /** Market buy: spend `amount` of the quote token on `token`. Resolves when the engine has taken the trade as far as it can (finalized, failed, or waiting on the chain). */
  async buy(p: { walletId: string; token: string; amount: Amount; slippageBps?: number; minOut?: Amount; key?: string; deadlineS?: number; maxFeeBps?: number }): Promise<TradeView> {
    if (this.paused) throw new SdkError('entries_paused', 'New buys are paused for this account.', 'Call resumeEntries() to allow buys again. Sells are never blocked.', 409);
    return this.trade(this.intent({ ...p, side: 'buy', amount: amount(p.amount, 'amount') }));
  }
  /** Market sell: `amount` of `token` for the quote token, or `pctBps` (1..10000) of the wallet's balance. */
  async sell(p: { walletId: string; token: string; amount?: Amount; pctBps?: number; slippageBps?: number; minOut?: Amount; key?: string; deadlineS?: number; maxFeeBps?: number }): Promise<TradeView> {
    const amt = await this.sellAmount(p.walletId, p.token, p.amount, p.pctBps);
    return this.trade(this.intent({ ...p, side: 'sell', amount: amt }));
  }
  private async sellAmount(walletId: string, token: string, amt?: Amount, pctBps?: number): Promise<bigint> {
    if ((amt === undefined) === (pctBps === undefined)) throw new SdkError('bad_request', 'send exactly one of amount or pctBps');
    if (amt !== undefined) return amount(amt, 'amount');
    const bps = int(pctBps, 'pctBps', 1, 10_000); if (!this.chain.balanceOf) throw new SdkError('no_balances', 'this chain cannot report balances, so a percentage cannot be turned into an amount', 'Send an exact amount.');
    const bal = BigInt(await this.chain.balanceOf(idOf(walletId, 'walletId'), idOf(token, 'token'))); const a = bal * BigInt(bps) / 10_000n;
    if (a <= 0n) throw new SdkError('nothing_to_sell', `wallet ${walletId} holds none of this token`); return a;
  }
  private async trade(i: Intent): Promise<TradeView> {
    let rec = await this.engine.submit(i);
    if (this.c.advanceChain && !['finalized', 'failed', 'expired'].includes(rec.state)) { await this.c.advanceChain(); rec = await this.engine.advance(i.idempotencyKey); }
    this.record(rec); return view(rec);
  }
  /** One trade by its idempotency key. */
  trade_(key: string): TradeView | undefined { const r = this.engine.d.store.records.get(key); return r ? view(r) : undefined; }
  /** Recent trades of this account (all origins: manual, order, bulk, twap, snipe, copy), newest first. */
  trades(opts: { limit?: number; origin?: string; walletId?: string } = {}): TradeView[] {
    const out: TxRecord[] = []; for (const r of this.engine.d.store.records.values()) { if (r.intent.userId !== this.userId || r.intent.origin === undefined) continue; if (opts.origin && r.intent.origin !== opts.origin) continue; if (opts.walletId && r.intent.walletId !== opts.walletId) continue; out.push(r); }
    return out.reverse().slice(0, Math.min(opts.limit ?? 50, 500)).map(view);
  }
  /** Drive a trade that is waiting on the chain (confirmations, resubmission) one more time. Safe to repeat. */
  async advance(key: string): Promise<TradeView> { if (!this.engine.d.store.records.has(key)) throw new SdkError('not_found', `no trade with key ${key}`, undefined, 404); const r = await this.engine.advance(key); this.record(r); return view(r); }
  /** Replace a stuck transaction's nonce with a no-op so later trades are not blocked (the engine's reconcile-first rules apply). */
  cancelStuck(walletId: string, opts: { force?: boolean } = {}) { return this.engine.cancelNonce(idOf(walletId, 'walletId'), { reason: 'sdk', force: opts.force === true }); }
  private record(r: TxRecord) { if (r.intent.userId === this.userId && r.fill && (r.state === 'finalized' || r.state === 'confirmed')) this.portfolio.recordTrade({ id: r.key, userId: this.userId, chain: r.intent.chain, tokenIn: r.intent.tokenIn, tokenOut: r.intent.tokenOut, venue: r.quote?.venue ?? '', state: r.state, fill: r.fill, ts: this.chain.time, origin: r.intent.origin }); }

  // ───────────────────────── price orders ─────────────────────────
  private orderBase(p: { id?: string; walletId: string; token: string; amount: Amount; slippageBps?: number; ttlS?: number; maxDeviationBps?: number; maxAttempts?: number; maxQuoteAgeMs?: number; minLiquidity?: Amount }, kind: OrderKind, oid?: string) {
    const d = this.d(); const idv = oid ?? (p.id ? idOf(p.id) : `o-${randomUUID()}`);
    const o: Order = { id: idv, userId: this.userId, walletId: idOf(p.walletId, 'walletId'), chain: this.chain.id, token: idOf(p.token, 'token'), quoteToken: this.quoteToken, kind, amount: amount(p.amount, 'amount'),
      expiresAt: this.chain.time + (p.ttlS === undefined ? d.orderTtlS : int(p.ttlS, 'ttlS', 60, 365 * 86_400)), maxQuoteAgeMs: p.maxQuoteAgeMs === undefined ? d.maxQuoteAgeMs : int(p.maxQuoteAgeMs, 'maxQuoteAgeMs', 100, 600_000),
      minLiquidity: p.minLiquidity === undefined ? d.minLiquidity : amount(p.minLiquidity, 'minLiquidity', { allowZero: true }), maxDeviationBps: p.maxDeviationBps === undefined ? d.maxDeviationBps : int(p.maxDeviationBps, 'maxDeviationBps', 0, 10_000),
      maxAttempts: p.maxAttempts === undefined ? d.maxAttempts : int(p.maxAttempts, 'maxAttempts', 1, 10), slippageBps: this.slip(p.slippageBps), venues: this.c.venues, status: 'active', attempts: 0 };
    if (o.token === o.quoteToken) throw new SdkError('bad_request', 'token and quote token are the same');
    return o;
  }
  private async put(o: Order): Promise<Order> {
    const have = this.orders.orders.orders.get(o.id); if (have) return have;   // same id twice never places a second order
    try { return await this.orders.place(o); } catch (e) { throw new SdkError('order_refused', (e as Error).message, 'Check the wallet balance (orders reserve it) and your plan limit.', 409); }
  }
  /** Buy `amount` (quote budget) when the price falls to `priceE18` (quote per token x1e18) or lower. */
  async limitBuy(p: PriceOrderInput) { const o = this.orderBase(p, 'limit_buy'); this.trigger(o, p); return this.put(o); }
  /** Sell `amount` tokens when the price reaches `priceE18` or higher. */
  async limitSell(p: PriceOrderInput) { const o = this.orderBase(p, 'limit_sell'); this.trigger(o, p); return this.put(o); }
  async takeProfit(p: PriceOrderInput) { const o = this.orderBase(p, 'take_profit'); this.trigger(o, p); return this.put(o); }
  async stopLoss(p: PriceOrderInput) { const o = this.orderBase(p, 'stop_loss'); this.trigger(o, p); return this.put(o); }
  /** Sell when the price has fallen `trailBps` from the highest price seen since the order was placed. */
  async trailingStop(p: Omit<PriceOrderInput, 'priceE18'> & { trailBps: number }) { const o = this.orderBase(p, 'trailing_stop'); o.trailBps = int(p.trailBps, 'trailBps', 1, 9_999); return this.put(o); }
  /** Take profit and/or stop loss (and/or trailing stop) on ONE position: when one fires the others are cancelled and the tokens are reserved once. */
  async bracket(p: Omit<PriceOrderInput, 'priceE18'> & { takeProfitE18?: Amount; stopLossE18?: Amount; trailBps?: number }): Promise<Order[]> {
    const legs: Order[] = []; const gid = p.id ? idOf(p.id) : `g-${randomUUID()}`;
    if (p.takeProfitE18 === undefined && p.stopLossE18 === undefined && p.trailBps === undefined) throw new SdkError('bad_request', 'a bracket needs takeProfitE18, stopLossE18 or trailBps');
    if (p.takeProfitE18 !== undefined) { const o = this.orderBase(p, 'take_profit', `${gid}:tp`); o.triggerPriceE18 = amount(p.takeProfitE18, 'takeProfitE18'); o.ocoGroup = gid; legs.push(o); }
    if (p.stopLossE18 !== undefined) { const o = this.orderBase(p, 'stop_loss', `${gid}:sl`); o.triggerPriceE18 = amount(p.stopLossE18, 'stopLossE18'); o.ocoGroup = gid; legs.push(o); }
    if (p.trailBps !== undefined) { const o = this.orderBase(p, 'trailing_stop', `${gid}:tr`); o.trailBps = int(p.trailBps, 'trailBps', 1, 9_999); o.ocoGroup = gid; legs.push(o); }
    const tp = legs.find(l => l.kind === 'take_profit')?.triggerPriceE18, sl = legs.find(l => l.kind === 'stop_loss')?.triggerPriceE18;
    if (tp !== undefined && sl !== undefined && sl >= tp) throw new SdkError('bad_request', 'the stop loss price must be below the take profit price');
    const out: Order[] = []; try { for (const l of legs) out.push(await this.put(l)); } catch (e) { for (const o of out) this.orders.cancel(o.id); throw e; }
    return out;
  }
  private trigger(o: Order, p: PriceOrderInput) {
    if (!p.marketCap) { o.triggerPriceE18 = amount(p.priceE18, 'priceE18'); return; }
    if (p.priceE18 !== undefined) throw new SdkError('bad_request', 'send priceE18 or marketCap, not both');
    o.mcap = { targetE18: amount(p.marketCap.target, 'marketCap.target'), basis: p.marketCap.basis ?? 'circulating', supply: { source: p.marketCap.supplySource, circulating: p.marketCap.circulating === undefined ? undefined : amount(p.marketCap.circulating, 'circulating'), total: p.marketCap.total === undefined ? undefined : amount(p.marketCap.total, 'total') } as SupplyInfo };
  }
  cancelOrder(orderId: string) { const o = this.orders.orders.orders.get(idOf(orderId)); if (!o) throw new SdkError('not_found', `no order ${orderId}`, undefined, 404); this.orders.cancel(orderId); return this.orders.orders.orders.get(orderId)!; }
  getOrder(orderId: string) { return this.orders.orders.orders.get(orderId); }
  listOrders(opts: { status?: Order['status']; token?: string } = {}) { return [...this.orders.orders.orders.values()].filter(o => o.userId === this.userId && (!opts.status || o.status === opts.status) && (!opts.token || o.token === opts.token)); }
  /** Why an active order has not fired (or could not be evaluated), straight from the runner. */
  orderStatus(orderId: string) { const o = this.getOrder(orderId); return o && { status: o.status, reason: o.reason, attempts: o.attempts, peakE18: o.peakE18, notEvaluated: this.orders.skipped.get(orderId) }; }

  // ───────────────────────── bulk buy / sell ─────────────────────────
  /** One request, up to 10 wallets, each leg an ordinary trade from ITS OWN wallet (own policy, nonce, idempotency). Not atomic: the result says which legs landed. */
  async bulkBuy(p: BulkInput): Promise<BulkSummary> { return this.bulk('buy', p); }
  async bulkSell(p: BulkInput & { pctBps?: number }): Promise<BulkSummary> { return this.bulk('sell', p); }
  private async bulk(side: 'buy' | 'sell', p: BulkInput & { pctBps?: number }): Promise<BulkSummary> {
    if (side === 'buy' && this.paused) throw new SdkError('entries_paused', 'New buys are paused for this account.', 'Call resumeEntries().', 409);
    const bid = p.id ? idOf(p.id) : `b-${randomUUID()}`; const have = this.bulks.get(bid); if (have) return have.summary();
    let legs: { walletId: string; amount: bigint }[];
    if (p.legs) legs = p.legs.map(l => ({ walletId: idOf(l.walletId, 'walletId'), amount: amount(l.amount, 'legs.amount') }));
    else if (p.wallets && p.total !== undefined) { if (!p.wallets.length || p.wallets.length > MAX_BULK_WALLETS) throw new SdkError('bad_request', `wallets must list 1 to ${MAX_BULK_WALLETS} wallets`); legs = splitEqual(p.wallets.map(w => idOf(w, 'wallets')), amount(p.total, 'total')); }
    else if (side === 'sell' && p.wallets && p.pctBps !== undefined) {
      if (!this.chain.balanceOf) throw new SdkError('no_balances', 'this chain cannot report balances');
      legs = []; for (const w of p.wallets) { const bal = BigInt(await this.chain.balanceOf(idOf(w, 'wallets'), idOf(p.token, 'token'))); const a = bal * BigInt(int(p.pctBps, 'pctBps', 1, 10_000)) / 10_000n; if (a > 0n) legs.push({ walletId: w, amount: a }); }
      if (!legs.length) throw new SdkError('nothing_to_sell', 'none of these wallets holds this token');
    } else throw new SdkError('bad_request', side === 'sell' ? 'send legs, or wallets with total, or wallets with pctBps' : 'send legs, or wallets with total');
    const spec: BulkSpec = { id: bid, userId: this.userId, chain: this.chain.id, token: idOf(p.token, 'token'), quoteToken: this.quoteToken, venues: this.c.venues, side, legs, slippageBps: this.slip(p.slippageBps),
      maxTotal: p.maxTotal === undefined ? undefined : amount(p.maxTotal, 'maxTotal'), maxImpactBps: p.maxImpactBps === undefined ? undefined : int(p.maxImpactBps, 'maxImpactBps', 0, 10_000), onFailure: p.onFailure, mode: p.mode, perTick: p.perTick };
    let run: BulkRunner; try { run = new BulkRunner({ engine: this.engine, chain: this.chain, spec, persistPath: this.path('bulk', bid) }); } catch (e) { throw new SdkError('bad_request', (e as Error).message); }
    this.bulks.set(bid, run); this.sides.set(`bulk:${bid}`, side); this.saveMeta(); await run.tick().catch(() => {}); this.diff(); return run.summary();
  }
  bulkStatus(bid: string) { const r = this.bulks.get(bid); if (!r) throw new SdkError('not_found', `no bulk order ${bid}`, undefined, 404); return r.summary(); }

  // ───────────────────────── TWAP ─────────────────────────
  /** Trade `total` in `slices` equal parts, one every `intervalS` seconds from ONE wallet. A slice that cannot go in its window is skipped and reported, never made up later. */
  async twap(p: TwapInput): Promise<TwapSummary> {
    if (p.side === 'buy' && this.paused) throw new SdkError('entries_paused', 'New buys are paused for this account.', 'Call resumeEntries().', 409);
    const tid = p.id ? idOf(p.id) : `t-${randomUUID()}`; const have = this.twaps.get(tid); if (have) return have.summary();
    if (p.side !== 'buy' && p.side !== 'sell') throw new SdkError('bad_request', "side must be 'buy' or 'sell'");
    const spec: TwapSpec = { id: tid, userId: this.userId, walletId: idOf(p.walletId, 'walletId'), chain: this.chain.id, token: idOf(p.token, 'token'), quoteToken: this.quoteToken, venues: this.c.venues, side: p.side,
      total: amount(p.total, 'total'), slices: int(p.slices, 'slices', 2, MAX_TWAP_SLICES), intervalS: int(p.intervalS, 'intervalS', 1, 86_400 * 7), startAt: p.startAt, windowS: p.windowS, slippageBps: this.slip(p.slippageBps),
      limitPriceE18: p.limitPriceE18 === undefined ? undefined : amount(p.limitPriceE18, 'limitPriceE18'), maxSliceImpactBps: p.maxSliceImpactBps, jitterPct: p.jitterPct, onFailure: p.onFailure };
    let run: TwapRunner; try { run = new TwapRunner({ engine: this.engine, chain: this.chain, spec, persistPath: this.path('twap', tid) }); } catch (e) { throw new SdkError('bad_request', (e as Error).message); }
    this.twaps.set(tid, run); this.sides.set(`twap:${tid}`, spec.side); this.saveMeta(); await run.tick().catch(() => {}); this.diff(); return run.summary();
  }
  listTwaps() { return [...this.twaps.values()].map(r => r.summary()); }
  twapStatus(tid: string) { const r = this.twaps.get(tid); if (!r) throw new SdkError('not_found', `no twap order ${tid}`, undefined, 404); return r.summary(); }
  cancelTwap(tid: string) { const r = this.twaps.get(tid); if (!r) throw new SdkError('not_found', `no twap order ${tid}`, undefined, 404); r.cancel(); return r.summary(); }

  // ───────────────────────── sniping and copy trading ─────────────────────────
  /** Start sniping new launches with a bounded budget. You supply the launch source (an EVM log scanner, the Solana launch stream, or a test double). Exits become price orders. */
  addSnipe(sid: string, p: { cfg: Omit<SnipeConfig, 'userId' | 'chain' | 'quoteToken' | 'venues'> & Partial<Pick<SnipeConfig, 'quoteToken' | 'venues'>>; source: LaunchSource; inspect?: (l: Launch) => Promise<void> }) {
    const k = idOf(sid); if (this.snipes.has(k)) throw new SdkError('exists', `snipe ${k} already exists`, undefined, 409);
    const cfg: SnipeConfig = { quoteToken: this.quoteToken, venues: this.c.venues, ...p.cfg, userId: this.userId, chain: this.chain.id };
    const run = new SnipeRunner({ engine: this.engine, chain: this.chain, source: p.source, cfg, orders: this.orders, inspect: p.inspect, persistPath: this.path('snipe', k) }); this.snipes.set(k, run); return run;
  }
  removeSnipe(sid: string) { return this.snipes.delete(sid); }
  /** Mirror one or more leader wallets. Same rules as the Copy Trading page: caps, cooldown, exit following, track-only, checks. */
  addCopy(cid: string, p: { cfgs: (Omit<CopyConfig, 'userId' | 'chain' | 'quoteToken' | 'venues'> & Partial<Pick<CopyConfig, 'quoteToken' | 'venues'>>)[]; source: LeaderSource; info?: ConstructorParameters<typeof CopyRunner>[0]['info']; probeAmount?: bigint }) {
    const k = idOf(cid); if (this.copies.has(k)) throw new SdkError('exists', `copy ${k} already exists`, undefined, 409);
    const cfgs = p.cfgs.map(c => ({ quoteToken: this.quoteToken, venues: this.c.venues, ...c, userId: this.userId, chain: this.chain.id }) as CopyConfig);
    const run = new CopyRunner({ engine: this.engine, chain: this.chain, source: p.source, cfgs, info: p.info, probeAmount: p.probeAmount, persistPath: this.path('copy', k) }); this.copies.set(k, run); return run;
  }
  removeCopy(cid: string) { return this.copies.delete(cid); }

  // ───────────────────────── alerts, portfolio, controls ─────────────────────────
  /** Alert when the best venue price of `token` crosses `threshold` (quote units per token, as a plain number). Fires as an `alert` event. */
  addPriceAlert(p: { id?: string; token: string; direction: 'above' | 'below'; threshold: number; oneShot?: boolean }) {
    const aid = p.id ? idOf(p.id) : `a-${randomUUID()}`; if (p.direction !== 'above' && p.direction !== 'below') throw new SdkError('bad_request', "direction must be 'above' or 'below'");
    if (!this.alerts.add({ id: aid, userId: this.userId, token: idOf(p.token, 'token'), direction: p.direction, threshold: p.threshold, oneShot: p.oneShot })) throw new SdkError('bad_request', 'threshold must be above zero and the id must be new');
    this.priceAlertSpecs.set(aid, { token: p.token }); this.saveMeta(); return aid;
  }
  cancelPriceAlert(aid: string) { const ok = this.alerts.cancel(aid); this.saveMeta(); return ok; }
  positions() { const prices = new Map<string, { num: bigint; den: bigint }>(); for (const t of new Set(this.portfolio.positions(this.userId).map(x => x.token))) { const px = this.spotE18(t); if (px !== undefined) prices.set(t, { num: px, den: E18 }); } return this.portfolio.positions(this.userId, prices); }
  history(token?: string) { return this.portfolio.history(this.userId, token); }
  /** Best venue spot price of `token` in the quote token, x1e18, or undefined when no authorized venue can report one. */
  spotE18(token: string): bigint | undefined { let best: bigint | undefined, liq = -1n; for (const v of this.chain.venues()) { if (v.status !== 'active' || !v.spotPriceE18 || !v.supports(token, this.quoteToken) || !(this.c.venues.includes(v.id) || this.c.venues.includes(v.family))) continue; try { let q; try { q = v.quote(this.quoteToken, token, 10n ** 6n); } catch { q = v.quote(token, this.quoteToken, 10n ** 6n); }   /* a one-direction venue (Jupiter) only quotes the way it was built */ if (q.liquidity > liq) { liq = q.liquidity; best = v.spotPriceE18(token, this.quoteToken); } } catch { /* unquotable */ } } return best; }
  /** Pause NEW automated buys (orders, bulk, TWAP, snipe, copy). Sells, stop losses and manual sells are unaffected. Buys through buy() are refused with a clear message too. */
  pauseEntries() { this.paused = true; this.saveMeta(); } resumeEntries() { this.paused = false; this.saveMeta(); } get entriesPaused() { return this.paused; }
  /** Everything still unfinished, for a dashboard. */
  overview() { return { userId: this.userId, chain: this.chain.id, quoteToken: this.quoteToken, entriesPaused: this.paused, block: this.chain.block, time: this.chain.time,
    orders: { active: this.listOrders({ status: 'active' }).length, total: this.orders.orders.orders.size }, bulks: [...this.bulks.values()].filter(b => !b.summary().done).length, twaps: [...this.twaps.values()].filter(t => !t.summary().done).length, snipes: this.snipes.size, copies: this.copies.size }; }

  // ───────────────────────── driving ─────────────────────────
  /** One pass of every runner. Safe to call by hand (tests, cron) or let start() call it. */
  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      await this.c.advanceChain?.();
      const run = async (where: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { this.emit({ type: 'error', where, message: (e as Error).message }); } };
      await run('orders', () => this.orders.tick());
      for (const [k, b] of this.bulks) if (!b.summary().done && !(this.paused && this.sides.get(`bulk:${k}`) !== 'sell')) await run(`bulk ${k}`, () => b.tick());
      for (const [k, t] of this.twaps) if (!t.summary().done && !(this.paused && this.sides.get(`twap:${k}`) === 'buy')) await run(`twap ${k}`, () => t.tick());
      if (!this.paused) { for (const [k, s] of this.snipes) await run(`snipe ${k}`, () => s.tick()); for (const [k, c] of this.copies) await run(`copy ${k}`, () => c.tick()); }
      this.fireAlerts(); this.diff();
    } finally { this.busy = false; }
  }
  start(everyMs = 1000) { if (this.timer) return; this.timer = setInterval(() => { void this.tick(); }, everyMs); (this.timer as any).unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** After a restart with the same persistDir and engine store: finish what was in flight. Orders and runners must be re-created by id first (same ids reuse the same keys, so nothing trades twice). */
  async resume() { await this.orders.resume(); for (const b of this.bulks.values()) await b.resume(); for (const t of this.twaps.values()) await t.resume(); for (const s of this.snipes.values()) await s.resume(); for (const c of this.copies.values()) await c.resume(); this.diff(); }

  private fireAlerts() {
    const tokens = new Set([...this.priceAlertSpecs.values()].map(a => a.token));
    for (const t of tokens) { const px = this.spotE18(t); if (px === undefined) continue; for (const f of this.alerts.evaluate(t, Number(px) / 1e18, `b${this.chain.block}-t${this.chain.time}`).map(f => { this.saveMeta(); return f; })) this.emit({ type: 'alert', id: f.alertId, token: t, direction: f.direction, threshold: f.threshold, price: f.price }); }
  }
  private diff() {
    for (const o of this.orders.orders.orders.values()) if (o.userId === this.userId && this.changed(`order:${o.id}`, `${o.status}:${o.attempts}`)) this.emit({ type: 'order', id: o.id, status: o.status, reason: o.reason, attempts: o.attempts });
    for (const [k, b] of this.bulks) { const s = b.summary(); if (this.changed(`bulk:${k}`, `${s.filled}/${s.failed}/${s.skipped}/${s.open}`)) this.emit({ type: 'bulk', id: k, filled: s.filled, failed: s.failed, skipped: s.skipped, open: s.open, done: s.done }); }
    for (const [k, t] of this.twaps) { const s = t.summary(); if (this.changed(`twap:${k}`, `${s.filled}/${s.failed}/${s.skipped}/${s.open}`)) this.emit({ type: 'twap', id: k, filled: s.filled, failed: s.failed, skipped: s.skipped, open: s.open, done: s.done }); }
    for (const [k, s] of this.snipes) for (const [l, st] of s.status) if (this.changed(`snipe:${k}:${l}`, st)) this.emit({ type: 'snipe', id: k, launch: l, status: st });
    for (const r of this.engine.d.store.records.values()) { if (r.intent.userId !== this.userId) continue; if (this.changed(`trade:${r.key}`, r.state)) { this.record(r); this.emit({ type: 'trade', key: r.key, state: r.state, walletId: r.intent.walletId, origin: r.intent.origin, failure: r.failure }); } }
  }
}
export interface PriceOrderInput {
  id?: string; walletId: string; token: string;
  /** buy: quote-token budget. sell: token amount. Raw base units. */
  amount: Amount;
  /** Quote units per token, x1e18. Use priceE18() from wire.ts to convert a human price. */
  priceE18?: Amount;
  /** Instead of a price: trigger at a market cap (quote units). Needs the supply; with no supply the order is disabled with a reason, never guessed. */
  marketCap?: { target: Amount; basis?: 'circulating' | 'fdv'; circulating?: Amount; total?: Amount; supplySource: string };
  slippageBps?: number; ttlS?: number; maxDeviationBps?: number; maxAttempts?: number; maxQuoteAgeMs?: number; minLiquidity?: Amount;
}
export interface BulkInput {
  id?: string; token: string; slippageBps?: number;
  /** Explicit amount per wallet, or `wallets` + `total` for an equal split. */
  legs?: { walletId: string; amount: Amount }[]; wallets?: string[]; total?: Amount;
  maxTotal?: Amount; maxImpactBps?: number; onFailure?: 'continue' | 'stop'; mode?: 'sequential' | 'parallel'; perTick?: number;
}
export interface TwapInput {
  id?: string; walletId: string; token: string; side: 'buy' | 'sell'; total: Amount; slices: number; intervalS: number; startAt?: number; windowS?: number; slippageBps?: number;
  limitPriceE18?: Amount; maxSliceImpactBps?: number; jitterPct?: number; onFailure?: 'continue' | 'stop';
}
function view(r: TxRecord): TradeView { return { key: r.key, state: r.state, walletId: r.intent.walletId, origin: r.intent.origin, tokenIn: r.intent.tokenIn, tokenOut: r.intent.tokenOut, amountIn: r.intent.amountIn, fill: r.fill, venue: r.quote?.venue, txHash: r.tx?.hash, failure: r.failure, history: r.history.map(h => ({ ...h })) }; }
