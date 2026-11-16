/** Buy Bot for Telegram groups. EVIDENCE: the Maestro docs pages for Buy Bot are placeholders ("on the way"). The only documented claim is the homepage line that groups can monitor buys, sells and price
 *  changes for up to two tokens for free. EVERYTHING ELSE here (min buy size, sell notices, emoji scaling, ignore list, premium limit, message layout, rate limits) is OUR design, not Maestro's documented behavior.
 *  Safety: only a group ADMIN may change settings (the transport must pass isAdmin from Telegram's own member status; this module never decides who is an admin); posts go through an injected sink, so
 *  nothing here talks to Telegram; only FRESH trades are announced (a feed baseline is never posted); token names are third-party text and are sanitised; messages contain no URLs and no links. */
import type { FeedTrade } from '../../packages/live/src/tradefeed.ts';

/** From the Maestro homepage: "up to two tokens for free". The premium number is OUR placeholder (no documented value). */
export const BUYBOT_LIMITS = { free: 2, premium: 10 } as const;
export interface BuyBotCfg { tokens: string[]; minUsd: number; postSells: boolean; emojiStepUsd: number; ignoreWallets: string[]; tier: 'free' | 'premium' }
export const CHAIN_NAME: Record<string, string> = { ethereum: 'Ethereum', bnb: 'BNB Chain', solana: 'Solana' };
const ADDR = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
export const shortWallet = (w: string) => (w.length > 12 ? w.slice(0, 6) + '…' + w.slice(-4) : w);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 20) || '?';

export function formatBuyMessage(t: FeedTrade, c: Pick<BuyBotCfg, 'emojiStepUsd'>): string {
  const n = Math.max(1, Math.min(30, Math.floor(t.usd / c.emojiStepUsd)));
  const chg = t.chg == null ? '' : ` | 24h price change ${t.chg >= 0 ? '+' : ''}${t.chg.toFixed(1)}%`;
  return `${(t.side === 'buy' ? '🟢' : '🔴').repeat(n)}\n${t.side === 'buy' ? 'BUY' : 'SELL'} ${clean(t.sym)} on ${CHAIN_NAME[t.chain] ?? t.chain}\n$${Math.round(t.usd).toLocaleString('en')} by ${shortWallet(t.wallet)}${chg}`;
}

