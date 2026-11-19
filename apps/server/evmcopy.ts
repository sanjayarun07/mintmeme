/** COPY TRADING for the execution server's real EVM accounts (Base, BNB Chain, Robinhood Chain): POST/GET/DELETE /v1/<chain>/copies. The EVM twin of solcopy.ts.
 *
 *  A copy config follows one or more leader wallets on one chain. The leader source is `LeaderWatcher` (packages/evm/src/leaderwatch.ts) in 'logs' mode: it reads the
 *  ERC-20 Transfer logs to and from the leaders (blocks come every 0.1 to 0.5 s on these chains, so it never reads whole blocks) and turns each transaction the leader
 *  sent into a swap from the leader's own net token and coin movements. `CopyRunner` applies the copy rules (sizing, caps, cooldown, exits) and hands the trades to the
 *  account's engine, so every copied trade is signed by Privy within the account's EVM policy and caps, exactly like a manual one.
 *
 *  Rules (as on Solana):
 *   - Never copies history: the first poll, made when the config is created, only records where "now" is. A leader buy older than `maxAgeS` seconds when it is seen is
 *     not copied (after an outage the follower does not chase old trades); leader sells of what the copy bought are still followed.
 *   - A copied BUY goes through the same checks as a manual buy first: for a tokenized stock the operator switch (STOCKS_ENABLED) and the fill-price check against the
 *     share price. A check that fails, or cannot run, skips the trade (fail closed) and the reason is listed on GET /v1/copies.
 *   - Per-trade and daily caps are no higher than the account's (the policy signer enforces those across everything anyway). Amounts are in the chain's coin, plain units:
 *     fixedEth / maxPerTradeEth / dailyEth / maxPerTokenEth (BNB Chain: fixedBnb, ...).
 *   - Only transactions the leader wallet SENT are copied (not smart wallets, not trades made for it by a contract). */
import { randomUUID } from 'node:crypto';
import type { Backend, CopyConfig, CopyRunner, LeaderEvent, LeaderSource } from '../../packages/core/src/index.ts';
import { LeaderWatcher, isAddress } from '../../packages/evm/src/index.ts';
import type { RpcLike } from '../../packages/evm/src/index.ts';
import type { Trader } from '../../packages/sdk/src/trader.ts';
import { SdkError, ID_RE } from '../../packages/sdk/src/wire.ts';
import type { AccountCopies } from './node.ts';

export const MAX_COPIES = 10, MAX_LEADERS = 10, MAX_LIST = 200;
const lc = (s: string) => s.toLowerCase();
/** One copy config as saved in the user's state. Amounts are wei (or the chain coin's smallest unit) as decimal strings. */
export interface SavedEvmCopy {
  id: string; leaders: string[]; sizing: { fixedWei: string } | { percent: number };
  maxPerTradeWei: string; dailyWei: string; maxPerTokenWei: string;
  allow?: string[]; block?: string[]; sides: 'buy' | 'both'; exitMode: NonNullable<CopyConfig['exitMode']>;
  slippageBps: number; cooldownS: number; maxPositions: number; minConfirmations: number; maxDeviationBps: number; maxAgeS: number; trackOnly: boolean; createdAt: number;
}
/** "0.01" plain units to the smallest unit (18 decimals), refusing anything that is not a plain positive number. */
export function toWei(v: unknown, what: string): bigint {
  const s = String(v ?? '').trim(); if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new SdkError('bad_amount', `${what} must be a plain amount such as 0.01`);
  const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export const fromWei = (w: string | bigint) => { const v = BigInt(w), i = v / 10n ** 18n, f = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return f ? `${i}.${f}` : `${i}`; };
const num = (v: unknown, what: string, lo: number, hi: number, int = false) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new SdkError('bad_number', `${what} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi}`);
  return n;
};

