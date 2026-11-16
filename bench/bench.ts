// In-process fixture benchmark. Measures ONLY engine/sim CPU overhead on THIS machine. NOT network, RPC, or mainnet latency.
import os from 'node:os';
import { world, TOK } from '../packages/core/test/fixtures.ts';
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const N = 2000, q: number[] = [], sub: number[] = [], conf: number[] = [];
const w = world({ dailyLimit: 10n ** 15n }); w.policies.get('w1')!.maxPerTx['NATIVE'] = 10n ** 12n; w.chain.credit('w1', 'NATIVE', 10n ** 12n);
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const a = performance.now(); w.engine.d.router.route(w.intent({ amountIn: 1000n })); q.push(performance.now() - a);
  const b = performance.now(); await w.engine.submit(w.intent({ idempotencyKey: 'b' + i, amountIn: 1000n, slippageBps: 5000 })); sub.push(performance.now() - b);
  if (i % 50 === 49) { const c = performance.now(); w.chain.mine(); for (let j = i - 49; j <= i; j++) await w.engine.advance('b' + j); conf.push((performance.now() - c) / 50); }
}
const secs = (performance.now() - t0) / 1000;
const row = (n: string, a: number[]) => `${n.padEnd(34)} p50=${pct(a, .5).toFixed(3)}ms p95=${pct(a, .95).toFixed(3)}ms p99=${pct(a, .99).toFixed(3)}ms (n=${a.length})`;
console.log(`HARDWARE: ${os.cpus()[0].model} x${os.cpus().length}, node ${process.version}; RPC: none (SimChain fixture); workload: ${N} sequential buys`);
console.log(row('quote (route)', q)); console.log(row('intent->submitted (validate..sign)', sub)); console.log(row('mine+confirm per tx (amortized)', conf));
console.log(`sustained throughput: ${(N / secs).toFixed(0)} intents/s in-process (not a network figure)`);
