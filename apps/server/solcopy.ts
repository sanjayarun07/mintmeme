/** COPY TRADING for the execution server's real Solana accounts (MODE=solana-mainnet): POST/GET/DELETE /v1/copies.
 *
 *  A copy config follows one or more leader wallets. Its leader source is `SolLeaderWatcher` (packages/sol/src/leaderwatch.ts), which reads the leaders' confirmed transactions
 *  and turns each into a swap from the leader's own balance changes; `CopyRunner` (packages/core/src/copyrunner.ts) applies the copy rules (sizing, caps, cooldown, exits) and
 *  hands the trades to the account's engine, so every copied trade is signed by Privy within the account's policy and SOL caps, like a manual one.
 *
 *  Rules:
 *   - Never copies history. The first poll, made when the config is created, only records where "now" is. A leader buy older than `maxAgeSlots` (about a minute) when it is
 *     seen is not copied either: after a long outage the follower does not chase old trades. Leader sells of what the copy bought are still followed.
 *   - A copied BUY goes through the same checks as a manual buy, BEFORE the copy rules see it (`gate`): token safety (`checkBuy`, the user's tokenSafety setting), and for a
 *     registered tokenized stock the operator switch (STOCKS_ENABLED) and the fill-price check against the share price. A check that fails, or cannot run, skips the trade
 *     (fail closed) and the reason is listed on GET /v1/copies.
 *   - Per-trade and daily SOL caps are no higher than the account's caps (the policy signer enforces the account caps across everything anyway).
 *   - The configs are kept in the user's durable state (`copies`), each runner's attribution, in-flight trades and leader cursors in `copy-<id>` (written ahead of every send),
 *     so after a restart or a failover to another node the configs come back and nothing is copied twice. DELETE forgets both. */
import { randomUUID } from 'node:crypto';
import type { Backend, CopyConfig, CopyRunner, LeaderEvent, LeaderSource } from '../../packages/core/src/index.ts';
import { SolLeaderWatcher, looksLikeMint, findStock } from '../../packages/sol/src/index.ts';
import type { SolRpc } from '../../packages/sol/src/raydium.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';
import { toUnits } from '../../packages/sdk/src/solana.ts';
import { SdkError, ID_RE } from '../../packages/sdk/src/wire.ts';
import type { AccountCopies } from './node.ts';

export const WSOL = 'So11111111111111111111111111111111111111112';
export const MAX_COPIES = 10, MAX_LEADERS = 10, MAX_LIST = 200;
/** One copy config as saved in the user's state. Amounts are lamports as decimal strings. */
export interface SavedCopy {
  id: string; leaders: string[]; sizing: { fixedLamports: string } | { percent: number };
  maxPerTradeLamports: string; dailyLamports: string; maxPerTokenLamports: string;
  allow?: string[]; block?: string[]; sides: 'buy' | 'both'; exitMode: NonNullable<CopyConfig['exitMode']>;
  slippageBps: number; cooldownS: number; maxPositions: number; minConfirmations: number; maxDeviationBps: number; maxAgeSlots: number; trackOnly: boolean; createdAt: number;
}
const sol = (lamports: string | bigint) => { const v = BigInt(lamports), w = v / 1_000_000_000n, f = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; };
const num = (v: unknown, what: string, lo: number, hi: number, int = false) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new SdkError('bad_number', `${what} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi}`);
  return n;
};
/** A list of mints; a registered stock ticker (TSLAx) is accepted and becomes its mint. */
const mints = (v: unknown, what: string) => {
  if (v === undefined) return undefined; if (!Array.isArray(v) || v.length > MAX_LIST) throw new SdkError('bad_request', `${what} must be a list of up to ${MAX_LIST} token mints`);
  return [...new Set(v.map(x => { const t = String(x).trim(); if (looksLikeMint(t)) return t; const s = findStock(t); if (s) return s.mint; throw new SdkError('bad_token', `${what}: "${t}" is not a Solana mint address`); }))];
};

