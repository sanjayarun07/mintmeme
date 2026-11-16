/** Real-time launch stream (Solana). READ-ONLY: it listens, it never signs or sends.
 *  A WebSocket `logsSubscribe` per feed pushes a notification when a confirmed transaction that mentions the feed's account logs something. Each notification is checked against the feed's
 *  log filter, the transaction is then fetched and decoded (same on-chain checks as the polled list), the mint account is inspected, a dry run of the example sniper rules is applied, and the
 *  item is pushed to every listener (the web page gets it over Server-Sent Events). Feeds:
 *   - Raydium AMM v4 pool creation: the pool-creation account; decoding is RaydiumLaunchSource.parse (owner = AMM v4 program, 752 bytes, mints from the pool account).
 *   - Pump.fun token creation: the mint-authority account that signs every creation; the new mint is the account initialised by an InitializeMint/InitializeMint2 instruction in the same transaction.
 *  Limits, stated plainly: notifications are at `confirmed` commitment, not finalized; the stream sees only what the endpoint pushes while connected (a dropped socket leaves a gap that is counted, not filled;
 *  the polled list still contains what happened in the gap); a public endpoint is rate limited and has no SLA; Pump.fun curves are not tradable by this engine, so those rows can never say "would buy". */
import { MintInspector } from '../../sol/src/index.ts';
import { b58decode, PROGRAMS } from '../../sol/src/tx.ts';
import { PAD, bondingCurveAddress } from './launchpads.ts';
import { applyDryRun } from './launchfeed.ts';
import type { LaunchItem, LaunchRules } from './launchfeed.ts';
import { DEFAULT_RULES } from './launchfeed.ts';

export interface WsLike { onopen: ((e: any) => void) | null; onmessage: ((e: { data: any }) => void) | null; onclose: ((e: any) => void) | null; onerror: ((e: any) => void) | null; send(d: string): void; close(): void }
export interface StreamFeed {
  name: string; mention: string;
  /** cheap filter on the notification's log lines; the transaction is only fetched when this says yes */
  match(logs: string[]): boolean;
  /** the newest signatures that mention the account (newest first), for the completeness poll */
  recent?(): Promise<{ signature: string; slot?: number; err?: unknown; blockTime?: number | null }[]>;
  /** decode one transaction into launch items (may be empty) */
  parse(sig: string, slot: number): Promise<LaunchItem[]>;
}
export interface StreamStatus {
  state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'; url: string; since: number | null; reconnects: number; gaps: number; received: number; matched: number; emitted: number; failed: number; polled: number;
  lastMessageAt: number | null; lastError: string | null; feeds: { name: string; subscribed: boolean; error?: string; received: number }[];
}
export interface StreamOpts {
  url: string; feeds: StreamFeed[]; wsFactory?: (url: string) => WsLike; now?: () => number; keep?: number; rules?: LaunchRules;
  backoffMs?: number[]; staleMs?: number; retryMs?: number[]; backfillMs?: number; backfillMaxAgeMs?: number; redact?: (s: string) => string;
  /** adds mint-risk verdict, flags and metadata after the transaction is decoded; failures leave the item as 'unchecked' */
  enrich?: (item: LaunchItem) => Promise<void>;
}

