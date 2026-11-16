/** Minimal JSON-RPC client. READ-ONLY by construction: only methods on the allowlist can be sent. The API key lives in the URL
 *  path (Alchemy's documented format) and is redacted from every error and report. */
const READ_ONLY = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_estimateGas', 'getVersion', 'getGenesisHash', 'getSlot', 'getAccountInfo', 'getTokenLargestAccounts', 'getTokenSupply', 'getTokenAccountBalance', 'getMultipleAccounts', 'getHealth', 'simulateTransaction', 'getSignaturesForAddress', 'getTransaction', 'getSignatureStatuses', 'getMinimumBalanceForRentExemption', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'getBalance', 'getTokenAccountsByOwner', 'getBlockTime', 'alchemy_getTokenBalances', 'alchemy_getTokenMetadata', 'alchemy_getAssetTransfers']);
export class Rpc {
  calls = 0;
  constructor(private url: string, private secret: string, private fetchFn: typeof fetch = fetch, private pauseMs = 120) {}
  redact(s: string) { return this.secret ? s.split(this.secret).join('***') : s; }
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!READ_ONLY.has(method)) throw new Error(`method ${method} is not on the read-only allowlist`);
    for (let attempt = 0; attempt < 4; attempt++) {
      this.calls++;
      let res: Response;
      try { res = await this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.calls, method, params }) }); }
      catch (e) { throw new Error(this.redact(`network error calling ${method}: ${(e as Error).message}`)); }
      if (res.status === 429) { await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); continue; }   // rate limited: back off, never hammer
      if (!res.ok) throw new Error(`HTTP ${res.status} from provider on ${method}`);
      const j: any = await res.json();
      if (j.error) throw new Error(this.redact(`RPC error on ${method}: ${j.error.message ?? JSON.stringify(j.error)}`));
      await new Promise(r => setTimeout(r, this.pauseMs));
      return j.result as T;
    }
    throw new Error(`rate limited on ${method} after retries`);
  }
}

/** Spaces the START of every call by at least `gapMs`, across all concurrent callers. `Rpc`'s own pause only delays after a call finishes, so a burst of parallel callers (several launches decoded at once) still hits the provider all at the same instant. */
export class Paced<R extends { call<T = unknown>(method: string, params?: unknown[]): Promise<T> }> {
  private next = 0;
  constructor(private inner: R, private gapMs: number, private now: () => number = Date.now, private timer: (fn: () => void, ms: number) => unknown = setTimeout) {}
  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const t = this.now(), at = Math.max(t, this.next); this.next = at + this.gapMs;
    return at === t ? this.inner.call<T>(method, params) : new Promise<T>(res => { this.timer(() => res(this.inner.call<T>(method, params)), at - t); });
  }
}
