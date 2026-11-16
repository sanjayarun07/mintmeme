// Load measurement for the order trigger loop. In-process, SimChain: measures CPU cost of evaluating orders and COUNTS venue refreshes
// (each refresh is the unit that becomes RPC calls on a real chain). It is NOT a network test and says nothing about RPC latency.
// usage: node --experimental-transform-types --no-warnings bench/load.ts [users] [ordersPerUser] [pools] [shared]
import os from 'node:os';
import { SimChain, CpAmm, Store, PolicySigner, Router, Engine, OrderRunner, NATIVE, SharedFeed } from '../packages/core/src/index.ts';
import type { ChainPort, WalletPolicy, Order } from '../packages/core/src/index.ts';

const [U, K, P, SHARED] = [Number(process.argv[2] ?? 100), Number(process.argv[3] ?? 20), Number(process.argv[4] ?? 50), (process.argv[5] ?? 'no') === 'shared'];
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const chain = new SimChain(); const tokens: string[] = [];
for (let i = 0; i < P; i++) { const t = `0xT${i}`; tokens.push(t); chain.addVenue(new CpAmm(`uni-v2:T${i}`, 'uniswap-v2', t, NATIVE, 1_000_000n, 1_000_000n)); }
let upstreamRefreshes = 0;
const rawRefresh = chain.refresh?.bind(chain);
(chain as ChainPort).refresh = async (what: 'head' | 'venues') => { if (what === 'venues') upstreamRefreshes++; await rawRefresh?.(what); };
const feed = SHARED ? new SharedFeed(chain, { ttlMs: 500, clockMs: () => clock }) : undefined;
const port: ChainPort = (feed ?? chain) as ChainPort;

const runners: OrderRunner[] = []; let clock = 0;
const pol = (u: string): WalletPolicy => ({ userId: u, chains: ['sim-evm'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 10n ** 12n }, dailyLimit: { [NATIVE]: 10n ** 15n }, destinations: [], deviceSecret: 'd' });
for (let u = 0; u < U; u++) {
  const wid = `w${u}`, uid = `u${u}`;
  for (const t of tokens) chain.credit(wid, t, 1_000_000n);
  const signer = new PolicySigner(new Map([[wid, 'k']]), new Map([[wid, pol(uid)]]));
  const engine = new Engine({ store: new Store(), chain: port, signer, router: new Router(port), platformFeeBps: 0 });
  const r = new OrderRunner({ engine, chain: port, clockMs: () => clock });
  for (let k = 0; k < K; k++) {
    const token = tokens[(u * 7 + k) % P];
    const o: Order = { id: `${uid}.o${k}`, userId: uid, walletId: wid, chain: 'sim-evm', token, quoteToken: NATIVE, kind: 'limit_sell', amount: 1_000n, triggerPriceE18: 5n * 10n ** 18n,   // 5x spot: never triggers
      expiresAt: 10 ** 12, maxQuoteAgeMs: 10 ** 9, minLiquidity: 1n, maxDeviationBps: 1500, maxAttempts: 3, slippageBps: 300, venues: ['uniswap-v2'], status: 'active', attempts: 0 };
    await r.place(o);
  }
  runners.push(r);
}
upstreamRefreshes = 0; if (feed) (feed as any).feed.reset();
const TICKS = 10, wall: number[] = [];
for (let i = 0; i < TICKS; i++) { clock += 1000; const a = performance.now(); for (const r of runners) await r.tick(); wall.push(performance.now() - a); }
const total = U * K;
console.log(`HARDWARE: ${os.cpus()[0].model} x${os.cpus().length}, node ${process.version}; chain: SimChain (no network); mode: ${SHARED ? 'shared price feed' : 'one refresh per runner'}`);
console.log(`users=${U} orders/user=${K} pools=${P} active orders=${total}`);
console.log(`one full pass over all runners: p50=${pct(wall, .5).toFixed(1)}ms p95=${pct(wall, .95).toFixed(1)}ms (n=${TICKS}); per order ${(pct(wall, .5) * 1000 / total).toFixed(2)}us`);
console.log(`venue refreshes asked per pass: ${U}; reaching the chain per pass: ${(upstreamRefreshes / TICKS).toFixed(1)}`);
