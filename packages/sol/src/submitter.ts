/** HOW A SIGNED TRANSACTION REACHES THE NETWORK. The chain builds and signs the transaction; a submitter only sends the finished bytes. The engine's write-ahead record, idempotency and confirmation tracking
 *  do not change with the submitter, because all of them key on the transaction signature, which is fixed before anything is sent.
 *  - `RpcSubmitter`: the node's own `sendTransaction` (the default).
 *  - `JitoSubmitter`: sends the transaction as a one-transaction bundle to a Jito block engine, with a tip paid in the transaction itself. Faster landing and no public-mempool exposure, in exchange for a tip on every attempt.
 *  Jito is not validated end to end here: it exists only on mainnet, where this project sends nothing. What IS checked: the request format against a stand-in block engine, and the tip-account list read from the real one. */
import { systemTransfer } from './tx.ts';
import type { Ix } from './tx.ts';

export interface TxSubmitter {
  readonly name: string;
  /** Extra instruction appended to every transaction before signing (for example a Jito tip). Called once per prepare. */
  extraInstruction?(payer: string): Promise<Ix | undefined>;
  /** Send signed transaction bytes (base64) whose signature is `signature`. Return the signature the network reports. Throwing means "not accepted", never "maybe sent". */
  send(rawBase64: string, signature: string): Promise<string>;
}

