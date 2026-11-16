/** Push notifications for tracked Solana wallets over a provider WebSocket (Helius works; any Solana `logsSubscribe` endpoint does).
 *  One `logsSubscribe {mentions:[wallet]}` per wallet. A notification means "this wallet was mentioned by a transaction": the listener gets the signature and wallet within seconds,
 *  instead of waiting for the next poll. The listener then reads the transaction with the existing parser (SolLeaderWatcher), so swap detection is unchanged; this only removes the waiting.
 *  Why not Helius webhooks: they need a public URL to call and create a resource on the provider account; this works from a laptop and changes nothing there.
 *  Reconnects with backoff and re-subscribes; a silent socket (no message, not even a subscription reply, for `staleMs`) is closed and reopened. Read-only: nothing is signed or sent.
 *  The URL may carry an API key: only its host is ever exposed in status() or errors. */
import type { WsLike } from './launchstream.ts';

export interface PushOpts {
  url: string; wallets: string[]; onActivity: (a: { wallet: string; signature: string; failed: boolean; slot: number }) => void;
  wsFactory?: (url: string) => WsLike; now?: () => number; staleMs?: number; backoffMs?: (attempt: number) => number; setTimer?: typeof setTimeout; commitment?: 'confirmed' | 'finalized';
}
export interface PushStatus { state: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'; host: string; wallets: number; subscribed: number; notifications: number; reconnects: number; lastMessageAt: number | null; lastError: string | null }

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export class WalletPush {
  private ws?: WsLike; private stopped = true; private attempt = 0; private timer?: ReturnType<typeof setTimeout>; private stale?: ReturnType<typeof setInterval>;
  private reqs = new Map<number, string>(); private subs = new Map<number, string>(); private nextReq = 1; private seen = new Set<string>(); private st: PushStatus; private now: () => number;
  constructor(private o: PushOpts) {
    this.now = o.now ?? Date.now; let host = ''; try { host = new URL(o.url).host; } catch { /* empty */ }
    const bad = o.wallets.filter(w => !SOL_ADDR.test(w)); if (bad.length) throw new Error(`not a Solana address: ${bad[0].slice(0, 12)}…`);
    this.st = { state: 'idle', host, wallets: new Set(o.wallets).size, subscribed: 0, notifications: 0, reconnects: 0, lastMessageAt: null, lastError: null };
  }
  status(): PushStatus { return { ...this.st }; }
  private redact(s: string) { return s.split(this.o.url).join('<ws url>'); }
  start() { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop() { this.stopped = true; this.st.state = 'stopped'; if (this.timer) clearTimeout(this.timer); if (this.stale) clearInterval(this.stale); try { this.ws?.close(); } catch { /* ignore */ } }
  private open() {
    this.st.state = this.attempt ? 'reconnecting' : 'connecting'; this.reqs.clear(); this.subs.clear(); this.st.subscribed = 0;
    let ws: WsLike; try { ws = (this.o.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.o.url); } catch (e) { this.fail((e as Error).message); return; }
    this.ws = ws; ws.onopen = () => {
      this.attempt = 0; this.st.lastMessageAt = this.now();
      for (const w of new Set(this.o.wallets)) { const id = this.nextReq++; this.reqs.set(id, w); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [w] }, { commitment: this.o.commitment ?? 'confirmed' }] })); }
    };
    ws.onmessage = e => this.message(String(e.data));
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => { if (!this.stopped && this.ws === ws) this.fail('the connection closed'); };
    if (this.stale) clearInterval(this.stale);
    const stale = this.o.staleMs ?? 60_000; this.stale = setInterval(() => { if (!this.stopped && this.st.lastMessageAt !== null && this.now() - this.st.lastMessageAt > stale && this.st.subscribed === 0) { try { ws.close(); } catch { /* ignore */ } this.fail('no reply from the provider'); } }, Math.max(1000, stale / 4));
  }
  private message(raw: string) {
    this.st.lastMessageAt = this.now(); let j: any; try { j = JSON.parse(raw); } catch { return; }
    if (typeof j.id === 'number' && this.reqs.has(j.id)) {                                  // reply to a subscribe request
      const w = this.reqs.get(j.id)!; this.reqs.delete(j.id);
      if (j.error) { this.st.lastError = this.redact(String(j.error.message ?? 'subscribe failed')).slice(0, 160); return; }
      if (typeof j.result === 'number') { this.subs.set(j.result, w); this.st.subscribed = this.subs.size; this.st.state = 'live'; } return;
    }
    if (j.method !== 'logsNotification') return;
    const w = this.subs.get(j.params?.subscription), v = j.params?.result?.value, slot = Number(j.params?.result?.context?.slot);
    if (!w || !v || typeof v.signature !== 'string') return;
    const key = `${w}|${v.signature}`; if (this.seen.has(key)) return; this.seen.add(key); if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    this.st.notifications++; try { this.o.onActivity({ wallet: w, signature: v.signature, failed: v.err !== null && v.err !== undefined, slot: Number.isFinite(slot) ? slot : 0 }); } catch { /* a listener error must not drop the stream */ }
  }
  private fail(msg: string) {
    this.st.lastError = this.redact(msg).slice(0, 160); this.st.reconnects++; this.attempt++; try { this.ws?.close(); } catch { /* ignore */ } if (this.stale) clearInterval(this.stale);
    if (this.stopped) return; this.st.state = 'reconnecting'; const wait = (this.o.backoffMs ?? ((a: number) => Math.min(30_000, 500 * 2 ** (a - 1))))(this.attempt);
    this.timer = (this.o.setTimer ?? setTimeout)(() => { if (!this.stopped) this.open(); }, wait);
  }
}

/** HELIUS_API_KEY may hold the bare key or the whole RPC/WebSocket URL copied from the dashboard; both work. Returns null when unset or unreadable. */
export function heliusKey(v: string | undefined): string | null { v = v?.trim(); if (!v) return null; if (/^(https?|wss?):/.test(v)) { try { return new URL(v).searchParams.get('api-key'); } catch { return null; } } return /^[A-Za-z0-9-]{8,}$/.test(v) ? v : null; }
export const heliusWs = (key: string) => `wss://mainnet.helius-rpc.com/?api-key=${key}`;
export const heliusHttp = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
