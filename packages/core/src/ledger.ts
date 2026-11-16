export interface Entry { id: string; key: string; account: string; amount: bigint; asset: string; ref: string; reverses?: string }
/** Append-only double-entry ledger; every posting set balances to zero per asset; idempotent by key. */
export interface AbuseRecord { tradeId: string; user: string; fee: bigint; asset: string; reasons: string[] }
export class Ledger {
  entries: Entry[] = []; audit: AbuseRecord[] = []; private keys = new Set<string>(); private claims = new Set<string>(); private n = 0;
  post(key: string, ref: string, asset: string, legs: [string, bigint][]) {
    if (this.keys.has(key)) return false;
    if (legs.reduce((s, [, a]) => s + a, 0n) !== 0n) throw new Error('unbalanced posting');
    this.keys.add(key); for (const [account, amount] of legs) this.entries.push({ id: `e${++this.n}`, key, account, amount, asset, ref });
    return true;
  }
  reverse(key: string) {
    const orig = this.entries.filter(e => e.key === key); const rk = `rev:${key}`;
    if (!orig.length || this.keys.has(rk)) return false;
    this.keys.add(rk); for (const e of orig) this.entries.push({ ...e, id: `e${++this.n}`, key: rk, amount: -e.amount, reverses: e.id }); return true;
  }
  balance(account: string, asset: string) { return this.entries.filter(e => e.account === account && e.asset === asset).reduce((s, e) => s + e.amount, 0n); }
  /** Claim payout from a rewards balance exactly once per claim id. */
  claim(claimId: string, user: string, asset: string, amount: bigint) {
    if (this.claims.has(claimId)) return false;
    if (this.balance(`rewards:${user}`, asset) < amount) throw new Error('insufficient rewards');
    this.claims.add(claimId); return this.post(`claim:${claimId}`, claimId, asset, [[`rewards:${user}`, -amount], [`payout:${user}`, amount]]);
  }
  /** Has this trade been flagged as abusive (self-referral / wash)? */
  isFlagged(tradeId: string) { return this.audit.some(a => a.tradeId === tradeId); }
  /** Sum of every entry for an asset; must always be 0n. */
  total(asset: string) { return this.entries.filter(e => e.asset === asset).reduce((s, e) => s + e.amount, 0n); }
}
export interface TradeFact { id: string; user: string; wallet: string; platformFee: bigint; asset: string; confirmed: boolean; ownerOfWallets: (w: string) => string }
export interface Referral { referrer: string; commissionBps: number }
export interface AbuseFlags { selfReferral: boolean; /** result of washFlag for this trade, supplied explicitly by the caller */ wash?: boolean }
export type AccrueResult = 'unconfirmed' | 'accrued' | 'flagged' | 'duplicate';

/**
 * Accrue from CONFIRMED activity only. Split platform fee: referrer commission(s) + user cashback + revenue.
 * Flagged trades (selfReferral/wash passed explicitly) accrue no commission/cashback; the fee is parked in
 * `abuse:flagged` and an audit record is appended. `ref` may be several referrers (split attribution).
 */
export function accrue(l: Ledger, t: TradeFact, ref: Referral | Referral[] | undefined, cashbackBps: number, flags: AbuseFlags): AccrueResult {
  if (!t.confirmed) return 'unconfirmed';
  if (l.entries.some(e => e.key === `accrue:${t.id}`)) return 'duplicate';
  const reasons = [flags.selfReferral && 'self-referral', flags.wash && 'wash-trade'].filter(Boolean) as string[];
  if (reasons.length) {
    l.post(`accrue:${t.id}`, t.id, t.asset, [[`customer:${t.user}`, -t.platformFee], ['abuse:flagged', t.platformFee]]);
    l.audit.push({ tradeId: t.id, user: t.user, fee: t.platformFee, asset: t.asset, reasons }); return 'flagged';
  }
  const refs = ref === undefined ? [] : Array.isArray(ref) ? ref : [ref];
  const totalBps = refs.reduce((s, r) => s + r.commissionBps, 0) + cashbackBps;
  if (totalBps > 10_000 || cashbackBps < 0 || refs.some(r => r.commissionBps < 0)) throw new Error('rewards exceed fee');
  const legs: [string, bigint][] = [[`customer:${t.user}`, -t.platformFee]]; let paid = 0n;
  for (const r of refs) { const c = t.platformFee * BigInt(r.commissionBps) / 10_000n; if (c) { legs.push([`rewards:${r.referrer}`, c]); paid += c; } }
  const cashback = t.platformFee * BigInt(cashbackBps) / 10_000n;
  if (cashback) { legs.push([`rewards:${t.user}`, cashback]); paid += cashback; }
  legs.push(['revenue', t.platformFee - paid]);
  l.post(`accrue:${t.id}`, t.id, t.asset, legs); return 'accrued';
}
/** Abuse heuristics: self-referral = referrer controls the traded wallet's owner (or same user). */
export function isSelfReferral(user: string, referrer: string, sharedDeviceOrWallet: boolean) { return user === referrer || sharedDeviceOrWallet; }
export interface WashTrade { id?: string; wallet: string; counterparty?: string; side: 'buy' | 'sell'; token: string; t: number }
export interface WashOpts { /** wallet -> owning user */ ownerOf?: (w: string) => string | undefined; /** wallet -> linked-cluster id (funding links, shared device...) */ clusterOf?: (w: string) => string | undefined }
/** Indices of trades that are one leg of a round trip: opposite side, same token, within window, between wallets that are
 *  the same wallet, share an owner, share a cluster, or name each other as counterparty. */
export function washIndices(trades: WashTrade[], windowS = 60, o: WashOpts = {}) {
  const linked = (a: string, b: string) => { const oa = o.ownerOf?.(a), ob = o.ownerOf?.(b), ca = o.clusterOf?.(a), cb = o.clusterOf?.(b);
    return a !== b && ((oa !== undefined && oa === ob) || (ca !== undefined && ca === cb)); };
  const out = new Set<number>();
  trades.forEach((a, i) => trades.forEach((b, j) => {
    if (j === i || a.token !== b.token || a.side === b.side || Math.abs(a.t - b.t) > windowS) return;
    if ((!!a.counterparty && a.counterparty === b.wallet) || linked(a.wallet, b.wallet) || (!!a.counterparty && linked(a.counterparty, b.wallet))) { out.add(i); out.add(j); }
  }));
  return out;
}
export function washFlag(trades: WashTrade[], windowS = 60, o: WashOpts = {}) { return washIndices(trades, windowS, o).size > 0; }
