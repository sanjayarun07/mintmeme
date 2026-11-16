/** Links a private Telegram chat to a trading account. The account owner asks the terminal for a one-time code, then sends `/link <code>` to the bot from the chat to link.
 *  Rules: a code is random (8 characters, no look-alike letters), works once, expires after 10 minutes, and each account may hold at most 3 unused codes.
 *  A chat that guesses wrong 5 times in 10 minutes is locked out for the rest of that window. A chat links to one account; an account may link several chats (max 3).
 *  Codes live only in memory (a restart invalidates them). Chat -> account links are kept in memory and, if a file is given, saved there (account ids and chat ids only; no keys, no codes). */
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
export const LINK_LIMITS = { codeTtlS: 600, unusedCodes: 3, chatsPerAccount: 3, badTries: 5, badWindowS: 600 };
export type LinkResult = { ok: true; userId: string } | { ok: false; reason: 'bad-code' | 'locked' | 'too-many-chats' };

export class LinkStore {
  private codes = new Map<string, { userId: string; exp: number }>();
  private chats = new Map<number, string>();
  private bad = new Map<number, { n: number; since: number }>();
  constructor(private o: { now?: () => number; file?: string; random?: (n: number) => number } = {}) {
    if (o.file) { try { const j = JSON.parse(readFileSync(o.file, 'utf8')); for (const [c, u] of Object.entries(j.chats ?? {})) if (typeof u === 'string') this.chats.set(Number(c), u); } catch { /* no file yet */ } }
  }
  private now() { return (this.o.now ?? Date.now)() / 1000; }
  private save() { if (this.o.file) { try { writeFileSync(this.o.file, JSON.stringify({ chats: Object.fromEntries(this.chats) })); } catch { /* disk not writable: links last until restart */ } } }
  private sweep() { const t = this.now(); for (const [c, v] of this.codes) if (v.exp <= t) this.codes.delete(c); }

  /** New one-time code for an account. Asking again past the limit drops the oldest unused code. */
  issue(userId: string): { code: string; expiresInS: number } {
    this.sweep();
    const mine = [...this.codes.entries()].filter(([, v]) => v.userId === userId).sort((a, b) => a[1].exp - b[1].exp);
    while (mine.length >= LINK_LIMITS.unusedCodes) this.codes.delete(mine.shift()![0]);
    let code = ''; do { code = Array.from({ length: 8 }, () => ALPHABET[(this.o.random ?? randomInt)(ALPHABET.length)]).join(''); } while (this.codes.has(code));
    this.codes.set(code, { userId, exp: this.now() + LINK_LIMITS.codeTtlS }); return { code, expiresInS: LINK_LIMITS.codeTtlS };
  }
  /** Try a code from a chat. A wrong, expired or used code all look the same to the sender. */
  redeem(chat: number, raw: string): LinkResult {
    this.sweep(); const t = this.now(), b = this.bad.get(chat);
    if (b && t - b.since < LINK_LIMITS.badWindowS && b.n >= LINK_LIMITS.badTries) return { ok: false, reason: 'locked' };
    const code = raw.trim().toUpperCase().replace(/[\s-]/g, ''), hit = this.codes.get(code);
    if (!hit) { this.bad.set(chat, !b || t - b.since >= LINK_LIMITS.badWindowS ? { n: 1, since: t } : { n: b.n + 1, since: b.since }); return { ok: false, reason: 'bad-code' }; }
    const already = [...this.chats.entries()].filter(([c, u]) => u === hit.userId && c !== chat).length;
    if (already >= LINK_LIMITS.chatsPerAccount) return { ok: false, reason: 'too-many-chats' };
    this.codes.delete(code); this.bad.delete(chat); this.chats.set(chat, hit.userId); this.save(); return { ok: true, userId: hit.userId };
  }
  userOf(chat: number): string | undefined { return this.chats.get(chat); }
  chatsOf(userId: string): number[] { return [...this.chats.entries()].filter(([, u]) => u === userId).map(([c]) => c); }
  unlink(chat: number): boolean { const had = this.chats.delete(chat); if (had) this.save(); return had; }
  unlinkAccount(userId: string): number { let n = 0; for (const [c, u] of [...this.chats]) if (u === userId) { this.chats.delete(c); n++; } if (n) this.save(); return n; }
}