export class LaunchStream {
  private ws?: WsLike; private stopped = true; private timer?: ReturnType<typeof setTimeout>; private stale?: ReturnType<typeof setInterval>; private attempt = 0; private everOpen = false;
  private subs = new Map<number, string>(); private reqs = new Map<number, string>(); private nextReq = 1; private seen = new Set<string>(); private listeners = new Set<(i: LaunchItem) => void>();
  private queued = 0; private items: LaunchItem[] = [];
  private st: StreamStatus; private now: () => number;
  constructor(private o: StreamOpts) {
    this.now = o.now ?? Date.now;
    let host = ''; try { host = new URL(o.url).host; } catch { /* leave empty */ }        // host only: the path of a provider URL may carry a key
    this.st = { state: 'idle', url: host, since: null, reconnects: 0, gaps: 0, received: 0, matched: 0, emitted: 0, failed: 0, polled: 0, lastMessageAt: null, lastError: null, feeds: o.feeds.map(f => ({ name: f.name, subscribed: false, received: 0 })) };
  }
  private redact(s: string) { return this.o.redact ? this.o.redact(s) : s.split(this.o.url).join('<ws url>'); }
  status(): StreamStatus { return { ...this.st, feeds: this.st.feeds.map(f => ({ ...f })) }; }
  recent(n = 100): LaunchItem[] { return this.items.slice(0, n); }
  /** Restore items remembered from an earlier run (newest first). Only items that came from this stream are accepted; they are kept as they were seen. */
  seed(items: LaunchItem[]) { const have = new Set(this.items.map(i => i.sig)); const add = items.filter(i => { if (!(i && i.live && i.sig) || have.has(i.sig)) return false; have.add(i.sig); return true; }); this.items = [...this.items, ...add].sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0)).slice(0, this.o.keep ?? 100); for (const i of add) this.seen.add(i.sig!); }
  on(fn: (i: LaunchItem) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private bf?: ReturnType<typeof setInterval>;
  start() { if (!this.stopped) return; this.stopped = false; this.connect(); this.stale = setInterval(() => this.checkStale(), 10_000); (this.stale as any).unref?.();
    if (this.o.backfillMs !== 0) { this.bf = setInterval(() => { void this.backfill(); }, this.o.backfillMs ?? 15_000); (this.bf as any).unref?.(); const first = setTimeout(() => { void this.backfill(); }, 1500); (first as any).unref?.(); } }
  stop() { this.stopped = true; this.st.state = 'stopped'; clearTimeout(this.timer); clearInterval(this.stale); clearInterval(this.bf); try { this.ws?.close(); } catch { /* already closed */ } this.ws = undefined; for (const f of this.st.feeds) f.subscribed = false; }

  private checkStale() {
    const last = this.st.lastMessageAt ?? this.st.since; if (this.stopped || this.st.state !== 'open' || last === null) return;
    if (this.now() - last > (this.o.staleMs ?? 120_000)) { this.st.lastError = 'no notification for a long time: reconnecting'; try { this.ws?.close(); } catch { /* ignore */ } }
  }
  private connect() {
    this.st.state = this.everOpen ? 'reconnecting' : 'connecting'; this.subs.clear(); this.reqs.clear();
    let ws: WsLike;
    try { ws = (this.o.wsFactory ?? ((u: string) => new (globalThis as any).WebSocket(u) as WsLike))(this.o.url); }
    catch (e) { this.st.lastError = this.redact(`cannot open WebSocket: ${(e as Error).message}`); return this.scheduleReconnect(); }
    this.ws = ws;
    ws.onopen = () => {
      this.st.state = 'open'; this.st.since = this.now(); this.attempt = 0;
      if (this.everOpen) { this.st.reconnects++; this.st.gaps++; } this.everOpen = true;
      for (const f of this.o.feeds) { const id = this.nextReq++; this.reqs.set(id, f.name); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [f.mention] }, { commitment: 'confirmed' }] })); }
    };
    ws.onmessage = e => { try { this.onMessage(JSON.parse(String(e.data))); } catch (err) { this.st.lastError = this.redact(`bad message: ${(err as Error).message}`); } };
    ws.onerror = () => { this.st.lastError = this.st.lastError ?? 'WebSocket error'; };
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = undefined; for (const f of this.st.feeds) f.subscribed = false; if (!this.stopped) this.scheduleReconnect(); };
  }
  private scheduleReconnect() {
    if (this.stopped) return; const b = this.o.backoffMs ?? [1000, 2000, 5000, 15_000, 30_000]; const wait = b[Math.min(this.attempt++, b.length - 1)];
    this.st.state = this.everOpen ? 'reconnecting' : 'connecting'; this.timer = setTimeout(() => this.connect(), wait); (this.timer as any).unref?.();
  }
  private feedStatus(name: string) { return this.st.feeds.find(f => f.name === name)!; }
  private onMessage(j: any) {
    if (typeof j.id === 'number' && this.reqs.has(j.id)) {
      const name = this.reqs.get(j.id)!, fs = this.feedStatus(name);
      if (j.error) { fs.subscribed = false; fs.error = String(j.error.message ?? 'subscription refused'); this.st.lastError = `${name}: ${fs.error}`; }
      else { this.subs.set(j.result, name); fs.subscribed = true; delete fs.error; }
      return;
    }
    if (j.method !== 'logsNotification') return;
    const name = this.subs.get(j.params?.subscription), feed = this.o.feeds.find(f => f.name === name); if (!feed) return;
    const v = j.params.result?.value, slot: number = j.params.result?.context?.slot ?? 0; if (!v?.signature) return;
    this.st.received++; this.st.lastMessageAt = this.now(); this.feedStatus(feed.name).received++;
    if (v.err || this.seen.has(v.signature) || !feed.match(v.logs ?? [])) return;
    this.enqueue(feed, v.signature, slot, this.now(), 'ws');
  }
  /** Sends one transaction through decode, enrichment and the rules, then to the listeners. `via` says whether the WebSocket or the signature poll found it. */
  private enqueue(feed: StreamFeed, sig: string, slot: number, seenAt: number, via: 'ws' | 'poll') {
    this.seen.add(sig); if (this.seen.size > 3000) this.seen.delete(this.seen.values().next().value as string);
    this.st.matched++; if (via === 'poll') this.st.polled++;
    if (this.queued >= 150) { this.st.failed++; this.st.lastError = 'decoder queue full: a launch was not decoded'; return; }
    const v = { signature: sig };
    this.queued++; this.jobs.push(async () => {
      try {
        // the HTTP node can be a moment behind the WebSocket: "not available yet" is retried a few times before it counts as a failure
        for (const it of await this.retry(() => feed.parse(v.signature, slot))) {
          it.live = true; it.seenAt = seenAt; it.sig = v.signature; it.slot = slot; it.via = via;
          if (this.o.enrich) { try { await this.retry(() => this.o.enrich!(it)); } catch (e) { it.verdict = 'unchecked'; it.flags.push(`mint not inspected: ${this.redact((e as Error).message)}`); } }
          applyDryRun(it, this.o.rules ?? DEFAULT_RULES); this.items.unshift(it); if (this.items.length > (this.o.keep ?? 100)) this.items.length = this.o.keep ?? 100;
          this.st.emitted++; for (const l of this.listeners) { try { l(it); } catch { /* a listener must not break the stream */ } }
        }
      } catch (e) {
        this.st.failed++; this.st.lastError = this.redact(`${feed.name}: could not decode ${v.signature.slice(0, 8)}…: ${(e as Error).message}`);
        // a decode lost to a rate limit or a flaky node is given ONE more chance: forget it, so the next signature poll offers it again. A signature that fails twice stays failed.
        if (!this.retried.has(v.signature)) { this.retried.add(v.signature); this.seen.delete(v.signature); if (this.retried.size > 1000) this.retried.delete(this.retried.values().next().value as string); }
      }
      finally { this.queued--; }
    }); this.drain();
  }
  /** Completeness check: the public WebSocket was observed delivering only a fraction of the creations the chain recorded (14 in ~3 min against ~65), so every feed that can list its recent signatures
   *  is also polled. Anything the socket already delivered is skipped (same signature set). Items found this way carry their real block time as `seenAt` and `via: 'poll'`. */
  private async backfill() {
    if (this.stopped) return;
    for (const f of this.o.feeds) {
      if (!f.recent || this.queued >= 100) continue;
      try {
        const rows = await f.recent(); const cut = this.now() - (this.o.backfillMaxAgeMs ?? 30 * 60_000);
        for (const r of [...rows].reverse()) {
          if (r.err || this.seen.has(r.signature)) continue; const at = r.blockTime ? r.blockTime * 1000 : this.now(); if (at < cut) continue;
          this.enqueue(f, r.signature, r.slot ?? 0, at, 'poll');
        }
      } catch (e) { this.st.lastError = this.redact(`${f.name}: signature poll failed: ${(e as Error).message}`); }
    }
  }
  private retried = new Set<string>();
  private jobs: (() => Promise<void>)[] = []; private active = 0;
  private drain() { while (this.active < 4 && this.jobs.length) { const j = this.jobs.shift()!; this.active++; j().finally(() => { this.active--; this.drain(); }); } }
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    const waits = this.o.retryMs ?? [400, 800, 1500, 2500, 4000];
    for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= waits.length || !/not available yet|not found yet/.test((e as Error).message)) throw e; await new Promise(r => setTimeout(r, waits[i])); } }
  }
}

