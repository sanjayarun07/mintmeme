/** Production entry point for one node of the execution server. Run several, behind a load balancer, all pointed at one Redis.
 *  usage: node --env-file-if-exists=.env --experimental-transform-types --no-warnings apps/server/main.ts   (or: npm run server)
 *  Environment (see docs/PRODUCTION_SERVER.md):
 *    REDIS_URL           redis://[:password@]host:6379   (required; run Redis with appendonly yes)
 *    NODE_PUBLIC_URL     how the OTHER nodes reach this one, e.g. http://10.0.3.7:3500   (required)
 *    API_KEYS_FILE       file of "sha256hex:userId[:read|trade]" lines (make lines with apps/server/keys.ts)   (required)
 *    PORT=3500  HOST=127.0.0.1 (0.0.0.0 in a container)  NAMESPACE=memedesk  MODE=practice
 *    LEASE_TTL_MS=15000  MAX_USERS_PER_NODE=300  SWEEP_MS=2000  RATE_PER_SECOND=20  RATE_BURST=40  REDIS_REQUIRE_AOF=true
 *    SOLANA_SAMPLE_URL   optional, e.g. http://127.0.0.1:3000: serve the /solana test page (and its /api/sol/* calls) from that running terminal, to THIS machine only
 *    PG_URL              optional: postgres://user:pass@host:5432/db?sslmode=require   stored trade history and audit log (/v1/records/*, the status page)
 *    MAX_USERS_PER_APP=10000   end users one app key may create;  WEBHOOKS_ALLOW_HTTP=true only for local testing (http and private hosts as webhook targets)
 *    PLATFORM_FEE_WALLET + PLATFORM_FEE_BPS=0..100   the operator's fee on every real trade (paid in SOL);  APP_FEE_MAX_BPS=100   the most an app may set with PUT /v1/app/fees
 *  MODE: `practice` (simulated chain, fake funds) or `solana-mainnet` (REAL funds: each user links their Privy wallet; needs PRIVY_* and SOLANA_RPC_URL or ALCHEMY_API_KEY). */
import { readFileSync } from 'node:fs';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { solanaAccounts, linkRoutes } from './solaccount.ts';
import { readAppFee } from './webhooks.ts';
import type { AppFee } from './webhooks.ts';
import { SyncRedis } from '../../packages/core/src/index.ts';
import type { FeeRecipient } from '../../packages/sol/src/index.ts';
import { privyConfig } from '../web/solmainnet.ts';
import type { ApiKey } from '../api/server.ts';

const env = process.env, fail = (m: string): never => { console.error(m); process.exit(2); };
const need = (k: string) => env[k] || fail(`${k} is not set. See the header of apps/server/main.ts or docs/PRODUCTION_SERVER.md.`);
const int = (k: string, d: number, min: number, max: number) => { const v = env[k] === undefined ? d : Number(env[k]); if (!Number.isInteger(v) || v < min || v > max) fail(`${k} must be a whole number from ${min} to ${max}`); return v; };

export function parseKeyFile(text: string): ApiKey[] {
  const out: ApiKey[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim(); if (!s || s.startsWith('#')) return;
    const [keyHash, userId, scope = 'trade'] = s.split(':');
    if (!/^[0-9a-f]{64}$/i.test(keyHash ?? '') || !userId || (scope !== 'trade' && scope !== 'read' && scope !== 'app')) throw new Error(`API_KEYS_FILE line ${i + 1}: expected "sha256hex:userId[:read|trade|app]" (plain keys are not accepted here)`);
    out.push({ keyHash, userId, scope });
  });
  if (!out.length) throw new Error('API_KEYS_FILE has no keys');
  return out;
}

