import { NATIVE } from './types.ts';
import type { Fill, TxState } from './types.ts';

/**
 * Portfolio accounting from CONFIRMED fills only. State is a pure fold over an append-only event log, so a
 * reorg-revoked trade (revokeTrade) simply drops out and everything is recomputed.
 *
 * Policies (deliberate, documented):
 *  - Positions are keyed by user|chain|token identity. Venue is attribute of a trade, never part of the key, so a curve->pool
 *    migration keeps balance, cost basis and history.
 *  - Positions exist only for non-quote tokens. Quote tokens (default [NATIVE]) are the cost currency.
 *  - Cost basis = average cost over KNOWN lots, from our own fills (spent incl. platform fee; network fee is reported separately)
 *    or from a user-supplied basis carrying a provenance label. Anything else (transfer/airdrop, foreign quote token,
 *    token<->token swap) is UNKNOWN and stays unknown; it is never guessed.
 *  - Sells/transfers-out consume known and unknown quantity pro-rata; realized P&L covers only the known part.
 *  - Platform-routed volume is kept apart from venue-observed volume; the two are never summed.
 */
export type Provenance = 'own_fill' | 'user_supplied' | 'unknown_transfer';
export interface TradeInput {
  id: string; userId: string; chain: string; tokenIn: string; tokenOut: string; venue: string;
  state: TxState; fill: Fill; ts: number; origin?: string;
}
export interface Basis { cost: bigint; costToken: string; provenance: 'user_supplied'; note?: string }
export interface Price { num: bigint; den: bigint }   // quote units per token unit
export type FeeBook = { platform: Record<string, bigint>; venue: Record<string, bigint>; network: Record<string, bigint> };

type Ev =
  | { k: 'trade'; t: TradeInput }
  | { k: 'in'; id: string; userId: string; chain: string; token: string; qty: bigint; ts: number; basis?: Basis }
  | { k: 'out'; id: string; userId: string; chain: string; token: string; qty: bigint; ts: number };

export interface TradeRecord {
  id: string; ts: number; venue: string; side: 'buy' | 'sell'; token: string; quoteToken: string | null;
  tokenQty: bigint; quoteAmount: bigint | null; fees: { platform: bigint; venue: bigint; network: bigint };
}
export interface PositionView {
  chain: string; token: string; balance: bigint; knownQty: bigint; unknownQty: bigint;
  costToken: string | null; knownCost: bigint; avgCost: Price | null;
  realizedPnl: bigint; realizedUnknownProceeds: bigint;
  unrealizedPnl: bigint | null; unrealizedKnownPortion: bigint | null;
  fees: FeeBook; venues: string[]; basisSources: Provenance[]; oversold: boolean; firstTs: number | null;
}
const emptyFees = (): FeeBook => ({ platform: {}, venue: {}, network: {} });
const addTo = (m: Record<string, bigint>, k: string, v: bigint) => { if (v) m[k] = (m[k] ?? 0n) + v; };

interface Pos {
  chain: string; token: string; balance: bigint; knownQty: bigint; knownCost: bigint; costToken: string | null;
  realized: bigint; unknownProceeds: bigint; fees: FeeBook; venues: Set<string>; sources: Set<Provenance>; oversold: boolean; firstTs: number | null;
}

export class Portfolio {
  private events: Ev[] = [];
  private ids = new Set<string>();
  private migrations: { chain: string; token: string; from: string; to: string; ts: number }[] = [];
  private venueVol = new Map<string, bigint>();
  readonly quoteTokens: Set<string>;
  constructor(quoteTokens: string[] = [NATIVE]) { this.quoteTokens = new Set(quoteTokens); }

