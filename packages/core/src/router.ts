import type { Intent, Quote, Venue } from './types.ts';
import type { ChainPort } from './port.ts';

export interface AggregatorBenchmark { name: string; quoteOut(i: Intent): bigint | undefined }
export interface RouteResult { best: Quote; all: Quote[]; benchmark?: { source: 'aggregator'; name: string; out: bigint; directVsBenchmarkBps: number } }

/** Direct-adapter router. Aggregator is only a labeled price benchmark here, never the execution path. */
export class Router {
  constructor(private chain: Pick<ChainPort, 'venues' | 'state' | 'block'>, private bench?: AggregatorBenchmark) {}
  /** Follows graduation successors so orders/positions survive migration; successor must be in same authorized family. */
  private resolve(v: Venue): Venue | undefined {
    let cur: Venue | undefined = v, hops = 0;
    while (cur && cur.status === 'graduated' && cur.successor && hops++ < 5) cur = this.chain.state.venues.get(cur.successor);
    return cur && cur.status === 'active' ? cur : undefined;
  }
  route(i: Intent, feeBps = i.maxFeeBps): RouteResult {
    const seen = new Set<string>(), all: Quote[] = [];
    for (const v0 of this.chain.venues()) {
      const v = this.resolve(v0); if (!v || seen.has(v.id)) continue;
      if (!(i.venues.includes(v.id) || i.venues.includes(v.family))) continue;
      if (!v.supports(i.tokenIn, i.tokenOut)) continue;
      seen.add(v.id);
      const fee = i.amountIn * BigInt(feeBps) / 10_000n;   // quote on net-of-platform-fee amount
      const q = v.quote(i.tokenIn, i.tokenOut, i.amountIn - fee);
      all.push({ ...q, source: 'direct', block: this.chain.block });
    }
    if (!all.length) throw new Error('no authorized direct route');
    all.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
    const best = all[0]; let benchmark: RouteResult['benchmark'];
    const ext = this.bench?.quoteOut(i);
    if (ext !== undefined && ext > 0n) benchmark = { source: 'aggregator', name: this.bench!.name, out: ext, directVsBenchmarkBps: Number((best.amountOut - ext) * 10_000n / ext) };
    return { best, all, benchmark };
  }
}
