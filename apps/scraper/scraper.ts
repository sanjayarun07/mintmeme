import { SignalFilter, type Candidate } from '../../packages/core/src/signals.ts';
import type { Intent } from '../../packages/core/src/types.ts';
import type { ChannelMessage, TelegramTransport, Credentials } from './transport.ts';
import { SessionStore } from './session-store.ts';

export interface ChannelFilter {
  allow?: string[]; deny?: string[];        // keyword lists, case-insensitive; allow = at least one must match
  minAgeS?: number; maxAgeS?: number;       // message age bounds (seconds)
  senders?: string[];                       // sender allowlist; empty/undefined = any
}
export interface TradePreset { amountIn: bigint; slippageBps: number; maxFeeBps: number; venues: string[]; ttlS: number }
export interface ScraperConfig {
  userId: string; walletId: string;
  channels: Record<string, ChannelFilter>;  // only listed channels are read
  presets: Record<string, TradePreset>;     // key = chain
  nativeByChain: Record<string, string>;
  maxSignalAgeS: number;
  mode: 'preview' | 'auto';                 // default 'preview'
}
export interface Preview { channel: string; msgId: number; chain: string; address: string; intent: Intent }
export type Decision = { ok: true; previews: Preview[] } | { ok: false; reason: string };

/** Channel text is untrusted DATA: it is only ever passed to extract()/keyword matching. No code path
 *  reads config, wallets or limits from message text. Config is frozen at construction. */
export class Scraper {
  readonly config: Readonly<ScraperConfig>;
  private filter: SignalFilter;
  private unsub?: () => void;
  readonly log: string[] = [];             // redacted, secret-free audit log
  constructor(cfg: ScraperConfig, validate: (c: Candidate) => { chain: string } | undefined,
              private now: () => number, private onCandidate?: (i: Intent) => void, autoEnabled = false) {
    // auto-trade requires BOTH mode:'auto' and the explicit flag; otherwise forced to preview
    const mode = cfg.mode === 'auto' && autoEnabled && onCandidate ? 'auto' : 'preview';
    this.config = Object.freeze({ ...cfg, mode });
    this.filter = new SignalFilter(cfg.maxSignalAgeS, validate);
  }

  /** Connect with USER-supplied credentials. Session is loaded from / saved to the encrypted store. */
  async start(t: TelegramTransport, creds: Credentials, store: SessionStore, passphrase: string, onDecision?: (m: ChannelMessage, d: Decision) => void) {
    let prev: string | undefined;
    if (store.exists) prev = store.load(passphrase);
    let res; try { res = await t.connect(creds, prev); } catch { throw new Error('transport connect failed'); }
    store.save(res.session, passphrase);
    this.unsub = t.onMessage(m => { const d = this.handle(m); this.log.push(`${m.channel}#${m.id}: ${d.ok ? d.previews.length + ' signal(s)' : d.reason}`); onDecision?.(m, d); });
  }
  stop() { this.unsub?.(); this.unsub = undefined; }

  handle(m: ChannelMessage): Decision {
    const f = this.config.channels[m.channel];
    if (!f) return { ok: false, reason: 'channel not configured' };
    const age = this.now() - m.ts;
    if (f.minAgeS !== undefined && age < f.minAgeS) return { ok: false, reason: 'too new' };
    if (f.maxAgeS !== undefined && age > f.maxAgeS) return { ok: false, reason: 'channel max age exceeded' };
    if (f.senders?.length && !f.senders.includes(m.sender)) return { ok: false, reason: 'sender not allowed' };
    const lower = m.text.toLowerCase();
    if (f.deny?.some(k => lower.includes(k.toLowerCase()))) return { ok: false, reason: 'denied keyword' };
    if (f.allow?.length && !f.allow.some(k => lower.includes(k.toLowerCase()))) return { ok: false, reason: 'no allowed keyword' };
    const r = this.filter.process(m.channel, m.text, m.ts, this.now());   // shared filter => cross-channel dedup
    if (typeof r === 'string') return { ok: false, reason: r };
    const previews: Preview[] = [];
    for (const s of r) {
      const p = this.config.presets[s.chain], native = this.config.nativeByChain[s.chain];
      if (!p || !native) continue;                                       // no preset => no trade candidate
      const t = this.now();
      const intent: Intent = { idempotencyKey: `scraper:${this.config.userId}:${s.chain}:${s.address.toLowerCase()}`, userId: this.config.userId, walletId: this.config.walletId,
        chain: s.chain, tokenIn: native, tokenOut: s.address, amountIn: p.amountIn, minOut: 0n, slippageBps: p.slippageBps, deadline: t + p.ttlS, maxFeeBps: p.maxFeeBps, venues: [...p.venues], origin: 'signal' };
      previews.push({ channel: m.channel, msgId: m.id, chain: s.chain, address: s.address, intent });
      if (this.config.mode === 'auto') this.onCandidate!(intent);        // callback only; this module never submits or signs
    }
    return previews.length ? { ok: true, previews } : { ok: false, reason: 'no preset for resolved chain' };
  }
}