  /** Only confirmed/finalized fills count. Idempotent on id. */
  recordTrade(t: TradeInput): { accepted: boolean; reason?: string } {
    if (t.state !== 'confirmed' && t.state !== 'finalized') return { accepted: false, reason: `state ${t.state} is not confirmed` };
    if (!t.fill) return { accepted: false, reason: 'no fill' };
    if (this.ids.has(t.id)) return { accepted: false, reason: 'duplicate' };
    this.ids.add(t.id); this.events.push({ k: 'trade', t }); return { accepted: true };
  }
  /** Reorg/unresolved: remove a previously recorded trade. */
  revokeTrade(id: string): boolean {
    const n = this.events.length;
    this.events = this.events.filter(e => !(e.k === 'trade' && e.t.id === id));
    this.ids.delete(id); return this.events.length !== n;
  }
  recordTransferIn(e: { id: string; userId: string; chain: string; token: string; qty: bigint; ts: number; basis?: Basis }) {
    if (this.ids.has(e.id)) return false; this.ids.add(e.id); this.events.push({ k: 'in', ...e }); return true;
  }
  recordTransferOut(e: { id: string; userId: string; chain: string; token: string; qty: bigint; ts: number }) {
    if (this.ids.has(e.id)) return false; this.ids.add(e.id); this.events.push({ k: 'out', ...e }); return true;
  }
  /** Venue change is metadata only: positions are untouched. */
  recordMigration(chain: string, token: string, from: string, to: string, ts: number) { this.migrations.push({ chain, token, from, to, ts }); }
  migrationsOf(chain: string, token: string) { return this.migrations.filter(m => m.chain === chain && m.token === token); }
  /** Venue-observed volume (market data), kept apart from platform volume. */
  recordVenueVolume(venue: string, token: string, amount: bigint) { const k = `${venue}|${token}`; this.venueVol.set(k, (this.venueVol.get(k) ?? 0n) + amount); }
  venueVolume(venue: string, token: string) { return this.venueVol.get(`${venue}|${token}`) ?? 0n; }

