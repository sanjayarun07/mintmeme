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

export const JITO_MAINNET_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1';   // Jito's documented public block engine; override for a regional endpoint
export interface JitoOptions { url?: string; tipLamports: bigint; maxTipLamports?: bigint; uuid?: string; fetchFn?: typeof fetch; timeoutMs?: number; pickTip?: (accounts: string[]) => string; tipAccountsTtlMs?: number; now?: () => number }
export class JitoSubmitter implements TxSubmitter {
  readonly name = 'jito'; private accounts?: { list: string[]; at: number };
  constructor(private o: JitoOptions) {
    if (!(o.tipLamports > 0n)) throw new Error('Jito needs a tip greater than zero');
    const cap = o.maxTipLamports ?? 10_000_000n; if (o.tipLamports > cap) throw new Error(`tip ${o.tipLamports} lamports is above the safety cap ${cap}: raise maxTipLamports on purpose if you mean it`);
  }
  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const f = this.o.fetchFn ?? fetch, headers: Record<string, string> = { 'content-type': 'application/json', ...(this.o.uuid ? { 'x-jito-auth': this.o.uuid } : {}) };
    const r = await f(`${this.o.url ?? JITO_MAINNET_BLOCK_ENGINE}${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    if (!r.ok) throw new Error(`jito ${method}: HTTP ${r.status}`); const j: any = await r.json(); if (j.error) throw new Error(`jito ${method}: ${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}`); return j.result as T;
  }
  /** Tip accounts come from the block engine (getTipAccounts), never from a hard-coded list, and are cached briefly. A tip to an address that is not one of them would simply be a donation. */
  async tipAccounts(): Promise<string[]> {
    const now = (this.o.now ?? Date.now)(); if (this.accounts && now - this.accounts.at < (this.o.tipAccountsTtlMs ?? 600_000)) return this.accounts.list;
    const list = await this.rpc<string[]>('/bundles', 'getTipAccounts', []); if (!Array.isArray(list) || !list.length || list.some(a => typeof a !== 'string' || a.length < 32 || a.length > 44)) throw new Error('jito returned an unusable tip account list');
    this.accounts = { list, at: now }; return list;
  }
  async extraInstruction(payer: string): Promise<Ix> { const a = await this.tipAccounts(), to = (this.o.pickTip ?? (x => x[Math.floor(Math.random() * x.length)]))(a); if (!a.includes(to)) throw new Error('chosen tip account is not in the block engine\'s list'); return systemTransfer(payer, to, this.o.tipLamports); }
  async send(raw: string, signature: string): Promise<string> {
    const id = await this.rpc<string>('/bundles', 'sendBundle', [[raw], { encoding: 'base64' }]);
    if (typeof id !== 'string' || !id) throw new Error('jito accepted the bundle but returned no bundle id');
    return signature;   // the network confirms by signature, exactly as for a normal send; the bundle id is only a receipt from the block engine
  }
}