/** Validate a POST /v1/copies body (plain units) into a saved config. `follower` is the account's wallet (it cannot follow itself). */
export function parseCopyBody(b: any, o: { caps: { maxTradeLamports: bigint; dailyCapLamports: bigint }; follower: string; now: number }): SavedCopy {
  if (!b || typeof b !== 'object') throw new SdkError('bad_request', 'send a JSON object');
  const known = new Set(['id', 'leader', 'leaders', 'fixedSol', 'percent', 'maxPerTradeSol', 'dailySol', 'maxPerTokenSol', 'allow', 'block', 'sides', 'exitMode', 'slippagePct', 'cooldownS', 'maxPositions', 'minConfirmations', 'maxDeviationPct', 'maxAgeSlots', 'trackOnly', 'walletId']);
  const extra = Object.keys(b).filter(k => !known.has(k)); if (extra.length) throw new SdkError('bad_request', `unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`, `Fields: ${[...known].filter(k => k !== 'walletId').join(', ')}.`);
  if (b.walletId !== undefined && b.walletId !== o.follower) throw new SdkError('bad_request', 'a copy trades the linked wallet: leave walletId out');
  const id = b.id === undefined ? `c-${randomUUID().slice(0, 8)}` : String(b.id); if (!ID_RE.test(id)) throw new SdkError('bad_text', 'id must be 1 to 128 letters, digits, dot, dash, underscore or colon');
  const raw = b.leaders ?? (b.leader === undefined ? undefined : [b.leader]);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LEADERS || (b.leaders !== undefined && b.leader !== undefined)) throw new SdkError('bad_request', `send leader (one address) or leaders (1 to ${MAX_LEADERS} addresses)`);
  const leaders = [...new Set(raw.map(x => String(x).trim()))];
  for (const l of leaders) { if (!looksLikeMint(l)) throw new SdkError('bad_address', `leader ${l} is not a Solana address`); if (l === o.follower) throw new SdkError('bad_address', 'a wallet cannot copy itself'); }
  if ((b.fixedSol === undefined) === (b.percent === undefined)) throw new SdkError('bad_request', 'send exactly one sizing rule: fixedSol (the same SOL amount on every copied buy) or percent (of the SOL the leader spent, 0.01 to 1000)');
  const cap = (v: unknown, what: string, ceiling: bigint, def: bigint) => { if (v === undefined) return def; const x = toUnits(v, 9, what); if (x > ceiling) throw new SdkError('above_cap', `${what} ${sol(x)} is above this account's limit of ${sol(ceiling)} SOL`, `Send ${sol(ceiling)} or less.`); return x; };
  const maxPerTrade = cap(b.maxPerTradeSol, 'maxPerTradeSol', o.caps.maxTradeLamports, o.caps.maxTradeLamports), daily = cap(b.dailySol, 'dailySol', o.caps.dailyCapLamports, o.caps.dailyCapLamports);
  const perToken = cap(b.maxPerTokenSol, 'maxPerTokenSol', daily, daily);
  if (maxPerTrade > daily) throw new SdkError('bad_amount', 'maxPerTradeSol is above dailySol');
  let sizing: SavedCopy['sizing'];
  if (b.fixedSol !== undefined) { const f = toUnits(b.fixedSol, 9, 'fixedSol'); if (f > maxPerTrade) throw new SdkError('above_cap', `fixedSol ${sol(f)} is above the per-trade cap of ${sol(maxPerTrade)} SOL`, 'Lower fixedSol or raise maxPerTradeSol (up to the account limit).'); sizing = { fixedLamports: f.toString() }; }
  else { const p = num(b.percent, 'percent', 0.01, 1000); sizing = { percent: Math.round(p * 100) / 100 }; }
  const allow = mints(b.allow, 'allow'), block = mints(b.block, 'block');
  if (allow && !allow.length) throw new SdkError('bad_request', 'allow is empty: nothing would be copied (leave it out to allow every token)');
  const sides = b.sides ?? 'both'; if (sides !== 'buy' && sides !== 'both') throw new SdkError('bad_request', 'sides must be "both" (copy buys, follow the leader\'s sells of what was copied) or "buy" (copy buys only)');
  const exitMode = b.exitMode ?? 'full-on-exit'; if (!['proportional', 'full-on-exit', 'full-on-any-sell', 'ignore'].includes(exitMode)) throw new SdkError('bad_request', 'exitMode must be proportional, full-on-exit, full-on-any-sell or ignore');
  if (b.trackOnly !== undefined && typeof b.trackOnly !== 'boolean') throw new SdkError('bad_request', 'trackOnly must be true or false');
  return { id, leaders, sizing, maxPerTradeLamports: maxPerTrade.toString(), dailyLamports: daily.toString(), maxPerTokenLamports: perToken.toString(), ...(allow ? { allow } : {}), ...(block?.length ? { block } : {}),
    sides, exitMode, slippageBps: Math.round(num(b.slippagePct ?? 5, 'slippagePct', 0.1, 50) * 100), cooldownS: num(b.cooldownS ?? 0, 'cooldownS', 0, 86_400, true), maxPositions: num(b.maxPositions ?? 10, 'maxPositions', 1, 100, true),
    minConfirmations: num(b.minConfirmations ?? 1, 'minConfirmations', 0, 32, true), maxDeviationBps: Math.round(num(b.maxDeviationPct ?? 15, 'maxDeviationPct', 0.1, 100) * 100), maxAgeSlots: num(b.maxAgeSlots ?? 150, 'maxAgeSlots', 1, 9000, true),
    trackOnly: b.trackOnly === true, createdAt: o.now };
}
/** The CopyEngine configs (one per leader) for a saved config. */
export function copyCfgs(s: SavedCopy, follower: string) {
  return s.leaders.map(leader => ({ follower, walletId: follower, leader, mode: 'fixedLamports' in s.sizing ? 'fixed' as const : 'proportional' as const,
    fixed: 'fixedLamports' in s.sizing ? BigInt(s.sizing.fixedLamports) : 0n, ratioBps: 'percent' in s.sizing ? Math.round(s.sizing.percent * 100) : 0, maxBuy: BigInt(s.maxPerTradeLamports),
    sides: s.sides, maxPerLeader: BigInt(s.dailyLamports), maxPerToken: BigInt(s.maxPerTokenLamports), dailyLimit: BigInt(s.dailyLamports), maxPositions: s.maxPositions, cooldownS: s.cooldownS,
    minLiquidity: 0n, maxDeviationBps: s.maxDeviationBps, allow: s.allow, block: s.block, minConfirmations: s.minConfirmations, followLeaderExit: s.exitMode === 'full-on-exit', exitMode: s.exitMode,
    slippageBps: s.slippageBps, trackOnly: s.trackOnly, stablecoins: [] as string[] }));
}
/** What a copied buy of this event would spend, before the engine's exposure caps (which can only lower it). */
export function intendedLamports(s: SavedCopy, e: LeaderEvent) {
  const want = 'fixedLamports' in s.sizing ? BigInt(s.sizing.fixedLamports) : e.quoteAmount * BigInt(Math.round(s.sizing.percent * 100)) / 10_000n, cap = BigInt(s.maxPerTradeLamports);
  return want < cap ? want : cap;
}