/** Validate a POST /v1/<chain>/copies body (plain units of the chain's coin) into a saved config. `native` is ETH or BNB (the field names follow it: fixedEth, fixedBnb). */
export function parseEvmCopyBody(b: any, o: { caps: { maxTradeWei: bigint; dailyCapWei: bigint }; follower: string; now: number; native: string; label: string; findStock?: (t: string) => { address: string } | undefined }): SavedEvmCopy {
  if (!b || typeof b !== 'object') throw new SdkError('bad_request', 'send a JSON object');
  const K = o.native === 'BNB' ? 'Bnb' : 'Eth', N = o.native;
  const known = new Set(['id', 'leader', 'leaders', `fixed${K}`, 'percent', `maxPerTrade${K}`, `daily${K}`, `maxPerToken${K}`, 'allow', 'block', 'sides', 'exitMode', 'slippagePct', 'cooldownS', 'maxPositions', 'minConfirmations', 'maxDeviationPct', 'maxAgeS', 'trackOnly', 'walletId']);
  const extra = Object.keys(b).filter(k => !known.has(k)); if (extra.length) throw new SdkError('bad_request', `unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`, `Fields on ${o.label}: ${[...known].filter(k => k !== 'walletId').join(', ')}.`);
  if (b.walletId !== undefined && lc(String(b.walletId)) !== o.follower) throw new SdkError('bad_request', 'a copy trades the linked wallet: leave walletId out');
  const id = b.id === undefined ? `c-${randomUUID().slice(0, 8)}` : String(b.id); if (!ID_RE.test(id)) throw new SdkError('bad_text', 'id must be 1 to 128 letters, digits, dot, dash, underscore or colon');
  const raw = b.leaders ?? (b.leader === undefined ? undefined : [b.leader]);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LEADERS || (b.leaders !== undefined && b.leader !== undefined)) throw new SdkError('bad_request', `send leader (one address) or leaders (1 to ${MAX_LEADERS} addresses)`);
  const leaders = [...new Set(raw.map(x => lc(String(x).trim())))];
  for (const l of leaders) { if (!isAddress(l)) throw new SdkError('bad_address', `leader ${l} is not a 0x address`); if (l === o.follower) throw new SdkError('bad_address', 'a wallet cannot copy itself'); }
  const fixedKey = `fixed${K}`;
  if ((b[fixedKey] === undefined) === (b.percent === undefined)) throw new SdkError('bad_request', `send exactly one sizing rule: ${fixedKey} (the same ${N} amount on every copied buy) or percent (of the ${N} the leader spent, 0.01 to 1000)`);
  const cap = (v: unknown, what: string, ceiling: bigint, def: bigint) => { if (v === undefined) return def; const x = toWei(v, what); if (x > ceiling) throw new SdkError('above_cap', `${what} ${fromWei(x)} is above this account's limit of ${fromWei(ceiling)} ${N}`, `Send ${fromWei(ceiling)} or less.`); return x; };
  const maxPerTrade = cap(b[`maxPerTrade${K}`], `maxPerTrade${K}`, o.caps.maxTradeWei, o.caps.maxTradeWei), daily = cap(b[`daily${K}`], `daily${K}`, o.caps.dailyCapWei, o.caps.dailyCapWei);
  const perToken = cap(b[`maxPerToken${K}`], `maxPerToken${K}`, daily, daily);
  if (maxPerTrade > daily) throw new SdkError('bad_amount', `maxPerTrade${K} is above daily${K}`);
  let sizing: SavedEvmCopy['sizing'];
  if (b[fixedKey] !== undefined) { const f = toWei(b[fixedKey], fixedKey); if (f <= 0n) throw new SdkError('bad_amount', `${fixedKey} must be above 0`); if (f > maxPerTrade) throw new SdkError('above_cap', `${fixedKey} ${fromWei(f)} is above the per-trade cap of ${fromWei(maxPerTrade)} ${N}`, `Lower ${fixedKey} or raise maxPerTrade${K} (up to the account limit).`); sizing = { fixedWei: f.toString() }; }
  else { const p = num(b.percent, 'percent', 0.01, 1000); sizing = { percent: Math.round(p * 100) / 100 }; }
  const tokens = (v: unknown, what: string) => {
    if (v === undefined) return undefined; if (!Array.isArray(v) || v.length > MAX_LIST) throw new SdkError('bad_request', `${what} must be a list of up to ${MAX_LIST} token addresses`);
    return [...new Set(v.map(x => { const t = String(x).trim(); if (isAddress(t)) return lc(t); const s = o.findStock?.(t); if (s) return lc(s.address); throw new SdkError('bad_token', `${what}: "${t}" is not a token address on ${o.label}`); }))];
  };
  const allow = tokens(b.allow, 'allow'), block = tokens(b.block, 'block');
  if (allow && !allow.length) throw new SdkError('bad_request', 'allow is empty: nothing would be copied (leave it out to allow every token)');
  const sides = b.sides ?? 'both'; if (sides !== 'buy' && sides !== 'both') throw new SdkError('bad_request', 'sides must be "both" (copy buys, follow the leader\'s sells of what was copied) or "buy" (copy buys only)');
  const exitMode = b.exitMode ?? 'full-on-exit'; if (!['proportional', 'full-on-exit', 'full-on-any-sell', 'ignore'].includes(exitMode)) throw new SdkError('bad_request', 'exitMode must be proportional, full-on-exit, full-on-any-sell or ignore');
  if (b.trackOnly !== undefined && typeof b.trackOnly !== 'boolean') throw new SdkError('bad_request', 'trackOnly must be true or false');
  return { id, leaders, sizing, maxPerTradeWei: maxPerTrade.toString(), dailyWei: daily.toString(), maxPerTokenWei: perToken.toString(), ...(allow ? { allow } : {}), ...(block?.length ? { block } : {}),
    sides, exitMode, slippageBps: Math.round(num(b.slippagePct ?? 5, 'slippagePct', 0.1, 50) * 100), cooldownS: num(b.cooldownS ?? 0, 'cooldownS', 0, 86_400, true), maxPositions: num(b.maxPositions ?? 10, 'maxPositions', 1, 100, true),
    minConfirmations: num(b.minConfirmations ?? 1, 'minConfirmations', 0, 64, true), maxDeviationBps: Math.round(num(b.maxDeviationPct ?? 15, 'maxDeviationPct', 0.1, 100) * 100), maxAgeS: num(b.maxAgeS ?? 60, 'maxAgeS', 5, 3600, true),
    trackOnly: b.trackOnly === true, createdAt: o.now };
}
/** The CopyEngine configs (one per leader) for a saved config. */
export function evmCopyCfgs(s: SavedEvmCopy, follower: string) {
  return s.leaders.map(leader => ({ follower, walletId: follower, leader, mode: 'fixedWei' in s.sizing ? 'fixed' as const : 'proportional' as const,
    fixed: 'fixedWei' in s.sizing ? BigInt(s.sizing.fixedWei) : 0n, ratioBps: 'percent' in s.sizing ? Math.round(s.sizing.percent * 100) : 0, maxBuy: BigInt(s.maxPerTradeWei),
    sides: s.sides, maxPerLeader: BigInt(s.dailyWei), maxPerToken: BigInt(s.maxPerTokenWei), dailyLimit: BigInt(s.dailyWei), maxPositions: s.maxPositions, cooldownS: s.cooldownS,
    minLiquidity: 0n, maxDeviationBps: s.maxDeviationBps, allow: s.allow, block: s.block, minConfirmations: s.minConfirmations, followLeaderExit: s.exitMode === 'full-on-exit', exitMode: s.exitMode,
    slippageBps: s.slippageBps, trackOnly: s.trackOnly, stablecoins: [] as string[] }));
}
/** What a copied buy of this event would spend, before the engine's exposure caps (which can only lower it). */
export function intendedWei(s: SavedEvmCopy, e: LeaderEvent) {
  const want = 'fixedWei' in s.sizing ? BigInt(s.sizing.fixedWei) : e.quoteAmount * BigInt(Math.round(s.sizing.percent * 100)) / 10_000n, cap = BigInt(s.maxPerTradeWei);
  return want < cap ? want : cap;
}

