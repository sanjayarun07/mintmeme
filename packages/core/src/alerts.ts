/**
 * Alerts, community bot decision logic, and trending. Pure logic: no network, no clock (callers pass time).
 * Delivery is injected; nothing here posts anywhere except through an explicit, authorization-gated sink.
 */

// ---------- watchlists ----------
export class Watchlists {
  private m = new Map<string, Set<string>>();
  constructor(public maxPerUser = 100) {}
  add(userId: string, tokenKey: string): boolean {
    const s = this.m.get(userId) ?? new Set<string>(); this.m.set(userId, s);
    if (!s.has(tokenKey) && s.size >= this.maxPerUser) return false;
    s.add(tokenKey); return true;
  }
  remove(userId: string, tokenKey: string) { return this.m.get(userId)?.delete(tokenKey) ?? false; }
  list(userId: string) { return [...(this.m.get(userId) ?? [])].sort(); }
  watchers(tokenKey: string) { return [...this.m].filter(([, s]) => s.has(tokenKey)).map(([u]) => u).sort(); }
}

// ---------- price alerts ----------
export interface PriceAlertSpec { id: string; userId: string; token: string; direction: 'above' | 'below'; threshold: number; oneShot?: boolean; hysteresisBps?: number }
export interface PriceAlertFire { alertId: string; userId: string; token: string; direction: 'above' | 'below'; threshold: number; price: number; tickId: string }
interface PA extends PriceAlertSpec { armed: boolean; active: boolean }

/** Fires on cross. One-shot by default. Repeating alerts re-arm only after price retreats past threshold by hysteresis (no flapping). */
export class PriceAlerts {
  private alerts = new Map<string, PA>();
  private seenTicks = new Set<string>();
  add(spec: PriceAlertSpec) {
    if (!(spec.threshold > 0) || this.alerts.has(spec.id)) return false;
    this.alerts.set(spec.id, { oneShot: true, hysteresisBps: 100, ...spec, armed: true, active: true }); return true;
  }
  cancel(id: string) { const a = this.alerts.get(id); if (!a) return false; a.active = false; return true; }
  evaluate(token: string, price: number, tickId: string): PriceAlertFire[] {
    const dk = `${token}:${tickId}`;
    if (this.seenTicks.has(dk)) return [];          // same tick delivered twice (provider retry) => no double fire
    this.seenTicks.add(dk); if (this.seenTicks.size > 10_000) this.seenTicks.delete(this.seenTicks.values().next().value!);
    const out: PriceAlertFire[] = [];
    for (const a of this.alerts.values()) {
      if (!a.active || a.token !== token) continue;
      const h = (a.hysteresisBps ?? 0) / 10_000;
      const hit = a.direction === 'above' ? price >= a.threshold : price <= a.threshold;
      if (!a.armed) {
        const retreated = a.direction === 'above' ? price <= a.threshold * (1 - h) : price >= a.threshold * (1 + h);
        if (retreated) a.armed = true;
        continue;
      }
      if (hit) {
        out.push({ alertId: a.id, userId: a.userId, token, direction: a.direction, threshold: a.threshold, price, tickId });
        a.armed = false; if (a.oneShot) a.active = false;
      }
    }
    return out;
  }
  isActive(id: string) { return this.alerts.get(id)?.active ?? false; }
  /** Durable state: every alert with whether it is armed and active, so a restart neither re-fires a one-shot alert nor forgets a live one. */
  snapshot(): PA[] { return [...this.alerts.values()].map(a => ({ ...a })); }
  load(list: PA[]) { this.alerts = new Map(list.map(a => [a.id, { ...a }])); }
}

// ---------- wallet activity / whale ----------
export type ActivityKind = 'swap' | 'transfer' | 'bridge' | 'airdrop';
export interface Leg { token: string; delta: bigint }   // wallet perspective: + in, - out
export interface ChainEvent {
  chain: string; txHash: string; logIndex: number; blockHash: string; blockNumber: number;
  wallet: string; legs: Leg[]; valueUsd: number;
  counterpartyIsBridge?: boolean;     // known bridge contract/router
  fromKnownDistributor?: boolean;     // inflow from a known airdrop/claim distributor
}
export const eventKey = (e: Pick<ChainEvent, 'chain' | 'txHash' | 'logIndex'>) => `${e.chain}:${e.txHash}:${e.logIndex}`;

