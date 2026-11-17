import { Reservations } from './reservations.ts';
import type { Intent } from './types.ts';

export type OrderKind = 'limit_buy' | 'limit_sell' | 'take_profit' | 'stop_loss' | 'trailing_stop';
export interface SupplyInfo { source: string; circulating?: bigint; total?: bigint }
export interface Order {
  id: string; userId: string; walletId: string; chain: string; token: string; quoteToken: string; kind: OrderKind;
  amount: bigint;                       // sell: token amount; buy: quote-token budget
  triggerPriceE18?: bigint;             // quote units per token, 1e18 fixed-point
  trailBps?: number; ocoGroup?: string; expiresAt: number;
  /** Opt-in slippage chase: each failed attempt retries with stepBps more slippage, never above maxBps. Without it, retries keep the original slippage. */
  chase?: { stepBps: number; maxBps: number };
  /** When set, the trigger is fixed in USD per whole token (decimal string) and triggerPriceE18 is re-derived from the live quote/USD price by the Trader. Persisted with the order. */
  usdPrice?: string;
  maxQuoteAgeMs: number; minLiquidity: bigint; maxDeviationBps: number; maxAttempts: number; slippageBps: number;
  venues: string[];
  mcap?: { targetE18: bigint; basis: 'circulating' | 'fdv'; supply: SupplyInfo };   // converted to price trigger at placement
  status: 'active' | 'fired' | 'cancelled' | 'expired' | 'failed' | 'disabled'; reason?: string; attempts: number; peakE18?: bigint;
}
export interface Snapshot { priceE18: bigint; ts: number; liquidity: bigint; executableOut: (o: Order) => bigint }
const E18 = 10n ** 18n;
/** Slippage for the order's next attempt: the original value, or with chase, original + attempts x step, capped at the chase maximum (and never below the original). */
export function slippageFor(o: Pick<Order, 'slippageBps' | 'attempts' | 'chase'>): number {
  if (!o.chase) return o.slippageBps;
  return Math.max(o.slippageBps, Math.min(o.slippageBps + o.attempts * o.chase.stepBps, o.chase.maxBps));
}

export class OrderManager {
  orders = new Map<string, Order>();
  private claimed = new Set<string>();
  constructor(private res: Reservations, private run: (i: Intent) => void, private now: () => number, private clockMs: () => number,
              /** Optional plan-limit gate: called with the user's current active-order count before placing; a deny makes place() throw with the reason. */
              private gate?: (o: Order, active: number) => { allow: boolean; reason?: string }) {}

  /** Copy of the state worth persisting (orders incl. attempts/peaks, OCO claims). bigint values are kept as bigint: serialize with store.ts rep/rev. Reservations are snapshotted by their owner. */
  snapshot() { return { orders: [...this.orders.values()].map(o => structuredClone(o)), claimed: [...this.claimed] }; }
  load(s: { orders: Order[]; claimed: string[] }) { this.orders = new Map(s.orders.map(o => [o.id, structuredClone(o)] as [string, Order])); this.claimed = new Set(s.claimed); }

  place(o: Order) {
    if (this.gate) { const active = [...this.orders.values()].filter(x => x.userId === o.userId && x.status === 'active').length; const d = this.gate(o, active); if (!d.allow) throw new Error(`plan limit: ${d.reason}`); }
    if (o.mcap) {
      const s = o.mcap.supply, sup = o.mcap.basis === 'circulating' ? s.circulating : s.total;
      if (!sup || sup <= 0n || !s.source) { o.status = 'disabled'; o.reason = `${o.mcap.basis} supply unavailable; trigger disabled`; this.orders.set(o.id, o); return o; }
      o.triggerPriceE18 = o.mcap.targetE18 / sup;
    }
    // reservation: sells reserve the token (OCO group reserves ONCE, shared); buys reserve the budget
    const sell = o.kind !== 'limit_buy', tok = sell ? o.token : o.quoteToken, owner = o.ocoGroup ? `oco:${o.ocoGroup}` : `order:${o.id}`;
    if (!(o.ocoGroup && this.res.held_(owner, o.walletId, tok) > 0n)) this.res.reserve(owner, o.walletId, tok, o.amount);
    o.status = 'active'; o.attempts = 0; this.orders.set(o.id, o); return o;
  }
  cancel(id: string) { const o = this.orders.get(id); if (!o || o.status !== 'active') return; o.status = 'cancelled'; this.maybeRelease(o); }
  /** Move an active order's trigger price. The reservation, amount, attempts and OCO link are kept. A bracket's take profit must stay above its stop loss.
   *  Trailing stops have no fixed trigger, and market-cap orders keep their cap target, so neither can be edited this way. */
  retrigger(id: string, priceE18: bigint) {
    const o = this.orders.get(id); if (!o) throw new Error(`no order ${id}`);
    if (o.status !== 'active') throw new Error(`only an active order can be edited (this one is ${o.status})`);
    if (o.kind === 'trailing_stop') throw new Error('a trailing stop has no fixed trigger price: cancel it and place a new one');
    if (o.mcap) throw new Error('this order triggers on market cap: cancel it and place a new one');
    if (priceE18 <= 0n) throw new Error('the trigger price must be above zero');
    if (o.ocoGroup) for (const s of this.orders.values()) {
      if (s === o || s.ocoGroup !== o.ocoGroup || s.status !== 'active' || s.triggerPriceE18 === undefined) continue;
      if (o.kind === 'take_profit' && s.kind === 'stop_loss' && priceE18 <= s.triggerPriceE18) throw new Error('the take profit must stay above the stop loss of the same bracket');
      if (o.kind === 'stop_loss' && s.kind === 'take_profit' && priceE18 >= s.triggerPriceE18) throw new Error('the stop loss must stay below the take profit of the same bracket');
    }
    o.triggerPriceE18 = priceE18; o.reason = 'trigger price edited'; return o;
  }
  private owner(o: Order) { return o.ocoGroup ? `oco:${o.ocoGroup}` : `order:${o.id}`; }
  private maybeRelease(o: Order) {
    const live = [...this.orders.values()].some(x => x !== o && x.status === 'active' && this.owner(x) === this.owner(o));
    if (!live) this.res.release(this.owner(o), o.walletId, o.kind === 'limit_buy' ? o.quoteToken : o.token);
  }

