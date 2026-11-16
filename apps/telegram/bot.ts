/** Telegram Bot API transport (long polling) for the transport-agnostic handler. Dependency-free (fetch). Status: LOCALLY TESTED against an in-process mock of the Bot API only;
 *  it has never talked to Telegram (no bot token in this repo). Security rules enforced here:
 *   - only PRIVATE chats that an operator linked to a user (chat id -> Ctx factory) are served; groups, channels and unlinked chats get no trading access;
 *   - a message that looks like a seed phrase or private key is deleted from the chat and answered with a warning, and is never passed on;
 *   - the bot token lives only in the request URL and is stripped from every error message; updates are deduplicated by update_id (at-most-once handling). */
import { handle, looksSecret } from './handler.ts';
import type { Ctx } from './handler.ts';
import type { BuyBot } from './buybot.ts';
import type { WalletBot } from './walletbot.ts';
import type { LinkStore } from './linking.ts';

export interface BotConfig { token: string; links: Map<number, () => Ctx>; apiBase?: string; fetchFn?: typeof fetch; pollTimeoutS?: number;
  /** Optional community bots. Groups get ONLY `/buybot` (and only an admin, per Telegram's own getChatMember, may change settings); private chats get `/wallet` (read-only). Neither can trade. */
  buyBot?: BuyBot; walletBot?: WalletBot;
  /** Account linking: `/link <code>` ties a private chat to the account that asked for the code; `ctxFor` builds that account's trading context. Without both, only `links` is used. */
  linker?: LinkStore; ctxFor?: (userId: string) => Ctx }