export function classify(e: ChainEvent): ActivityKind {
  if (e.counterpartyIsBridge) return 'bridge';
  const ins = e.legs.filter(l => l.delta > 0n), outs = e.legs.filter(l => l.delta < 0n);
  if (ins.length && outs.length && ins.some(i => outs.every(o => o.token !== i.token))) return 'swap';
  if (ins.length && !outs.length && e.fromKnownDistributor) return 'airdrop';
  return 'transfer';
}
export interface WalletAlert { type: 'activity'; key: string; wallet: string; kind: ActivityKind; whale: boolean; valueUsd: number; blockHash: string }
export interface WalletRevoke { type: 'revoke'; key: string; wallet: string; reason: 'reorg' }

export class WalletAlerts {
  private watched = new Map<string, number>();                 // wallet -> minValueUsd override
  private sent = new Map<string, WalletAlert>();               // key -> alert currently standing
  constructor(public cfg: { minValueUsd: number; whaleUsd: number }) {}
  watch(wallet: string, minValueUsd?: number) { this.watched.set(wallet, minValueUsd ?? this.cfg.minValueUsd); }
  unwatch(wallet: string) { this.watched.delete(wallet); }
  /** Dedupe by chain:tx:logIndex. A key revoked by reorg may alert again when re-included. */
  ingest(e: ChainEvent): WalletAlert | null {
    const min = this.watched.get(e.wallet); if (min === undefined) return null;
    if (e.valueUsd < min) return null;
    const key = eventKey(e); if (this.sent.has(key)) return null;
    const a: WalletAlert = { type: 'activity', key, wallet: e.wallet, kind: classify(e), whale: e.valueUsd >= this.cfg.whaleUsd, valueUsd: e.valueUsd, blockHash: e.blockHash };
    this.sent.set(key, a); return a;
  }
  /** Reorg: block removed. Emit revocations for every alert sent from it and forget their dedupe keys. */
  revokeBlock(chain: string, blockHash: string): WalletRevoke[] {
    const out: WalletRevoke[] = [];
    for (const [k, a] of [...this.sent]) if (k.startsWith(chain + ':') && a.blockHash === blockHash) { this.sent.delete(k); out.push({ type: 'revoke', key: k, wallet: a.wallet, reason: 'reorg' }); }
    return out;
  }
}

// ---------- community buy/sell bot ----------
export interface GroupAuthorization { groupId: string; authorizedBy: string; authorizedAt: number; evidence: string }
export interface TradeNotice { eventKey: string; token: string; side: 'buy' | 'sell'; valueUsd: number; wallet?: string; ts: number }
export type BotDecision = { post: true; text: string } | { post: false; reason: string };

/** Posts ONLY to groups with an explicit authorization record. No auth => never posts, regardless of other config. */
export class CommunityBot {
  private auth = new Map<string, GroupAuthorization>();
  private cfg = new Map<string, { minBuyUsd: number; postSells: boolean }>();
  private posts = new Map<string, number[]>();
  private seen = new Set<string>();
  constructor(private o: { maxPerWindow: number; windowS: number; sink?: (groupId: string, text: string) => void }) {}
  authorize(a: GroupAuthorization, cfg: { minBuyUsd: number; postSells?: boolean }): boolean {
    if (!a.groupId || !a.authorizedBy || !a.evidence || !(a.authorizedAt > 0)) return false;
    this.auth.set(a.groupId, a); this.cfg.set(a.groupId, { minBuyUsd: cfg.minBuyUsd, postSells: cfg.postSells ?? false }); return true;
  }
  revoke(groupId: string) { this.auth.delete(groupId); this.cfg.delete(groupId); }
  isAuthorized(groupId: string) { return this.auth.has(groupId); }
  notify(groupId: string, n: TradeNotice, now: number): BotDecision {
    const c = this.cfg.get(groupId);
    if (!c || !this.auth.has(groupId)) return { post: false, reason: 'group not authorized' };
    const dk = `${groupId}:${n.eventKey}`; if (this.seen.has(dk)) return { post: false, reason: 'duplicate event' };
    if (n.side === 'sell' && !c.postSells) return { post: false, reason: 'sell notices disabled' };
    if (n.side === 'buy' && n.valueUsd < c.minBuyUsd) return { post: false, reason: 'below min buy' };
    const recent = (this.posts.get(groupId) ?? []).filter(t => now - t < this.o.windowS);
    if (recent.length >= this.o.maxPerWindow) { this.posts.set(groupId, recent); return { post: false, reason: 'rate limited' }; }
    recent.push(now); this.posts.set(groupId, recent); this.seen.add(dk);
    const who = n.wallet ? ` by ${n.wallet.slice(0, 4)}...${n.wallet.slice(-4)}` : '';
    const text = `${n.side === 'buy' ? 'BUY' : 'SELL'} ${n.token} ~$${Math.round(n.valueUsd)}${who}`;
    this.o.sink?.(groupId, text);
    return { post: true, text };
  }
}