  private fold(userId: string) {
    const pos = new Map<string, Pos>(); const hist: (TradeRecord & { chain: string })[] = [];
    const fees = emptyFees(); const vol: Record<string, bigint> = {};
    const get = (chain: string, token: string, ts: number) => {
      const k = `${chain}|${token}`; let p = pos.get(k);
      if (!p) { p = { chain, token, balance: 0n, knownQty: 0n, knownCost: 0n, costToken: null, realized: 0n, unknownProceeds: 0n, fees: emptyFees(), venues: new Set(), sources: new Set(), oversold: false, firstTs: ts }; pos.set(k, p); }
      return p;
    };
    const addUnknown = (p: Pos, qty: bigint) => { p.balance += qty; p.sources.add('unknown_transfer'); };
    /** remove qty pro-rata; returns split of removed (known part, unknown part, cost removed). */
    const remove = (p: Pos, qty: bigint) => {
      let q = qty; let over = 0n;
      if (q > p.balance) { over = q - p.balance; q = p.balance; p.oversold = true; }
      const unknownQty = p.balance - p.knownQty;
      const knownPart = p.balance === 0n ? 0n : q * p.knownQty / p.balance;
      const costPart = p.knownQty === 0n ? 0n : p.knownCost * knownPart / p.knownQty;
      p.balance -= q; p.knownQty -= knownPart; p.knownCost -= costPart;
      if (p.knownQty === 0n) { p.knownCost = 0n; }
      return { knownPart, unknownPart: q - knownPart + over, costPart, total: qty, unknownQty };
    };
    for (const e of this.events) {
      if (e.k === 'trade') {
        const t = e.t; if (t.userId !== userId) continue; const f = t.fill;
        addTo(fees.platform, t.tokenIn, f.platformFee); addTo(fees.venue, t.tokenIn, f.venueFee); addTo(fees.network, NATIVE, f.networkFee);
        const inQ = this.quoteTokens.has(t.tokenIn), outQ = this.quoteTokens.has(t.tokenOut);
        if (inQ) addTo(vol, t.tokenIn, f.spent); else if (outQ) addTo(vol, t.tokenOut, f.received);
        const tf = { platform: f.platformFee, venue: f.venueFee, network: f.networkFee };
        if (!outQ) {   // acquire tokenOut
          const p = get(t.chain, t.tokenOut, t.ts); p.venues.add(t.venue);
          addTo(p.fees.platform, t.tokenIn, tf.platform); addTo(p.fees.venue, t.tokenIn, tf.venue); addTo(p.fees.network, NATIVE, tf.network);
          if (inQ && (p.costToken === null || p.costToken === t.tokenIn || p.knownQty === 0n)) {
            if (p.knownQty === 0n) p.costToken = t.tokenIn;
            p.balance += f.received; p.knownQty += f.received; p.knownCost += f.spent; p.sources.add('own_fill');
          } else addUnknown(p, f.received);
          hist.push({ chain: t.chain, id: t.id, ts: t.ts, venue: t.venue, side: 'buy', token: t.tokenOut, quoteToken: inQ ? t.tokenIn : null, tokenQty: f.received, quoteAmount: inQ ? f.spent : null, fees: tf });
        }
        if (!inQ) {    // dispose tokenIn
          const p = get(t.chain, t.tokenIn, t.ts); p.venues.add(t.venue);
          if (outQ) { addTo(p.fees.platform, t.tokenIn, tf.platform); addTo(p.fees.venue, t.tokenIn, tf.venue); addTo(p.fees.network, NATIVE, tf.network); }
          const r = remove(p, f.spent);
          if (outQ && p.costToken === t.tokenOut) {
            const proceedsKnown = f.spent === 0n ? 0n : f.received * r.knownPart / f.spent;
            p.realized += proceedsKnown - r.costPart; p.unknownProceeds += f.received - proceedsKnown;
          } else if (outQ) p.unknownProceeds += f.received;
          hist.push({ chain: t.chain, id: t.id, ts: t.ts, venue: t.venue, side: 'sell', token: t.tokenIn, quoteToken: outQ ? t.tokenOut : null, tokenQty: f.spent, quoteAmount: outQ ? f.received : null, fees: tf });
        }
      } else if (e.userId === userId && !this.quoteTokens.has(e.token)) {
        const p = get(e.chain, e.token, e.ts);
        if (e.k === 'in') {
          if (e.basis && e.basis.cost >= 0n && (p.costToken === null || p.knownQty === 0n || p.costToken === e.basis.costToken)) {
            if (p.knownQty === 0n) p.costToken = e.basis.costToken;
            p.balance += e.qty; p.knownQty += e.qty; p.knownCost += e.basis.cost; p.sources.add('user_supplied');
          } else addUnknown(p, e.qty);
        } else remove(p, e.qty);   // transfer out: no P&L event
      }
    }
    return { pos, hist, fees, vol };
  }

  positions(userId: string, prices: Map<string, Price> = new Map()): PositionView[] {
    return [...this.fold(userId).pos.values()].map(p => {
      const unknownQty = p.balance - p.knownQty;
      const pr = prices.get(`${p.chain}|${p.token}`);
      const knownPortion = pr && p.costToken ? p.knownQty * pr.num / pr.den - p.knownCost : null;
      return {
        chain: p.chain, token: p.token, balance: p.balance, knownQty: p.knownQty, unknownQty, costToken: p.costToken, knownCost: p.knownCost,
        avgCost: p.knownQty > 0n ? { num: p.knownCost, den: p.knownQty } : null,
        realizedPnl: p.realized, realizedUnknownProceeds: p.unknownProceeds,
        unrealizedPnl: p.balance === 0n ? 0n : unknownQty > 0n || knownPortion === null ? null : knownPortion,
        unrealizedKnownPortion: knownPortion, fees: p.fees, venues: [...p.venues], basisSources: [...p.sources], oversold: p.oversold, firstTs: p.firstTs,
      };
    });
  }
  position(userId: string, chain: string, token: string, prices?: Map<string, Price>) { return this.positions(userId, prices).find(p => p.chain === chain && p.token === token); }
  history(userId: string, token?: string): TradeRecord[] { return this.fold(userId).hist.filter(h => !token || h.token === token); }
  fees(userId: string): FeeBook { return this.fold(userId).fees; }
  /** Volume routed through OUR platform, per quote token. Not mixed with venue volume. */
  platformVolume(userId: string): Record<string, bigint> { return this.fold(userId).vol; }
}