/* ---------- Token-2022 metadata (name / symbol live in the mint account itself) ---------- */
const TOKEN_METADATA_EXT = 19;
/** Reads the TokenMetadata extension (SPL token-metadata interface) from a Token-2022 mint account. Returns null when the mint has no such extension or the bytes do not fit. */
export function decodeToken2022Metadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  if (data.length <= 166 || data[165] !== 1) return null;
  let p = 166;
  while (p + 4 <= data.length) {
    const type = data.readUInt16LE(p), len = data.readUInt16LE(p + 2), body = p + 4; if (body + len > data.length) return null;
    if (type === TOKEN_METADATA_EXT) {
      let q = body + 64; const str = () => { if (q + 4 > body + len) throw new Error('short'); const n = data.readUInt32LE(q); q += 4; if (q + n > body + len) throw new Error('short'); const s = data.toString('utf8', q, q + n); q += n; return s; };
      try { const name = str(), symbol = str(), uri = str(); return { name, symbol, uri }; } catch { return null; }
    }
    p = body + len;
  }
  return null;
}

/* ---------- Solana feeds ---------- */
export interface SolFeedDeps {
  rpc: { call<T = any>(m: string, p?: unknown[]): Promise<T> };
  raydium: { parse(sig: string): Promise<{ token: string; venueId: string; block: number; quoteLiquidity?: bigint }[]> };
  fetchFn?: typeof fetch; now?: () => number; raydiumWatch: string; pumpWatch: string; pumpProgram?: string;
}
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';   // observed as the owner of live Pump.fun mints on 2026-11-14
const TOKEN_PROGRAMS = new Set([PROGRAMS.token, TOKEN_2022]);
const WSOL = 'So11111111111111111111111111111111111111112';