// ---------- trending with anti-wash controls + k-anonymous aggregate ----------
export interface TrendTrade { eventKey: string; token: string; wallet: string; side: 'buy' | 'sell'; valueUsd: number; ts: number }
export interface TrendCfg { halfLifeS: number; perWalletCapUsd: number; roundTripWindowS: number; minLiquidityUsd: number; k: number; windowS: number }
export interface TrendRow { token: string; score: number; uniqueWallets: number; volumeUsd: number }

export class Trending {
  private trades: TrendTrade[] = [];
  private keys = new Set<string>();
  private liq = new Map<string, number>();
  constructor(private cfg: TrendCfg) {}
  setLiquidity(token: string, usd: number) { this.liq.set(token, usd); }
  ingest(t: TrendTrade) { if (this.keys.has(t.eventKey)) return false; this.keys.add(t.eventKey); this.trades.push(t); return true; }

  /** Wallets that bought AND sold the same token within roundTripWindow are treated as wash and excluded for that token. */
  private washWallets(token: string, ts: TrendTrade[]) {
    const wash = new Set<string>(); const byW = new Map<string, TrendTrade[]>();
    for (const t of ts) { const a = byW.get(t.wallet) ?? []; a.push(t); byW.set(t.wallet, a); }
    for (const [w, arr] of byW) {
      const buys = arr.filter(x => x.side === 'buy'), sells = arr.filter(x => x.side === 'sell');
      if (buys.some(b => sells.some(s => Math.abs(s.ts - b.ts) <= this.cfg.roundTripWindowS))) wash.add(w);
    }
    return wash;
  }
  private rows(now: number): (TrendRow & { wallets: number })[] {
    const c = this.cfg; const byTok = new Map<string, TrendTrade[]>();
    for (const t of this.trades) if (now - t.ts <= c.windowS && t.ts <= now) { const a = byTok.get(t.token) ?? []; a.push(t); byTok.set(t.token, a); }
    const rows: (TrendRow & { wallets: number })[] = [];
    for (const [token, ts] of byTok) {
      if ((this.liq.get(token) ?? 0) < c.minLiquidityUsd) continue;
      const wash = this.washWallets(token, ts);
      const per = new Map<string, number>(); let vol = 0;
      for (const t of ts) {
        if (t.side !== 'buy' || wash.has(t.wallet)) continue;
        const w = Math.pow(0.5, (now - t.ts) / c.halfLifeS);
        per.set(t.wallet, (per.get(t.wallet) ?? 0) + t.valueUsd * w); vol += t.valueUsd;
      }
      // each wallet contributes at most perWalletCapUsd (decayed), normalised => score is "capped wallet-equivalents" <= unique wallets
      let score = 0; for (const v of per.values()) score += Math.min(v, c.perWalletCapUsd) / c.perWalletCapUsd;
      if (per.size) rows.push({ token, score, uniqueWallets: per.size, volumeUsd: vol, wallets: per.size });
    }
    return rows.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
  }
  /** Internal ranking (still no per-user data). */
  rank(now: number): TrendRow[] { return this.rows(now).map(({ wallets, ...r }) => r); }
  /** Public aggregate: tokens with fewer than k distinct contributing wallets are omitted entirely; no wallet ids, no per-user rows. */
  publicAggregate(now: number): { token: string; score: number; uniqueWallets: number }[] {
    return this.rows(now).filter(r => r.wallets >= this.cfg.k).map(r => ({ token: r.token, score: Math.round(r.score * 100) / 100, uniqueWallets: r.wallets }));
  }
}
