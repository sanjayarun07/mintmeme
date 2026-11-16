import { extract } from '../../packages/core/src/index.ts';
import type { Intent } from '../../packages/core/src/index.ts';

/** Transport-agnostic Telegram command handler. Wire to Bot API (blocked: no bot token) by calling handle() per update.
 *  Same engine + account state as web: it only builds Intents and calls the injected submit(). */
export interface Ctx { userId: string; walletId: string; chain: string; native: string; autoTrade: boolean; submit(i: Intent): Promise<{ state: string }>; now(): number; quickBuy: bigint;
  /** Optional amount parser for terminals whose amounts are not raw base units (e.g. '0.01' ETH). Must throw an Error with a plain message on bad input. Default: a whole number of base units. */
  amount?(text: string, side: 'buy' | 'sell'): bigint }
const SEED = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;           // 12–24 lowercase words
const PRIV = /\b(?:0x)?[a-fA-F0-9]{64}\b/;

/** True when the text looks like a seed phrase or private key (the bot deletes such messages from the chat). */
export const looksSecret = (text: string) => (SEED.test(text.toLowerCase()) && !text.startsWith('/')) || PRIV.test(text);

export async function handle(text: string, c: Ctx): Promise<string> {
  if (SEED.test(text.toLowerCase()) && !text.startsWith('/') || PRIV.test(text))
    return 'That looks like a seed phrase or private key. Never send secrets in chat — delete the message. Wallet import happens only in the secure web flow, if your operator enabled it.';
  const [cmd, ...a] = text.trim().split(/\s+/);
  if (cmd === '/withdraw' || cmd === '/export' || cmd === '/import')
    return 'Withdrawals, exports and imports cannot be authorized from Telegram. Use the secure confirmation page with your device key.';
  if (cmd === '/buy' || cmd === '/sell') {
    const token = a[0]; if (!token) return 'Usage: /buy <token> [amount]';
    const buy = cmd === '/buy'; let amt: bigint;
    try { amt = a[1] ? (c.amount ? c.amount(a[1], buy ? 'buy' : 'sell') : BigInt(a[1])) : c.quickBuy; } catch (e) { return `${cmd.slice(1)} ${token}: ${c.amount ? (e as Error).message : `the amount must be a whole number, for example ${cmd} ${token} 1000.`}`; }
    if (amt <= 0n) return `${cmd.slice(1)} ${token}: the amount must be more than zero.`;
    if (!buy && !a[1]) return 'Usage: /sell <token> <amount>';
    const i: Intent = { idempotencyKey: `tg:${c.userId}:${token}:${cmd}:${amt}:${Math.floor(c.now() / 30)}`, userId: c.userId, walletId: c.walletId, chain: c.chain,
      tokenIn: buy ? c.native : token, tokenOut: buy ? token : c.native, amountIn: amt, minOut: 0n, slippageBps: 300, deadline: c.now() + 120, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'telegram' };
    let r: { state: string }; try { r = await c.submit(i); } catch (e) { return `${cmd.slice(1)} ${token}: not sent. ${(e as Error).message}`; }
    const inFlight = !/^(confirmed|finalized|failed|expired)/.test(r.state);   // only a trade still on its way needs the "not a fill yet" warning
    return `${cmd.slice(1)} ${token}: state=${r.state}.${inFlight ? ' Submission is not a fill: wait for "confirmed".' : ''}`;
  }
  // Untrusted message text: extract candidates only. Never alters limits, wallets or settings.
  const found = extract(text);
  if (found.length) return c.autoTrade ? `Auto-trade enabled for this source: ${found.length} candidate(s) queued for validation.` : `Preview only: ${found.map(f => `${f.family}:${f.address}`).join(', ')}. Auto-trade is OFF; use /buy to trade.`;
  return 'Commands: /buy <token> [amount], /sell <token> <amount>';
}