export function solanaFeeds(d: SolFeedDeps): StreamFeed[] {
  const now = d.now ?? Date.now, fetchFn = d.fetchFn ?? fetch, pumpProgram = d.pumpProgram ?? PAD.pump.program;
  let solUsd: { at: number; v: number | null } | undefined;
  const solPrice = async () => { if (solUsd && now() - solUsd.at < 60_000) return solUsd.v; let v: number | null = null;
    try { const j: any = await (await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${WSOL}`)).json(); const p = (j?.pairs ?? []).sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]; v = p?.priceUsd ? Number(p.priceUsd) : null; } catch { /* unknown */ }
    solUsd = { at: now(), v }; return v; };
  const base = (): Omit<LaunchItem, 'id' | 'sym' | 'name' | 'contract' | 'pool' | 'venue' | 'pad' | 'source' | 'liqUsd'> => ({ chain: 'solana', stage: 'new', ageMin: 0, price: null, verdict: 'unchecked', flags: [], dryRun: { wouldBuy: false, why: '' }, executable: false });
  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  return [
    { name: 'raydium-v4', mention: d.raydiumWatch, recent: () => d.rpc.call('getSignaturesForAddress', [d.raydiumWatch, { limit: 100, commitment: 'confirmed' }]),
      // Raydium logs the instruction name of the pool-creation instruction; the decode below re-checks everything on chain, so this is only a cheap pre-filter
      match: logs => logs.some(l => /initialize2/i.test(l)),
      async parse(sig) {
        const evs = await d.raydium.parse(sig), usd = evs.length ? await solPrice() : null;
        return evs.map(e => ({ ...base(), id: `raydium:${e.venueId}`, sym: short(e.token), name: 'New Raydium pool', contract: e.token, pool: e.venueId, venue: 'Raydium AMM v4', pad: null, source: 'raydium-creation' as const,
          liqUsd: usd !== null && e.quoteLiquidity !== undefined ? Number(e.quoteLiquidity) / 1e9 * usd * 2 : null }));
      } },
    { name: 'pump-fun-create', mention: d.pumpWatch, recent: () => d.rpc.call('getSignaturesForAddress', [d.pumpWatch, { limit: 100, commitment: 'confirmed' }]),
      match: logs => logs.some(l => /^Program log: Instruction: Create(V2|CoinAndBuy\w*)?$/.test(l)),
      async parse(sig) {
        const t: any = await d.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (!t) throw new Error('transaction not available yet'); const m = t.meta; if (!m || m.err) return [];
        const msg = t.transaction.message, keys: string[] = [...msg.accountKeys, ...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? [])];
        if (!keys.includes(pumpProgram)) return [];
        const calls = [...msg.instructions, ...(m.innerInstructions ?? []).flatMap((x: any) => x.instructions)] as { programIdIndex: number; data: string; accounts: number[] }[];
        const mints = new Set<string>();
        for (const c of calls) { if (!TOKEN_PROGRAMS.has(keys[c.programIdIndex])) continue; const tag = b58decode(c.data)[0]; if (tag === 0 || tag === 20) mints.add(keys[c.accounts[0]]); }   // InitializeMint / InitializeMint2
        return [...mints].map(mint => ({ ...base(), id: `pump:${mint}`, sym: short(mint), name: 'New Pump.fun token', contract: mint, pool: bondingCurveAddress(mint).toString(), venue: 'Pump.fun', pad: 'pump-fun' as const, source: 'launchpad' as const, liqUsd: null, creator: keys[0] }));
      } },
  ];
}

/** Mint-account enrichment: risk verdict and flags from MintInspector, and the name/symbol from the Token-2022 metadata extension when the mint has one. */
export function mintEnricher(rpc: { call<T = any>(m: string, p?: unknown[]): Promise<T> }, now: () => number = Date.now) {
  const inspector = new MintInspector(rpc as any, () => Math.floor(now() / 1000));
  return async (it: LaunchItem) => {
    if (it.chain !== 'solana') return;
    const r: any = await rpc.call('getAccountInfo', [it.contract, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r?.value) throw new Error('mint account not found yet');
    const data = Buffer.from(r.value.data[0], 'base64'); const meta = r.value.owner === TOKEN_2022 ? decodeToken2022Metadata(data) : null;
    if (meta && meta.symbol) { it.sym = meta.symbol; it.name = meta.name || it.name; }
    await inspector.inspect(it.contract); const rr = inspector.riskCheck({ token: it.contract }, 0); it.verdict = rr.verdict; it.flags = [...it.flags, ...rr.flags.filter(f => !/sell was not simulated|not simulated/.test(f))];
  };
}