export interface RpcLike { call<T = any>(method: string, params?: unknown[]): Promise<T> }
export class RpcSubmitter implements TxSubmitter {
  readonly name = 'rpc';
  constructor(private rpc: RpcLike, private o: { skipPreflight?: boolean } = {}) {}
  async send(raw: string, signature: string): Promise<string> {
    const h = await this.rpc.call<string>('sendTransaction', [raw, { encoding: 'base64', skipPreflight: this.o.skipPreflight ?? false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
    if (h !== signature) throw new Error(`node returned signature ${h} but we computed ${signature}: refusing to track a different transaction`); return h;
  }
}

/** Jito's documented block engine host (https://docs.jito.wtf/lowlatencytxnsend/). Regional hosts such as https://ny.mainnet.block-engine.jito.wtf can replace it. */
export const JITO_MAINNET_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf';
export const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
/** Jito's sandwich-mitigation flag: any valid public key starting with "jitodontfront", added read-only to an instruction. The block engine then rejects a bundle unless this
 *  transaction is first in it. Jito: "may help reduce sandwich attacks but is not guaranteed to do so". It does not need to exist on chain. */
export const JITO_DONT_FRONT = 'jitodontfront111111111111111111111111111111';
export const JITO_MIN_TIP = 1_000n;   // Jito's documented minimum tip, lamports
export interface JitoOptions {
  url?: string;
  /** A fixed tip in lamports, or 'auto' (default): the tip floor's landed-tip percentile now (`tipPercentile`, default 75), within [JITO_MIN_TIP, maxTipLamports]. */
  tip?: bigint | 'auto'; tipPercentile?: 25 | 50 | 75 | 95 | 99;
  /** @deprecated use `tip` */ tipLamports?: bigint;
  /** Hard cap on one tip. Default 100,000 lamports (0.0001 SOL). */
  maxTipLamports?: bigint;
  /** Add the jitodontfront flag to the tip instruction. Default true. */
  dontFront?: boolean;
  uuid?: string; fetchFn?: typeof fetch; timeoutMs?: number; pickTip?: (accounts: string[]) => string; tipAccountsTtlMs?: number; tipFloorTtlMs?: number; tipFloorUrl?: string; now?: () => number;
  /** Spacing between block-engine calls in this process (Jito default limit: 1 per second per IP). Default 1,000 ms; raise only with a custom limit from Jito. */
  minIntervalMs?: number;
}
/** Sends each transaction privately to the Jito block engine: `sendTransaction` with `bundleOnly=true`, i.e. as a one-transaction bundle that is never broadcast publicly
 *  by Jito and lands all-or-nothing (a failing transaction is not included and pays no tip). The tip is a SOL transfer to one of Jito's tip accounts inside the same transaction
 *  (Jito: tips only work with Jito-Solana leaders; not through address lookup tables). Limits (Jito docs): 1 request per second per IP per region without a custom limit;
 *  a block that is skipped and rebroadcast can expose the transaction to the normal path ("uncled blocks"). */
export class JitoSubmitter implements TxSubmitter {
  readonly name = 'jito'; private accounts?: { list: string[]; at: number }; private floor?: { at: number; lamports: bigint };
  constructor(private o: JitoOptions = {}) {
    const fixed = o.tip !== undefined && o.tip !== 'auto' ? o.tip : o.tipLamports, cap = o.maxTipLamports ?? 100_000n;
    if (fixed !== undefined) { if (!(fixed > 0n)) throw new Error('Jito needs a tip greater than zero'); if (fixed > cap) throw new Error(`tip ${fixed} lamports is above the safety cap ${cap}: raise maxTipLamports on purpose if you mean it`); }
  }
  /** Jito allows 1 request per second per IP per region by default: every block-engine call in this process waits its turn (shared by all users on a node). */
  private static queues = new Map<string, Promise<void>>();
  private async paced<T>(f: () => Promise<T>): Promise<T> {
    const key = this.o.url ?? JITO_MAINNET_BLOCK_ENGINE, gap = this.o.minIntervalMs ?? 1_000, prev = JitoSubmitter.queues.get(key) ?? Promise.resolve();
    let done!: () => void; const mine = new Promise<void>(r => { done = r; }); JitoSubmitter.queues.set(key, prev.then(() => mine));
    await prev; try { return await f(); } finally { setTimeout(done, gap); }
  }
  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> { return this.paced(() => this.call<T>(path, method, params)); }
  private async call<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const f = this.o.fetchFn ?? fetch, headers: Record<string, string> = { 'content-type': 'application/json', ...(this.o.uuid ? { 'x-jito-auth': this.o.uuid } : {}) };
    const r = await f(`${(this.o.url ?? JITO_MAINNET_BLOCK_ENGINE).replace(/\/+$/, '')}${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    if (!r.ok) throw new Error(`jito ${method}: HTTP ${r.status}${r.status === 429 ? ' (rate limited: 1 request per second per IP without a custom limit)' : ''}`);
    const j: any = await r.json(); if (j.error) throw new Error(`jito ${method}: ${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}`); return j.result as T;
  }
  /** Tip accounts come from the block engine (getTipAccounts), never from a hard-coded list, and are cached briefly. A tip to an address that is not one of them would simply be a donation. */
  async tipAccounts(): Promise<string[]> {
    const now = (this.o.now ?? Date.now)(); if (this.accounts && now - this.accounts.at < (this.o.tipAccountsTtlMs ?? 600_000)) return this.accounts.list;
    const list = await this.rpc<string[]>('/api/v1/getTipAccounts', 'getTipAccounts', []); if (!Array.isArray(list) || !list.length || list.some(a => typeof a !== 'string' || a.length < 32 || a.length > 44)) throw new Error('jito returned an unusable tip account list');
    this.accounts = { list, at: now }; return list;
  }
  /** The tip for the next transaction, in lamports. 'auto': the tip floor's landed-tip percentile (reported in SOL), cached 30 s; if the floor cannot be read, the cap's tenth. */
  async tipNow(): Promise<bigint> {
    const cap = this.o.maxTipLamports ?? 100_000n, fixed = this.o.tip !== undefined && this.o.tip !== 'auto' ? this.o.tip : this.o.tipLamports; if (fixed !== undefined) return fixed;
    const now = (this.o.now ?? Date.now)(); if (this.floor && now - this.floor.at < (this.o.tipFloorTtlMs ?? 30_000)) return this.floor.lamports;
    let lamports: bigint;
    try {
      const r = await (this.o.fetchFn ?? fetch)(this.o.tipFloorUrl ?? JITO_TIP_FLOOR_URL, { signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) }); const j: any = await r.json();
      const sol = Number((Array.isArray(j) ? j[0] : j)?.[`landed_tips_${this.o.tipPercentile ?? 75}th_percentile`]);
      if (!(sol > 0) || !Number.isFinite(sol)) throw new Error('no tip floor'); lamports = BigInt(Math.ceil(sol * 1e9));
    } catch { lamports = cap / 10n; }
    if (lamports < JITO_MIN_TIP) lamports = JITO_MIN_TIP; if (lamports > cap) lamports = cap;
    this.floor = { at: now, lamports }; return lamports;
  }
  async extraInstruction(payer: string): Promise<Ix> {
    const a = await this.tipAccounts(), to = (this.o.pickTip ?? (x => x[Math.floor(Math.random() * x.length)]))(a); if (!a.includes(to)) throw new Error('chosen tip account is not in the block engine\'s list');
    const ix = systemTransfer(payer, to, await this.tipNow()); if (this.o.dontFront ?? true) ix.keys.push({ pubkey: JITO_DONT_FRONT });   // read-only, not a signer: the System program ignores extra accounts
    return ix;
  }
  async send(raw: string, signature: string): Promise<string> {
    const sig = await this.rpc<string>(`/api/v1/transactions?bundleOnly=true${this.o.uuid ? `&uuid=${encodeURIComponent(this.o.uuid)}` : ''}`, 'sendTransaction', [raw, { encoding: 'base64' }]);
    if (sig !== signature) throw new Error(`jito returned signature ${String(sig).slice(0, 12)}... but we computed ${signature.slice(0, 12)}...: refusing to track a different transaction`);
    return signature;
  }
}