export interface GateNote { at: number; txHash: string; leader: string; token: string; side: 'buy' | 'sell'; why: string }
/** In front of the watcher: learns each token (its V2 pool or aggregator route, so the copy rules can price it) and runs the manual-buy checks on every leader buy before
 *  the copy rules see it. An event that fails is dropped and noted. The cursor is the watcher's own: progress is never lost, a dropped event is never retried. */
export class EvmGatedSource implements LeaderSource {
  notes: GateNote[] = [];
  constructor(private inner: LeaderSource, private s: SavedEvmCopy, private h: { active: () => boolean; prepare: (token: string) => Promise<void>; gate: (token: string, wei: bigint) => Promise<void>; blockS: () => number; now: () => number }) {}
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
    if (this.s.block?.includes(e.token) || (this.s.allow && !this.s.allow.includes(e.token))) return undefined;   // the copy rules skip it and say so
    const ageS = e.confirmations * this.h.blockS();
    if (e.side === 'buy' && ageS > this.s.maxAgeS) return `the leader's buy is about ${Math.round(ageS)} s old (more than ${this.s.maxAgeS} s): old trades are not copied`;
    await this.h.prepare(e.token);
    if (e.side === 'buy') { const amt = intendedWei(this.s, e); if (amt > 0n) await this.h.gate(e.token, amt); }
    return undefined;
  }
}