export class BuyBot {
  private groups = new Map<string, BuyBotCfg>(); private seen = new Map<string, Set<string>>(); private posts = new Map<string, number[]>(); failures = 0;
  constructor(private o: { sink: (groupId: string, text: string) => Promise<void> | void; maxPerWindow?: number; windowS?: number }) {}
  config(groupId: string): BuyBotCfg | undefined { return this.groups.get(groupId); }
  /** Union of token contracts any group watches, lower-cased, for the feed to poll. */
  watched(): Set<string> { const s = new Set<string>(); for (const g of this.groups.values()) for (const t of g.tokens) s.add(t.toLowerCase()); return s; }
  /** `/buybot status | add <token> | remove <token> | min <usd> | sells on|off | emoji <usd> | ignore <wallet> | unignore <wallet> | tier free|premium`. Only status is open to non-admins. */
  command(groupId: string, isAdmin: boolean, text: string): string {
    const [cmd, sub, arg] = text.trim().split(/\s+/); if (cmd !== '/buybot') return 'Unknown command.';
    const g = this.groups.get(groupId) ?? { tokens: [], minUsd: 100, postSells: false, emojiStepUsd: 50, ignoreWallets: [], tier: 'free' as const };
    if (!sub || sub === 'status') return `Buy Bot: ${g.tokens.length}/${BUYBOT_LIMITS[g.tier]} tokens (${g.tier}). Minimum ${g.minUsd} USD, sells ${g.postSells ? 'on' : 'off'}, one emoji per ${g.emojiStepUsd} USD, ${g.ignoreWallets.length} ignored wallets.${g.tokens.length ? ' Tokens: ' + g.tokens.map(shortWallet).join(', ') : ' No tokens yet: /buybot add <token address>.'}`;
    if (!isAdmin) return 'Only group admins can change the Buy Bot.';
    const num = () => { const n = Number(arg); return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : null; };
    let reply: string;
    switch (sub) {
      case 'add': if (!arg || !ADDR.test(arg)) return 'Send the token contract address, for example /buybot add 0x…'; if (g.tokens.some(t => t.toLowerCase() === arg.toLowerCase())) return 'That token is already watched.';
        if (g.tokens.length >= BUYBOT_LIMITS[g.tier]) return `This group already watches ${g.tokens.length} tokens, the ${g.tier} limit (${BUYBOT_LIMITS[g.tier]}). Remove one first.`;
        g.tokens.push(arg); reply = `Watching ${shortWallet(arg)}. Only tokens in the terminal's real list can be announced.`; break;
      case 'remove': if (!arg) return 'Say which token: /buybot remove <address>'; g.tokens = g.tokens.filter(t => t.toLowerCase() !== (arg ?? '').toLowerCase()); reply = 'Removed.'; break;
      case 'min': { const n = num(); if (n == null) return 'Send a positive number of USD, for example /buybot min 250'; g.minUsd = n; reply = `Only trades of ${n} USD or more are announced.`; break; }
      case 'emoji': { const n = num(); if (n == null || n < 1) return 'Send USD per emoji, at least 1, for example /buybot emoji 50'; g.emojiStepUsd = n; reply = `One emoji per ${n} USD (up to 30).`; break; }
      case 'sells': if (arg !== 'on' && arg !== 'off') return 'Say /buybot sells on or /buybot sells off'; g.postSells = arg === 'on'; reply = `Sell notices are ${arg}.`; break;
      case 'ignore': if (!arg || !ADDR.test(arg)) return 'Send a wallet address.'; if (!g.ignoreWallets.includes(arg.toLowerCase())) g.ignoreWallets.push(arg.toLowerCase()); reply = 'That wallet will not be announced.'; break;
      case 'unignore': g.ignoreWallets = g.ignoreWallets.filter(w => w !== (arg ?? '').toLowerCase()); reply = 'Removed from the ignore list.'; break;
      case 'tier': if (arg !== 'free' && arg !== 'premium') return 'Tier is free or premium.'; if (g.tokens.length > BUYBOT_LIMITS[arg as 'free' | 'premium']) return `Remove tokens first: ${arg} allows ${BUYBOT_LIMITS[arg as 'free' | 'premium']}.`; g.tier = arg as 'free' | 'premium'; reply = `Tier set to ${arg}. (Plan billing is not connected here.)`; break;
      default: return 'Commands: status, add, remove, min, sells, emoji, ignore, unignore, tier.';
    }
    this.groups.set(groupId, g); return reply;
  }
  /** Announce one trade to every group watching its token. Returns how many posts were made. A sink failure is counted and never thrown. */
  async handleTrade(t: FeedTrade, nowMs: number): Promise<number> {
    if (!t.fresh) return 0; let n = 0;
    for (const [gid, g] of this.groups) {
      if (!g.tokens.some(x => x.toLowerCase() === t.contract.toLowerCase())) continue;
      if (t.side === 'sell' && !g.postSells) continue; if (t.usd < g.minUsd) continue; if (g.ignoreWallets.includes(t.wallet.toLowerCase())) continue;
      const seen = this.seen.get(gid) ?? new Set<string>(); this.seen.set(gid, seen); if (seen.has(t.key)) continue;
      const recent = (this.posts.get(gid) ?? []).filter(x => nowMs - x < (this.o.windowS ?? 60) * 1000); if (recent.length >= (this.o.maxPerWindow ?? 20)) { this.posts.set(gid, recent); continue; }
      seen.add(t.key); if (seen.size > 2000) seen.delete(seen.values().next().value as string); recent.push(nowMs); this.posts.set(gid, recent);
      try { await this.o.sink(gid, formatBuyMessage(t, g)); n++; } catch { this.failures++; }
    }
    return n;
  }
}