export interface GateNote { at: number; txHash: string; leader: string; token: string; side: 'buy' | 'sell'; why: string }
/** A LeaderSource in front of the watcher: learns each token (so the copy rules can price it) and runs the manual-buy checks on every leader buy before the copy rules see it.
 *  An event that fails a check is dropped here and noted. The cursor is the watcher's own: progress is never lost, a dropped event is never retried. */
export class GatedLeaderSource implements LeaderSource {
  notes: GateNote[] = [];
  constructor(private inner: LeaderSource, private s: SavedCopy, private h: { active: () => boolean; prepare: (mint: string) => Promise<void>; gate: (mint: string, lamports: bigint) => Promise<void>; now: () => number }) {}
  snapshot() { return this.inner.snapshot(); } load(x: any) { this.inner.load(x); }
  private note(e: LeaderEvent, why: string) { this.notes.push({ at: this.h.now(), txHash: e.txHash, leader: e.leader, token: e.token, side: e.side, why }); if (this.notes.length > 50) this.notes.splice(0, this.notes.length - 50); }
  async poll() {
    const r = await this.inner.poll(), events: LeaderEvent[] = [];
    for (const e of r.events) { const why = e.kind === 'swap' ? await this.check(e).catch((x: Error) => (x instanceof SdkError ? `${x.code}: ${x.message}` : `the check could not run, so it is skipped: ${x.message}`)) : undefined; if (why) this.note(e, why); else events.push(e); }
    return { events, reorged: r.reorged };
  }
  /** A reason to skip, or undefined to pass the event on to the copy rules. */
  private async check(e: LeaderEvent): Promise<string | undefined> {
    if (!this.h.active()) return 'the wallet is not active (no Privy signer): nothing can be signed';
    if (this.s.block?.includes(e.token) || (this.s.allow && !this.s.allow.includes(e.token))) return undefined;    // the copy rules skip it and say so; no need to inspect it
    if (e.side === 'buy' && e.confirmations > this.s.maxAgeSlots) return `the leader's buy is ${e.confirmations} slots old (more than ${this.s.maxAgeSlots}): old trades are not copied`;
    await this.h.prepare(e.token);                                                   // the token's venues (pump.fun curve, Jupiter): the copy rules price it from them
    if (e.side === 'buy') { const amt = intendedLamports(this.s, e); if (amt > 0n) await this.h.gate(e.token, amt); }
    return undefined;
  }
}

