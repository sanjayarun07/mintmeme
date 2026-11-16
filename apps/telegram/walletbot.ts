/** Wallet Bot: read-only wallet balances and price alerts for private chats. EVIDENCE: the Maestro Wallet Bot docs page is a placeholder ("on the way"). The only documented claims are the homepage lines that it
 *  tracks wallet balances and sends price alerts on BSC, Ethereum and Arbitrum. EVERYTHING ELSE here (commands, limits, alert rules, message layout) is OUR design, not Maestro's documented behavior.
 *  Safety: strictly read-only. It never holds keys, never signs, never trades; it only asks the injected `balanceOf` / `priceOf` for public data. Wallet addresses are public and are shown shortened.
 *  Alerts fire once and then disarm (no spam); posting goes through an injected sink, so nothing here talks to Telegram. Token and wallet names are user text and are sanitised. */
export const WALLETBOT_CHAINS = ['bsc', 'ethereum', 'arbitrum'] as const;
export type WalletChain = typeof WALLETBOT_CHAINS[number];
/** OUR placeholders (no documented values). */
export const WALLETBOT_LIMITS = { wallets: 5, alerts: 10 } as const;
const NATIVE: Record<WalletChain, string> = { bsc: 'BNB', ethereum: 'ETH', arbitrum: 'ETH' };
const EVM = /^0x[0-9a-fA-F]{40}$/;
const short = (w: string) => w.slice(0, 6) + '…' + w.slice(-4);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 20);

export interface WatchedWallet { name: string; chain: WalletChain; address: string }
export interface PriceAlert { id: number; chain: WalletChain; token: string; dir: 'above' | 'below'; usd: number; armed: boolean }
export interface WalletBotDeps {
  /** Native balance in whole units for a public address, or null when the lookup failed. Read-only. */
  balanceOf(chain: WalletChain, address: string): Promise<number | null>;
  /** Spot price in USD for the chain's native coin (token = 'native') or a token contract, or null when unknown. Read-only. */
  priceOf(chain: WalletChain, token: string): Promise<number | null>;
  sink?: (userId: string, text: string) => Promise<void> | void;
}
interface UserState { wallets: WatchedWallet[]; alerts: PriceAlert[]; next: number }

export class WalletBot {
  private users = new Map<string, UserState>(); failures = 0;
  constructor(private d: WalletBotDeps) {}
  state(userId: string): UserState { let u = this.users.get(userId); if (!u) { u = { wallets: [], alerts: [], next: 1 }; this.users.set(userId, u); } return u; }

