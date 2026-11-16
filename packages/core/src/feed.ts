import type { ChainPort } from './port.ts';

/**
 * One shared price feed for many accounts. Wrap a single read chain once and give the wrapper to every account's engine and order runner:
 *  - refresh('venues') is single-flight (callers that arrive while one is running share it) and reused for `ttlMs` after it finishes, so N accounts
 *    ticking once a second cause ONE reload of the pools, not N. Price staleness is therefore at most `ttlMs` (default 500 ms) beyond what an
 *    order's own maxQuoteAgeMs already allows.
 *  - refresh('head') is single-flight only, never reused: the engine relies on it to see new blocks and confirmations promptly.
 * Everything else (quotes, simulation, submit, balances) goes straight to the wrapped chain. The wrapper owns no keys and no per-user state.
 */
export class SharedFeed {
  /** how many refresh calls arrived, and how many actually reached the wrapped chain */
  stats = { asked: 0, upstream: 0 };
  private inflight = new Map<string, Promise<void>>(); private doneAt = new Map<string, number>();
  constructor(private chain: ChainPort, private o: { ttlMs?: number; clockMs?: () => number } = {}) {
    const self = this;
    return new Proxy(chain, {
      get(t, k, r) { return k === 'refresh' ? self.refresh : k === 'feed' ? self : Reflect.get(t, k, t); },
      set(t, k, v) { return Reflect.set(t, k, v, t); },
    }) as unknown as SharedFeed & ChainPort;
  }
  reset() { this.stats = { asked: 0, upstream: 0 }; this.doneAt.clear(); }
  private refresh = async (what: 'head' | 'venues'): Promise<void> => {
    if (!this.chain.refresh) return;
    this.stats.asked++;
    const now = (this.o.clockMs ?? Date.now)(), ttl = this.o.ttlMs ?? 500;
    if (what === 'venues' && ttl > 0 && now - (this.doneAt.get('venues') ?? -Infinity) < ttl) return;
    let p = this.inflight.get(what);
    if (!p) {
      this.stats.upstream++;
      p = this.chain.refresh(what).then(() => { if (what === 'venues') this.doneAt.set('venues', (this.o.clockMs ?? Date.now)()); }).finally(() => this.inflight.delete(what));
      this.inflight.set(what, p);
    }
    await p;
  };
}