  /** Evaluate against a fresh snapshot AND an executable quote; never trigger from a stale/illiquid/unexecutable price. */
  evaluate(o: Order, s: Snapshot): { fire: boolean; why: string } {
    const nowS = this.now();
    if (o.expiresAt <= nowS) return { fire: false, why: 'expired' };
    if (this.clockMs() - s.ts > o.maxQuoteAgeMs) return { fire: false, why: 'stale quote' };
    if (s.liquidity < o.minLiquidity) return { fire: false, why: 'liquidity below minimum' };
    const t = o.triggerPriceE18; let hit = false;
    if (o.kind === 'trailing_stop') {
      o.peakE18 = o.peakE18 && o.peakE18 > s.priceE18 ? o.peakE18 : s.priceE18;
      hit = s.priceE18 <= o.peakE18 * BigInt(10_000 - (o.trailBps ?? 0)) / 10_000n;
    } else if (t === undefined) return { fire: false, why: 'no trigger price' };
    else if (o.kind === 'limit_buy') hit = s.priceE18 <= t;
    else if (o.kind === 'stop_loss') hit = s.priceE18 <= t;
    else hit = s.priceE18 >= t;
    if (!hit) return { fire: false, why: 'trigger not met' };
    // executable-output requirement: floor = amount * ref * (1 - maxDeviation)
    const ref = o.kind === 'trailing_stop' ? s.priceE18 : t!;
    const sell = o.kind !== 'limit_buy';
    const required = sell ? o.amount * ref / E18 * BigInt(10_000 - o.maxDeviationBps) / 10_000n
                          : o.amount * E18 / ref * BigInt(10_000 - o.maxDeviationBps) / 10_000n;
    const out = s.executableOut(o);
    if (out < required) return { fire: false, why: `executable output ${out} < required ${required}` };
    return { fire: true, why: 'trigger met and executable' };
  }

  tick(snapOf: (o: Order) => Snapshot | undefined) {
    const fired: string[] = [];
    for (const o of this.orders.values()) {
      if (o.status !== 'active') continue;
      if (o.expiresAt <= this.now()) { o.status = 'expired'; this.maybeRelease(o); continue; }
      const snap = snapOf(o); if (!snap) continue;
      const ev = this.evaluate(o, snap); o.reason = ev.why;
      if (!ev.fire) continue;
      if (o.ocoGroup) { if (this.claimed.has(o.ocoGroup)) continue; this.claimed.add(o.ocoGroup); }  // atomic claim: one leg only
      o.status = 'fired'; fired.push(o.id);
      for (const sib of this.orders.values()) if (sib !== o && sib.ocoGroup && sib.ocoGroup === o.ocoGroup && sib.status === 'active') sib.status = 'cancelled';
      const sell = o.kind !== 'limit_buy';
      this.run({ idempotencyKey: `order:${o.id}:a${o.attempts}`, userId: o.userId, walletId: o.walletId, chain: o.chain,
        tokenIn: sell ? o.token : o.quoteToken, tokenOut: sell ? o.quoteToken : o.token, amountIn: o.amount, minOut: 0n,
        slippageBps: slippageFor(o), deadline: this.now() + 120, maxFeeBps: 200, venues: o.venues, origin: 'order' });
    }
    return fired;
  }
  /** Execution result callback: bounded retries with unchanged limits; reservation released on terminal outcome. */
  onResult(id: string, ok: boolean) {
    const o = this.orders.get(id)!; const key = o.kind === 'limit_buy' ? o.quoteToken : o.token;
    if (ok) { this.res.release(this.owner(o), o.walletId, key); return; }
    o.attempts++;
    if (o.attempts >= o.maxAttempts) { o.status = 'failed'; this.res.release(this.owner(o), o.walletId, key); if (o.ocoGroup) this.claimed.delete(o.ocoGroup); }
    else { o.status = 'active'; if (o.ocoGroup) this.claimed.delete(o.ocoGroup); }   // same limits; slippage widens on the next attempt only if the order opted into chase (see slippageFor)
  }
}
