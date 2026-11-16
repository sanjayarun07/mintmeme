/** Starts the execution API on a PRACTICE chain (simulated, fake funds): one practice account per API key user, driven once a second.
 *  usage: API_KEYS="<key>:<user>[:read|trade],..." npm run api      (keys are at least 16 characters; generate one with: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
 *  Env: API_PORT (default 3500), API_HOST (default 127.0.0.1: keep it local or put TLS in front). To serve a REAL chain, build a Trader over EvmRpcChain or SolanaChain (docs/SDK_AND_API.md) and pass it to createApi. */
import { createApi } from './server.ts';
import { createSimTrader } from '../../packages/sdk/src/sim.ts';

const parse = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean).map(x => { const [key, userId, scope] = x.split(':'); if (!key || !userId || (scope && scope !== 'read' && scope !== 'trade')) throw new Error(`API_KEYS entry "${x.slice(0, 6)}…" must look like key:user or key:user:read`); return { key, userId, scope: scope as 'read' | 'trade' | undefined }; });
if (!process.env.API_KEYS) { console.error('API_KEYS is not set. Example: API_KEYS="<24+ char secret>:alice" npm run api'); process.exit(2); }
const keys = parse(process.env.API_KEYS), sims = new Map<string, ReturnType<typeof createSimTrader>>();
for (const u of new Set(keys.map(k => k.userId))) { const s = createSimTrader({ userId: u }); s.trader.start(1000); setInterval(() => { s.chain.time += 1; }, 1000).unref(); sims.set(u, s); }
const api = createApi({ keys, traderFor: u => sims.get(u)?.trader });
const port = await api.listen(Number(process.env.API_PORT ?? 3500), process.env.API_HOST ?? '127.0.0.1');
console.log(`Practice execution API on http://${process.env.API_HOST ?? '127.0.0.1'}:${port}  (simulated chain, fake funds; ${keys.length} key(s), users: ${[...sims.keys()].join(', ')})`);
console.log('Routes: GET /v1/openapi.json   wallets per user: w1, w2   token: 0xMEME   keys are never printed');