/** Copy trading for one account. `restore()` rebuilds the saved configs (call it once, before the Trader's resume()). */
export function solCopies(o: { trader: Trader; follower?: string; chainId: string; rpc: SolRpc; state: (name: string) => Backend; caps: { maxTradeLamports: bigint; dailyCapLamports: bigint };
  active: () => boolean; prepare: (mint: string) => Promise<void>; gate: (mint: string, lamports: bigint) => Promise<void>; now?: () => number; log?: (m: string) => void }): AccountCopies & { restore: () => void } {
  const now = o.now ?? Date.now, log = o.log ?? (() => {}), list = o.state('copies'), gates = new Map<string, GatedLeaderSource>();
  const saved = (): SavedCopy[] => { try { const j = JSON.parse(list.read() || '{}'); return Array.isArray(j.copies) ? j.copies : []; } catch { return []; } };
  const save = (xs: SavedCopy[]) => list.write(JSON.stringify({ v: 1, copies: xs }));
  const start = (s: SavedCopy, follower: string): CopyRunner => {
    const watch = new SolLeaderWatcher({ chain: o.chainId, wsol: WSOL, leaders: s.leaders, quoteMints: [], minConfirmations: s.minConfirmations }, o.rpc);
    const g = new GatedLeaderSource(watch, s, { active: o.active, prepare: o.prepare, gate: o.gate, now }); gates.set(s.id, g);
    try { return o.trader.addCopy(s.id, { cfgs: copyCfgs(s, follower), source: g, probeAmount: 10_000_000n }); } catch (e) { gates.delete(s.id); throw e; }
  };
  const view = (s: SavedCopy) => { const r = o.trader.copies.get(s.id), g = gates.get(s.id);
    return { id: s.id, leaders: s.leaders, ...('fixedLamports' in s.sizing ? { fixedSol: sol(s.sizing.fixedLamports) } : { percent: s.sizing.percent }), maxPerTradeSol: sol(s.maxPerTradeLamports), dailySol: sol(s.dailyLamports), maxPerTokenSol: sol(s.maxPerTokenLamports),
      allow: s.allow ?? null, block: s.block ?? [], sides: s.sides, exitMode: s.exitMode, slippagePct: s.slippageBps / 100, cooldownS: s.cooldownS, maxPositions: s.maxPositions, minConfirmations: s.minConfirmations,
      maxDeviationPct: s.maxDeviationBps / 100, maxAgeSlots: s.maxAgeSlots, trackOnly: s.trackOnly, createdAt: new Date(s.createdAt).toISOString(), running: !!r, entriesPaused: o.trader.entriesPaused,
      lastError: r?.lastError ?? null, inflight: r?.inflight.size ?? 0, outbox: r?.outbox.length ?? 0, decisions: (r?.copy.log ?? []).slice(-20), skippedByChecks: (g?.notes ?? []).slice(-20) }; };
  return {
    restore() {
      if (!o.follower) { if (saved().length) log(`${o.trader.userId}: ${saved().length} copy config(s) kept but not running: no wallet is linked`); return; }
      for (const s of saved()) { try { start(s, o.follower); } catch (e) { log(`${o.trader.userId}: copy ${s.id} could not be restored: ${(e as Error).message}`); } }
    },
    async create(body: any) {
      if (!o.follower || !o.active()) throw new SdkError('wallet_not_active', 'copy trading needs a linked wallet this server may sign for', 'Link your Privy wallet first: POST /v1/wallet/link/start, then /v1/wallet/link/finish.', 409);
      const s = parseCopyBody(body, { caps: o.caps, follower: o.follower, now: now() }), all = saved();
      if (all.some(x => x.id === s.id) || o.trader.copies.has(s.id)) throw new SdkError('exists', `copy ${s.id} already exists`, 'DELETE it first, or pick another id.', 409);
      if (all.length >= MAX_COPIES) throw new SdkError('too_many', `an account can run at most ${MAX_COPIES} copy configs`, 'DELETE one first.', 409);
      o.state(`copy-${s.id}`).write('');                                             // a fresh start: never the attribution or cursor of an older config with this id
      const run = start(s, o.follower);
      try { await gates.get(s.id)!.poll(); run.checkpoint(); }                         // the first poll records "now" for each leader: nothing before this moment is copied
      catch (e) { o.trader.removeCopy(s.id); gates.delete(s.id); o.state(`copy-${s.id}`).write(''); throw new SdkError('rpc_unavailable', `could not read the leader wallets: ${(e as Error).message}`, 'Retry shortly.', 503); }
      save([...all, s]); return view(s);
    },
    remove(id: string) {
      const all = saved(), s = all.find(x => x.id === id); if (!s && !o.trader.copies.has(id)) throw new SdkError('not_found', `no copy ${id}`, undefined, 404);
      save(all.filter(x => x.id !== id)); o.trader.removeCopy(id); gates.delete(id); o.state(`copy-${id}`).write('');
      return { id, removed: true };
    },
    list() { return saved().map(view); },
  };
}
