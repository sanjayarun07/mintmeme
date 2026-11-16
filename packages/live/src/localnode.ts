/** LOCAL-NODE harness. Sends REAL signed transactions, but ONLY to a loopback node you run yourself (e.g. a Nitro testnode or anvil).
 *  Refuses any non-loopback URL. Keys are throwaway, generated per run, and never written to the report. Signing uses Foundry's `cast`. */
import { execFileSync } from 'node:child_process';
import { JsonRpcError } from '../../evm/src/rpcchain.ts';

export function assertLoopback(url: string) {
  const h = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h)) throw new Error(`refusing non-loopback node: ${h}`);
}

export class LocalNode {
  n = 0;
  constructor(public url: string) { assertLoopback(url); }
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }) });
    const j: any = await res.json();
    if (j.error) throw new JsonRpcError(j.error.message ?? JSON.stringify(j.error));
    return j.result as T;
  }
  /** Returns the error message instead of throwing: used to record how the node phrases rejections. */
  async tryCall(method: string, params: unknown[] = []): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
    try { return { ok: true, result: await this.call(method, params) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  async waitReceipt(hash: string, timeoutMs = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const r = await this.call('eth_getTransactionReceipt', [hash]); if (r) return r; await new Promise(r => setTimeout(r, 400)); }
    throw new Error(`no receipt for ${hash} after ${timeoutMs}ms`);
  }
}

export interface Wallet { address: string; key: string }
export function newWallet(): Wallet {
  const j = JSON.parse(execFileSync('cast', ['wallet', 'new', '--json'], { encoding: 'utf8' }));
  const w = Array.isArray(j) ? j[0] : Array.isArray(j.data) ? j.data[0] : j; return { address: w.address.toLowerCase(), key: w.private_key };
}
export interface RawTxOpts { to: string; valueWei: bigint; nonce: number; chainId: number; gasLimit?: bigint; maxFeeGwei?: string; priorityGwei?: string; data?: string }
/** Sign offline with cast (no network). Returns the raw signed tx hex. */
export function signRaw(w: Wallet, o: RawTxOpts): string {
  const args = ['mktx', o.to, ...(o.data ? [o.data] : []), '--value', o.valueWei.toString(), '--nonce', String(o.nonce), '--chain', String(o.chainId), '--gas-limit', String(o.gasLimit ?? 100_000n),
    '--gas-price', `${o.maxFeeGwei ?? '1'}gwei`, '--priority-gas-price', `${o.priorityGwei ?? '0.1'}gwei`, '--private-key', w.key];
  return execFileSync('cast', args.filter(Boolean), { encoding: 'utf8' }).trim();
}
export const hex = (n: bigint) => '0x' + n.toString(16);
export const big = (h: string) => BigInt(h);