/** Seconds per block on this chain, measured from the last 1,000 blocks and kept an hour (0.1 to 0.5 s on Base, BNB and Robinhood in 2026). */
function blockTimer(rpc: RpcLike) {
  let v = 1, at = 0;
  const refresh = async () => {
    const head = Number(BigInt(await rpc.call<string>('eth_blockNumber'))), [a, b]: any[] = await Promise.all([rpc.call('eth_getBlockByNumber', ['0x' + head.toString(16), false]), rpc.call('eth_getBlockByNumber', ['0x' + Math.max(0, head - 1000).toString(16), false])]);
    const s = (Number(BigInt(a.timestamp)) - Number(BigInt(b.timestamp))) / Math.max(1, head - Math.max(0, head - 1000)); if (s > 0 && s < 60) { v = s; at = Date.now(); }
  };
  return { get: () => v, refresh: async () => { if (Date.now() - at > 3_600_000) await refresh().catch(() => {}); } };
}

/** Copy trading for one EVM account. `restore()` rebuilds the saved configs (call it once, before the Trader's resume()). */
export function evmCopies(o: { trader: Trader; follower?: string; chainId: string; label: string; native: string; weth: string; rpc: RpcLike; state: (name: string) => Backend;
  caps: { maxTradeWei: bigint; dailyCapWei: bigint }; active: () => boolean; prepare: (token: string) => Promise<void>; gate: (token: string, wei: bigint) => Promise<void>;
  findStock?: (t: string) => { address: string } | undefined; now?: () => number; log?: (m: string) => void }): AccountCopies & { restore: () => void } {
  const now = o.now ?? Date.now, log = o.log ?? (() => {}), list = o.state('copies'), gates = new Map<string, EvmGatedSource>(), blocks = blockTimer(o.rpc), K = o.native === 'BNB' ? 'Bnb' : 'Eth';
  const saved = (): SavedEvmCopy[] => { try { const j = JSON.parse(list.read() || '{}'); return Array.isArray(j.copies) ? j.copies : []; } catch { return []; } };
  const save = (xs: SavedEvmCopy[]) => list.write(JSON.stringify({ v: 1, copies: xs }));
  const start = (s: SavedEvmCopy, follower: string): CopyRunner => {
    const watch = new LeaderWatcher({ chain: o.chainId, weth: o.weth, leaders: s.leaders, quoteTokens: ['NATIVE', lc(o.weth)], minConfirmations: s.minConfirmations, scan: 'logs', maxBlocksPerPoll: 1000 }, o.rpc);
    const g = new EvmGatedSource(watch, s, { active: o.active, prepare: o.prepare, gate: o.gate, blockS: blocks.get, now }); gates.set(s.id, g);
    try { return o.trader.addCopy(s.id, { cfgs: evmCopyCfgs(s, follower), source: g, probeAmount: 10n ** 14n }); } catch (e) { gates.delete(s.id); throw e; }
  };
  const view = (s: SavedEvmCopy) => { const r = o.trader.copies.get(s.id), g = gates.get(s.id);
    return { id: s.id, leaders: s.leaders, ...('fixedWei' in s.sizing ? { [`fixed${K}`]: fromWei(s.sizing.fixedWei) } : { percent: s.sizing.percent }), [`maxPerTrade${K}`]: fromWei(s.maxPerTradeWei), [`daily${K}`]: fromWei(s.dailyWei),
      [`maxPerToken${K}`]: fromWei(s.maxPerTokenWei), allow: s.allow ?? null, block: s.block ?? [], sides: s.sides, exitMode: s.exitMode, slippagePct: s.slippageBps / 100, cooldownS: s.cooldownS, maxPositions: s.maxPositions,
      minConfirmations: s.minConfirmations, maxDeviationPct: s.maxDeviationBps / 100, maxAgeS: s.maxAgeS, trackOnly: s.trackOnly, createdAt: new Date(s.createdAt).toISOString(), running: !!r, entriesPaused: o.trader.entriesPaused,
      lastError: r?.lastError ?? null, inflight: r?.inflight.size ?? 0, outbox: r?.outbox.length ?? 0, decisions: (r?.copy.log ?? []).slice(-20), skippedByChecks: (g?.notes ?? []).slice(-20) }; };
  return {
    restore() {
      if (!o.follower) { if (saved().length) log(`${o.trader.userId}: ${saved().length} ${o.label} copy config(s) kept but not running: no wallet is linked`); return; }
      void blocks.refresh();
      for (const s of saved()) { try { start(s, o.follower); } catch (e) { log(`${o.trader.userId}: ${o.label} copy ${s.id} could not be restored: ${(e as Error).message}`); } }
    },
    async create(body: any) {
      if (!o.follower || !o.active()) throw new SdkError('wallet_not_active', 'copy trading needs a linked wallet this server may sign for', `Link your Privy wallet on ${o.label} first: POST /v1/wallet/link/start, then /v1/wallet/link/finish.`, 409);
      const s = parseEvmCopyBody(body, { caps: o.caps, follower: o.follower, now: now(), native: o.native, label: o.label, findStock: o.findStock }), all = saved();
      if (all.some(x => x.id === s.id) || o.trader.copies.has(s.id)) throw new SdkError('exists', `copy ${s.id} already exists`, 'DELETE it first, or pick another id.', 409);
      if (all.length >= MAX_COPIES) throw new SdkError('too_many', `an account can run at most ${MAX_COPIES} copy configs per chain`, 'DELETE one first.', 409);
      await blocks.refresh();
      o.state(`copy-${s.id}`).write('');                                             // a fresh start: never the attribution or cursor of an older config with this id
      const run = start(s, o.follower);
      try { await gates.get(s.id)!.poll(); run.checkpoint(); }                         // the first poll records "now": nothing before this moment is copied
      catch (e) { o.trader.removeCopy(s.id); gates.delete(s.id); o.state(`copy-${s.id}`).write(''); throw new SdkError('rpc_unavailable', `could not read ${o.label}: ${(e as Error).message}`, 'Retry shortly.', 503); }
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
