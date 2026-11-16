/** Whale alerts. EVIDENCE: the Maestro Whale Bot docs page is a placeholder; the homepage only says users get instant notifications about whale transactions / huge movements of wallets they choose to watch.
 *  Threshold, side and chain filters, the watched-wallet list and its separate minimum are OUR design, not Maestro's documented behavior. Matching uses the trade's sender address as GeckoTerminal reports it
 *  (third party, not re-verified on-chain), so a watched-wallet hit means "that address sent this trade", not "that person owns the funds". Alerts go through an injected sink; nothing here talks to Telegram. */
import type { FeedTrade } from '../../packages/live/src/tradefeed.ts';
import { CHAIN_NAME, shortWallet } from './buybot.ts';

export interface WhaleCfg { minUsd: number; sides: ('buy' | 'sell')[]; chains: string[] | 'all'; watched: string[]; watchedMinUsd: number }
export const DEFAULT_WHALE: WhaleCfg = { minUsd: 50_000, sides: ['buy', 'sell'], chains: 'all', watched: [], watchedMinUsd: 100 };
export type WhaleReason = 'size' | 'watched wallet';
export function whaleMatch(t: Pick<FeedTrade, 'side' | 'usd' | 'chain' | 'wallet'>, c: WhaleCfg): WhaleReason | null {
  if (!c.sides.includes(t.side)) return null; if (c.chains !== 'all' && !c.chains.includes(t.chain)) return null;
  if (c.watched.some(w => w.toLowerCase() === t.wallet.toLowerCase()) && t.usd >= c.watchedMinUsd) return 'watched wallet';
  return t.usd >= c.minUsd ? 'size' : null;
}
export const formatWhale = (t: FeedTrade, why: WhaleReason) => `WHALE ${t.side === 'buy' ? 'BUY' : 'SELL'} ${t.sym.replace(/[\u0000-\u001f\u007f‪-‮]/g, '').slice(0, 20) || '?'} on ${CHAIN_NAME[t.chain] ?? t.chain}\n$${Math.round(t.usd).toLocaleString('en')} by ${shortWallet(t.wallet)} (${why === 'size' ? 'large trade' : 'a wallet you watch'})`;

export class WhaleBot {
  private users = new Map<string, WhaleCfg>(); private seen = new Map<string, Set<string>>(); private posts = new Map<string, number[]>(); failures = 0;
  constructor(private o: { sink: (userId: string, text: string) => Promise<void> | void; maxPerWindow?: number; windowS?: number }) {}
  set(userId: string, c: Partial<WhaleCfg>): WhaleCfg { const v = { ...DEFAULT_WHALE, ...this.users.get(userId), ...c }; if (!(v.minUsd > 0) || !(v.watchedMinUsd >= 0)) throw new Error('thresholds must be positive numbers'); this.users.set(userId, v); return v; }
  async handleTrade(t: FeedTrade, nowMs: number): Promise<number> {
    if (!t.fresh) return 0; let n = 0;
    for (const [uid, c] of this.users) {
      const why = whaleMatch(t, c); if (!why) continue;
      const seen = this.seen.get(uid) ?? new Set<string>(); this.seen.set(uid, seen); if (seen.has(t.key)) continue;
      const recent = (this.posts.get(uid) ?? []).filter(x => nowMs - x < (this.o.windowS ?? 60) * 1000); if (recent.length >= (this.o.maxPerWindow ?? 10)) { this.posts.set(uid, recent); continue; }
      seen.add(t.key); if (seen.size > 2000) seen.delete(seen.values().next().value as string); recent.push(nowMs); this.posts.set(uid, recent);
      try { await this.o.sink(uid, formatWhale(t, why)); n++; } catch { this.failures++; }
    }
    return n;
  }
}