/** MODE=solana-mainnet: real accounts signed through each user's Privy wallet (solaccount.ts). Needs the Privy settings and a Solana RPC. */
export function solanaMode(e: NodeJS.ProcessEnv) {
  const rpcUrl = e.SOLANA_RPC_URL || (e.ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${e.ALCHEMY_API_KEY}` : '');
  const privy = privyConfig(e), missing = [!rpcUrl && 'SOLANA_RPC_URL (or ALCHEMY_API_KEY)', !privy && 'PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTH_KEY_ID, PRIVY_AUTH_PRIVATE_KEY, PRIVY_SOLANA_POLICY_ID'].filter(Boolean);
  if (missing.length) throw new Error(`MODE=solana-mainnet needs ${missing.join(' and ')} (README → Custody plan).`);
  // fee sharing: the operator's fee (PLATFORM_FEE_WALLET, PLATFORM_FEE_BPS) on every trade, plus the app's own fee (PUT /v1/app/fees) on its users' trades
  const pw = e.PLATFORM_FEE_WALLET, pbps = Number(e.PLATFORM_FEE_BPS ?? 0);
  if (!Number.isInteger(pbps) || pbps < 0 || pbps > 100) throw new Error('PLATFORM_FEE_BPS must be a whole number from 0 to 100');
  if (pbps > 0 && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pw ?? '')) throw new Error('PLATFORM_FEE_BPS is set: PLATFORM_FEE_WALLET must be a Solana address');
  const fr = new SyncRedis(e.REDIS_URL ?? 'redis://127.0.0.1:6379', 5000), ns = e.NAMESPACE ?? 'memedesk', cache = new Map<string, { at: number; v: AppFee | null }>();
  const appFee = (app: string) => { const h = cache.get(app); if (h && Date.now() - h.at < 30_000) return h.v; const v = readAppFee(fr, ns, app); cache.set(app, { at: Date.now(), v }); return v; };
  const fees = (userId: string): FeeRecipient[] => { const out: FeeRecipient[] = []; if (pbps > 0) out.push({ address: pw!, bps: pbps });
    const i = userId.indexOf(':'); if (i > 0) { const f = appFee(userId.slice(0, i)); if (f && f.bps > 0) out.push({ address: f.wallet, bps: f.bps }); } return out; };
  const acc = solanaAccounts({ rpcUrl, privy: privy!, fees });
  // status page checks: reachability of what real trading depends on (no secrets in what is shown)
  const statusChecks = [
    { name: 'Solana RPC', run: async () => { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }), signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); } },
    { name: 'Privy', run: async () => { await fetch('https://api.privy.io', { signal: AbortSignal.timeout(5_000) }); } },
    { name: 'Jito block engine', run: async () => { const r = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); } },
  ];
  return { statusChecks, makeAccount: acc.make, extraRoutes: (h: Parameters<NonNullable<Parameters<typeof createNode>[0]['extraRoutes']>>[0]) => linkRoutes({ privy: acc.privy, status: acc.status, safety: acc.safety, ...h }) };
}

if (import.meta.main) {
  const mode = env.MODE ?? 'practice'; if (mode !== 'practice' && mode !== 'solana-mainnet') fail(`MODE=${mode} is not built in. Use practice (simulated chain) or solana-mainnet (real funds, Privy).`);
  let real: ReturnType<typeof solanaMode> | undefined; if (mode === 'solana-mainnet') { try { real = solanaMode(env); } catch (e) { fail((e as Error).message); } }
  let keys: ApiKey[] = []; try { keys = parseKeyFile(readFileSync(need('API_KEYS_FILE'), 'utf8')); } catch (e) { fail((e as Error).message); }
  const httpUrl = (k: string, v: string) => { let u: URL | undefined; try { u = new URL(v); } catch { /* reported below */ } if (u?.protocol !== 'http:') fail(`${k} must be an http:// URL such as http://10.0.3.7:3500 (nodes talk plain HTTP on the private network; TLS belongs at the load balancer)`); return u!; };
  const publicUrl = need('NODE_PUBLIC_URL'), pub = httpUrl('NODE_PUBLIC_URL', publicUrl);
  if (env.SOLANA_SAMPLE_URL) httpUrl('SOLANA_SAMPLE_URL', env.SOLANA_SAMPLE_URL);
  if ((env.HOST ?? '127.0.0.1') === '127.0.0.1' && !/^(localhost|127\.0\.0\.1)$/.test(pub.hostname)) console.warn(`warning: HOST is 127.0.0.1 but NODE_PUBLIC_URL is ${pub.host}: other nodes cannot reach this one. Set HOST=0.0.0.0 (or this machine's private address).`);
  const node = await createNode({
    redisUrl: need('REDIS_URL'), namespace: env.NAMESPACE ?? 'memedesk', publicUrl, keys, makeAccount: real?.makeAccount ?? practiceAccount, extraRoutes: real?.extraRoutes,
    leaseTtlMs: int('LEASE_TTL_MS', 15_000, 3_000, 300_000), maxUsers: int('MAX_USERS_PER_NODE', 300, 1, 100_000), sweepMs: int('SWEEP_MS', 2000, 200, 60_000),
    rate: { perSecond: int('RATE_PER_SECOND', 20, 1, 10_000), burst: int('RATE_BURST', 40, 1, 20_000) }, requireAof: env.REDIS_REQUIRE_AOF !== 'false',
    solanaSampleUrl: env.SOLANA_SAMPLE_URL || undefined, pgUrl: env.PG_URL || undefined, statusChecks: real?.statusChecks,
    maxUsersPerApp: int('MAX_USERS_PER_APP', 10_000, 1, 10_000_000), maxAppFeeBps: int('APP_FEE_MAX_BPS', 100, 0, 500), webhooks: { allowHttp: env.WEBHOOKS_ALLOW_HTTP === 'true' },
  }).catch(e => fail((e as Error).message));
  if (env.SOLANA_SAMPLE_URL) console.log(`sample page: http://127.0.0.1:${env.PORT ?? 3500}/solana -> ${env.SOLANA_SAMPLE_URL} (this machine only; 404 for remote requests)`);
  const port = await node.listen(int('PORT', 3500, 1, 65_535), env.HOST ?? '127.0.0.1');
  console.log(`execution node on ${env.HOST ?? '127.0.0.1'}:${port} as ${publicUrl} (mode ${mode}, ${keys.length} key(s); keys are never printed)`);
  let stopping = false; const stop = async (sig: string) => { if (stopping) return; stopping = true; console.log(`${sig}: draining (releasing leases so other nodes take over)`); await node.drain(); process.exit(0); };
  process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
}