  /** `/wallet list | add <chain> <address> [name] | remove <name> | balance [name] | alert add <chain> <native|0xtoken> above|below <usd> | alert list | alert remove <id>`. Private chats only (the transport enforces that). */
  async command(userId: string, text: string): Promise<string> {
    const [cmd, sub, ...a] = text.trim().split(/\s+/); if (cmd !== '/wallet') return 'Unknown command.';
    const u = this.state(userId);
    switch (sub ?? 'list') {
      case 'list': return u.wallets.length ? 'Watched wallets:\n' + u.wallets.map(w => `${w.name}: ${short(w.address)} on ${w.chain}`).join('\n') : 'No wallets yet. Add one with /wallet add <bsc|ethereum|arbitrum> <address> [name]. This only watches a public address; it never holds keys.';
      case 'add': {
        const chain = a[0]?.toLowerCase() as WalletChain, addr = a[1];
        if (!chain || !(WALLETBOT_CHAINS as readonly string[]).includes(chain)) return `Pick a chain: ${WALLETBOT_CHAINS.join(', ')}. Example: /wallet add bsc 0x… main`;
        if (!addr || !EVM.test(addr)) return 'Send a public wallet address (0x followed by 40 hex characters). Never send a private key or seed phrase.';
        if (u.wallets.length >= WALLETBOT_LIMITS.wallets) return `You already watch ${u.wallets.length} wallets, the limit (${WALLETBOT_LIMITS.wallets}). Remove one first.`;
        const name = clean(a[2] ?? '') || `w${u.wallets.length + 1}`;
        if (u.wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) return 'That name is already used. Pick another.';
        if (u.wallets.some(w => w.chain === chain && w.address.toLowerCase() === addr.toLowerCase())) return 'You already watch that address on that chain.';
        u.wallets.push({ name, chain, address: addr }); return `Watching ${short(addr)} on ${chain} as "${name}".`;
      }
      case 'remove': { const n = (a[0] ?? '').toLowerCase(); const before = u.wallets.length; u.wallets = u.wallets.filter(w => w.name.toLowerCase() !== n); return u.wallets.length < before ? 'Removed.' : 'No wallet with that name. See /wallet list.'; }
      case 'balance': {
        const sel = a[0] ? u.wallets.filter(w => w.name.toLowerCase() === a[0]!.toLowerCase()) : u.wallets;
        if (!sel.length) return a[0] ? 'No wallet with that name. See /wallet list.' : 'No wallets yet. Add one with /wallet add.';
        const lines: string[] = [];
        for (const w of sel) { let b: number | null = null; try { b = await this.d.balanceOf(w.chain, w.address); } catch { this.failures++; } lines.push(b == null ? `${w.name} (${w.chain}): balance unavailable right now` : `${w.name} (${w.chain}): ${+b.toFixed(6)} ${NATIVE[w.chain]}`); }
        return lines.join('\n');
      }
      case 'alert': return this.alertCmd(u, a);
      default: return 'Commands: list, add, remove, balance, alert add|list|remove.';
    }
  }
  private alertCmd(u: UserState, a: string[]): string {
    const [op, ...r] = a;
    if (!op || op === 'list') return u.alerts.length ? 'Price alerts:\n' + u.alerts.map(x => `#${x.id}: ${x.token === 'native' ? NATIVE[x.chain] : short(x.token)} on ${x.chain} ${x.dir} ${x.usd} USD (${x.armed ? 'waiting' : 'fired'})`).join('\n') : 'No alerts. Example: /wallet alert add bsc native above 700';
    if (op === 'remove') { const id = Number(r[0]); const before = u.alerts.length; u.alerts = u.alerts.filter(x => x.id !== id); return u.alerts.length < before ? 'Removed.' : 'No alert with that number. See /wallet alert list.'; }
    if (op !== 'add') return 'Use /wallet alert add, list or remove.';
    const chain = r[0]?.toLowerCase() as WalletChain, token = r[1], dir = r[2], usd = Number(r[3]);
    if (!chain || !(WALLETBOT_CHAINS as readonly string[]).includes(chain)) return `Pick a chain: ${WALLETBOT_CHAINS.join(', ')}.`;
    if (!token || !(token.toLowerCase() === 'native' || EVM.test(token))) return 'Say "native" for the chain coin, or send a token contract address.';
    if (dir !== 'above' && dir !== 'below') return 'Say above or below. Example: /wallet alert add bsc native above 700';
    if (!Number.isFinite(usd) || usd <= 0 || usd > 1e9) return 'Send a price in USD greater than zero.';
    if (u.alerts.length >= WALLETBOT_LIMITS.alerts) return `You already have ${u.alerts.length} alerts, the limit (${WALLETBOT_LIMITS.alerts}). Remove one first.`;
    const x: PriceAlert = { id: u.next++, chain, token: token.toLowerCase() === 'native' ? 'native' : token, dir, usd, armed: true }; u.alerts.push(x);
    return `Alert #${x.id} set: tell me when ${x.token === 'native' ? NATIVE[chain] : short(token)} on ${chain} goes ${dir} ${usd} USD. It fires once.`;
  }

  /** Evaluate every armed alert against current prices. A fired alert disarms (fires once). An unknown price leaves the alert armed. Returns how many messages were sent. */
  async check(): Promise<number> {
    let sent = 0;
    for (const [uid, u] of this.users) for (const x of u.alerts) {
      if (!x.armed) continue; let p: number | null = null; try { p = await this.d.priceOf(x.chain, x.token); } catch { this.failures++; }
      if (p == null || !Number.isFinite(p)) continue; if (!(x.dir === 'above' ? p >= x.usd : p <= x.usd)) continue;
      x.armed = false;
      try { await this.d.sink?.(uid, `Price alert #${x.id}: ${x.token === 'native' ? NATIVE[x.chain] : short(x.token)} on ${x.chain} is ${+p.toPrecision(6)} USD, ${x.dir} your ${x.usd} USD line. This alert has fired and is now off.`); sent++; } catch { this.failures++; }
    }
    return sent;
  }
}