const MAX = 4096;
export class TelegramBot {
  offset = 0; handled = new Set<number>(); log: string[] = [];
  constructor(private c: BotConfig) { if (!c.token) throw new Error('bot token required'); }
  private redact(s: string) { return s.split(this.c.token).join('***'); }
  private async api<T>(method: string, body: object): Promise<T> {
    let res: Response;
    try { res = await (this.c.fetchFn ?? fetch)(`${this.c.apiBase ?? 'https://api.telegram.org'}/bot${this.c.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { throw new Error(this.redact(`telegram ${method} unreachable: ${(e as Error).message}`)); }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) { const e: any = new Error(this.redact(`telegram ${method} failed: ${j.description ?? 'HTTP ' + res.status}`)); e.retryAfter = j.parameters?.retry_after; throw e; }
    return j.result as T;
  }
  /** Post a message to a chat the bot is in (used by the Buy Bot and Wallet Bot sinks). Same 4096-character splitting and token redaction as replies. */
  async post(chat: number | string, text: string) { for (let i = 0; i < text.length || i === 0; i += MAX) await this.api('sendMessage', { chat_id: chat, text: text.slice(i, i + MAX), disable_web_page_preview: true }); }
  private async send(chat: number, text: string) { for (let i = 0; i < text.length || i === 0; i += MAX) await this.api('sendMessage', { chat_id: chat, text: text.slice(i, i + MAX) }); }

  /** Telegram's own member status decides who is an admin. Any failure or unknown status means NOT an admin (fails closed). */
  async isAdmin(chat: number, user: number): Promise<boolean> {
    try { const r = await this.api<{ status?: string }>('getChatMember', { chat_id: chat, user_id: user }); return r?.status === 'creator' || r?.status === 'administrator'; } catch { return false; }
  }
  /** One long-poll round. Returns how many updates were processed. Never throws on a bad update: it is logged and skipped so one message cannot wedge the loop. */
  async pollOnce(): Promise<number> {
    const updates = await this.api<any[]>('getUpdates', { offset: this.offset, timeout: this.c.pollTimeoutS ?? 25, allowed_updates: ['message'] });
    let n = 0;
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      if (this.handled.has(u.update_id)) continue; this.handled.add(u.update_id);
      try { if (await this.one(u)) n++; } catch (e) { this.log.push(this.redact(`update ${u.update_id}: ${(e as Error).message}`)); }
    }
    return n;
  }
  private async one(u: any): Promise<boolean> {
    const m = u.message; if (!m || typeof m.text !== 'string' || !m.chat) return false;
    if (m.chat.type !== 'private') {                                                // groups/channels never trade; the only thing they get is the Buy Bot settings command
      if ((m.chat.type === 'group' || m.chat.type === 'supergroup') && this.c.buyBot && /^\/buybot(@\w+)?(\s|$)/.test(m.text)) {
        const admin = m.from?.id != null && await this.isAdmin(m.chat.id, m.from.id);
        await this.send(m.chat.id, this.c.buyBot.command(String(m.chat.id), admin, m.text.replace(/^\/buybot@\w+/, '/buybot'))); return true;
      }
      return false;
    }
    if (looksSecret(m.text)) { await this.api('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {}); await this.send(m.chat.id, 'I deleted your message because it looked like a seed phrase or private key. Never send secrets in chat. If it was real, move the funds to a new wallet now.'); return true; }
    const lk = this.c.linker;
    if (/^\/(start|help)(@\w+)?\s*$/.test(m.text)) { await this.send(m.chat.id, lk ? 'Commands:\n/link <code>: link this chat to your terminal account (get a code in the terminal under Settings)\n/unlink: remove the link\n/buy <token> [amount] and /sell <token> <amount>: trade from a linked chat\n/wallet: read-only balances and price alerts\nNever send a seed phrase or private key here.' : 'Commands: /wallet (read-only balances and price alerts). Trading from this chat is not enabled.'); return true; }
    if (lk && /^\/link(@\w+)?(\s|$)/.test(m.text)) {
      const arg = m.text.replace(/^\/link(@\w+)?/, '').trim(); if (!arg) { await this.send(m.chat.id, 'Send /link followed by the code from the terminal, for example /link ABCD2345. Get a code under Settings, Telegram.'); return true; }
      const r = lk.redeem(m.chat.id, arg);
      if (r.ok) { await this.api('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {}); await this.send(m.chat.id, 'Linked. This chat can now use /buy and /sell for your account, within your wallet limits. Send /unlink to remove it.'); }
      else await this.send(m.chat.id, r.reason === 'locked' ? 'Too many wrong codes. Wait 10 minutes, then ask the terminal for a new code.' : r.reason === 'too-many-chats' ? 'This account already has 3 linked chats. Unlink one in the terminal first.' : 'That code is not valid. Codes work once and expire after 10 minutes. Get a new one in the terminal.');
      return true;
    }
    if (lk && /^\/unlink(@\w+)?\s*$/.test(m.text)) { await this.send(m.chat.id, lk.unlink(m.chat.id) ? 'Unlinked. This chat can no longer trade.' : 'This chat was not linked.'); return true; }
    const uid = lk?.userOf(m.chat.id), make = this.c.links.get(m.chat.id) ?? (uid && this.c.ctxFor ? () => this.c.ctxFor!(uid) : undefined);
    if (this.c.walletBot && /^\/wallet(@\w+)?(\s|$)/.test(m.text)) { await this.send(m.chat.id, await this.c.walletBot.command(String(m.chat.id), m.text.replace(/^\/wallet@\w+/, '/wallet'))); return true; }   // read-only: no link needed, no keys, no trades
    if (!make) { await this.send(m.chat.id, lk ? 'This chat is not linked to a trading account. In the terminal open Settings, Telegram, press Link Telegram, then send /link followed by the code here.' : 'This chat is not linked to an account.'); return true; }
    await this.send(m.chat.id, await handle(m.text, make())); return true;
  }
  /** Run until `stop()`; backs off on errors and honours Telegram's retry_after. */
  async run(stopped: () => boolean, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
    let delay = 1000;
    while (!stopped()) { try { await this.pollOnce(); delay = 1000; } catch (e: any) { this.log.push((e as Error).message); await sleep(e.retryAfter ? e.retryAfter * 1000 : delay); delay = Math.min(delay * 2, 30_000); } }
  }
}
