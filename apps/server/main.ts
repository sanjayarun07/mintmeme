/** Production entry point for one node of the execution server. Run several, behind a load balancer, all pointed at one Redis.
 *  usage: node --env-file-if-exists=.env --experimental-transform-types --no-warnings apps/server/main.ts   (or: npm run server)
 *  Environment (see docs/PRODUCTION_SERVER.md):
 *    REDIS_URL           redis://[:password@]host:6379   (required; run Redis with appendonly yes)
 *    NODE_PUBLIC_URL     how the OTHER nodes reach this one, e.g. http://10.0.3.7:3500   (required)
 *    API_KEYS_FILE       file of "sha256hex:userId[:read|trade]" lines (make lines with apps/server/keys.ts or the key dashboard, npm run keys; re-read live within ~2 s)   (required)
 *    PORT=3500  HOST=127.0.0.1 (0.0.0.0 in a container)  NAMESPACE=memedesk  MODE=practice
 *    LEASE_TTL_MS=15000  MAX_USERS_PER_NODE=300  SWEEP_MS=2000  RATE_PER_SECOND=20  RATE_BURST=40  REDIS_REQUIRE_AOF=true
 *    SOLANA_SAMPLE_URL   optional, e.g. http://127.0.0.1:3000: serve the /solana test page (and its /api/sol/* calls) from that running terminal, to THIS machine only
 *    PG_URL              optional: postgres://user:pass@host:5432/db?sslmode=require   stored trade history and audit log (/v1/records/*, the status page)
 *    MAX_USERS_PER_APP=10000   end users one app key may create;  WEBHOOKS_ALLOW_HTTP=true only for local testing (http and private hosts as webhook targets)
 *    JUPITER_API_KEY     optional: Jupiter's API key (x-api-key) for route building, quotes and prices in MODE=solana-mainnet; keyless (about 1 request / 2 s) without it
 *    SOLANA_MAX_TRADE_SOL=0.05  SOLANA_DAILY_CAP_SOL=0.25   the engine's SOL caps on buys per user (MODE=solana-mainnet); the Privy policy's sol-cap applies separately
 *    JUPITERZ=off|on  JUPITERZ_MIN_SOL=100  JUPITERZ_MARGIN_BPS=20   JupiterZ market-maker (RFQ) fills for large Solana trades without a platform fee (docs/JUPITERZ.md)
 *    PLATFORM_FEE_WALLET + PLATFORM_FEE_BPS=0..100   the operator's fee on every real trade (paid in SOL);  APP_FEE_MAX_BPS=100   the most an app may set with PUT /v1/app/fees
 *  CHAINS=solana,base   serve several chains from one node group (apps/server/chains.ts): each user gets an account per chain; requests name it with /v1/<chain>/...,
 *                       and paths without a prefix go to the first chain listed. Each chain needs the settings its MODE below lists. MODE stays as the one-chain shorthand.
 *  MODE: `practice` (simulated chain, fake funds), `solana-mainnet` (REAL funds: each user links their Privy wallet; needs PRIVY_* and SOLANA_RPC_URL or ALCHEMY_API_KEY)
 *        or `base-mainnet` (REAL funds on Base, Uniswap V2, plus Relay for tokens with no V2 pool (BASE_RELAY=off turns it off, RELAY_API_KEY; BASE_AGGREGATOR=kyberswap uses KyberSwap instead, KYBER_CLIENT_ID): each user links their Privy Ethereum wallet; needs PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTH_KEY_ID,
 *        PRIVY_AUTH_PRIVATE_KEY, PRIVY_BASE_POLICY_ID and BASE_RPC_URL or ALCHEMY_API_KEY with Base enabled). BASE_MAX_TRADE_ETH=0.01, BASE_DAILY_CAP_ETH=0.05. */
import { readFileSync } from 'node:fs';
import { createNode } from './node.ts';
import type { ChainAccounts, ExtraRoutes } from './node.ts';
import { parseChains, CHAIN_SPECS } from './chains.ts';
import type { ChainSpec } from './chains.ts';
import { practiceAccount } from './accounts.ts';
import { solanaAccounts, linkRoutes } from './solaccount.ts';
import { baseAccounts, baseLinkRoutes, walletState } from './baseaccount.ts';
import { toUnits } from '../../packages/sdk/src/solana.ts';
import { readAppFee } from './webhooks.ts';
import type { AppFee } from './webhooks.ts';
import { SyncRedis } from '../../packages/core/src/index.ts';
import type { FeeRecipient } from '../../packages/sol/src/index.ts';
import { privyConfig } from '../web/solmainnet.ts';
import type { ApiKey } from '../api/server.ts';

const env = process.env, fail = (m: string): never => { console.error(m); process.exit(2); };
const need = (k: string) => env[k] || fail(`${k} is not set. See the header of apps/server/main.ts or docs/PRODUCTION_SERVER.md.`);
const int = (k: string, d: number, min: number, max: number) => { const v = env[k] === undefined ? d : Number(env[k]); if (!Number.isInteger(v) || v < min || v > max) fail(`${k} must be a whole number from ${min} to ${max}`); return v; };

import { parseKeyFile, watchKeyFile } from './keyfile.ts';
import { solanaRpc, solanaRpcFallback } from '../../packages/live/src/config.ts';
export { parseKeyFile, watchKeyFile };

/** JupiterZ RFQ fills (docs/JUPITERZ.md), off unless JUPITERZ=on. JUPITERZ_MIN_SOL (default 100): the smallest SOL side that asks market makers; JUPITERZ_MARGIN_BPS
 *  (default 20): how much better than the normal route the firm quote must be. Trades that carry a platform fee never use RFQ (the fee is paid in SOL inside the
 *  transaction, which an RFQ transaction cannot carry). The users' Privy policy must allow the Order Engine program (README → Solana policy rules). */
export function jupiterzConfig(e: NodeJS.ProcessEnv): { minLamports: bigint; marginBps: number } | undefined {
  const on = (e.JUPITERZ ?? 'off').trim().toLowerCase();
  if (on !== 'on' && on !== 'off') throw new Error('JUPITERZ must be on or off');
  if (on === 'off') return undefined;
  let minLamports: bigint; try { minLamports = toUnits(e.JUPITERZ_MIN_SOL ?? '100', 9, 'JUPITERZ_MIN_SOL'); } catch (x) { throw new Error(`JUPITERZ_MIN_SOL: ${(x as Error).message}`); }
  const marginBps = Number(e.JUPITERZ_MARGIN_BPS ?? 20);
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 1000) throw new Error('JUPITERZ_MARGIN_BPS must be a whole number from 0 to 1000');
  return { minLamports, marginBps };
}

/** The engine's SOL caps on buys in MODE=solana-mainnet: SOLANA_MAX_TRADE_SOL per buy (default 0.05) and SOLANA_DAILY_CAP_SOL per user per day (default 0.25).
 *  They limit what the server's signer is asked to sign; the users' Privy policy has its own `sol-cap` rule on plain SOL transfers (README → Solana policy rules), and a
 *  normal Jupiter buy above that rule is refused by Privy whatever these caps say. With JUPITERZ=on, JUPITERZ_MIN_SOL above the per-buy cap would never be reached: refused. */
export function solanaCaps(e: NodeJS.ProcessEnv, jupiterz?: { minLamports: bigint }): { maxTradeLamports: bigint; dailyCapLamports: bigint } {
  const sol = (k: string, d: string) => { try { return toUnits(e[k]?.trim() || d, 9, k); } catch (x) { throw new Error(`${k}: ${(x as Error).message}`); } };
  const caps = { maxTradeLamports: sol('SOLANA_MAX_TRADE_SOL', '0.05'), dailyCapLamports: sol('SOLANA_DAILY_CAP_SOL', '0.25') };
  if (caps.dailyCapLamports < caps.maxTradeLamports) throw new Error('SOLANA_DAILY_CAP_SOL must be at least SOLANA_MAX_TRADE_SOL');
  if (jupiterz && jupiterz.minLamports > caps.maxTradeLamports) throw new Error('JUPITERZ_MIN_SOL is above SOLANA_MAX_TRADE_SOL, so no trade could ever use JupiterZ: raise SOLANA_MAX_TRADE_SOL or lower JUPITERZ_MIN_SOL');
  return caps;
}

/** MODE=solana-mainnet: real accounts signed through each user's Privy wallet (solaccount.ts). Needs the Privy settings and a Solana RPC. */
export function solanaMode(e: NodeJS.ProcessEnv) {
  const rpcUrl = solanaRpc(e)?.url ?? '';   // SOLANA_RPC_URL, else Helius (HELIUS_API_KEY), else Alchemy
  const privy = privyConfig(e), missing = [!rpcUrl && 'SOLANA_RPC_URL (or HELIUS_API_KEY, or ALCHEMY_API_KEY)', !privy && 'PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTH_KEY_ID, PRIVY_AUTH_PRIVATE_KEY, PRIVY_SOLANA_POLICY_ID'].filter(Boolean);
  if (missing.length) throw new Error(`MODE=solana-mainnet needs ${missing.join(' and ')} (README → Custody plan).`);
  // fee sharing: the operator's fee (PLATFORM_FEE_WALLET, PLATFORM_FEE_BPS) on every trade, plus the app's own fee (PUT /v1/app/fees) on its users' trades
  const pw = e.PLATFORM_FEE_WALLET, pbps = Number(e.PLATFORM_FEE_BPS ?? 0);
  if (!Number.isInteger(pbps) || pbps < 0 || pbps > 100) throw new Error('PLATFORM_FEE_BPS must be a whole number from 0 to 100');
  if (pbps > 0 && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pw ?? '')) throw new Error('PLATFORM_FEE_BPS is set: PLATFORM_FEE_WALLET must be a Solana address');
  const fr = new SyncRedis(e.REDIS_URL ?? 'redis://127.0.0.1:6379', 5000), ns = e.NAMESPACE ?? 'memedesk', cache = new Map<string, { at: number; v: AppFee | null }>();
  const appFee = (app: string) => { const h = cache.get(app); if (h && Date.now() - h.at < 30_000) return h.v; const v = readAppFee(fr, ns, app); cache.set(app, { at: Date.now(), v }); return v; };
  const fees = (userId: string): FeeRecipient[] => { const out: FeeRecipient[] = []; if (pbps > 0) out.push({ address: pw!, bps: pbps });
    const i = userId.indexOf(':'); if (i > 0) { const f = appFee(userId.slice(0, i)); if (f && f.bps > 0) out.push({ address: f.wallet, bps: f.bps }); } return out; };
  const jupiterz = jupiterzConfig(e), caps = solanaCaps(e, jupiterz);
  const acc = solanaAccounts({ rpcUrl, rpcFallbackUrl: solanaRpcFallback(e)?.url, privy: privy!, fees, caps, jupiterApiKey: e.JUPITER_API_KEY?.trim() || undefined, jupiterz });
  // status page checks: reachability of what real trading depends on (no secrets in what is shown)
  const statusChecks = [
    { name: 'Solana RPC', run: async () => { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }), signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); } },
    { name: 'Privy', run: async () => { await fetch('https://api.privy.io', { signal: AbortSignal.timeout(5_000) }); } },
    { name: 'Jito block engine', run: async () => { const r = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); } },
  ];
  return { statusChecks, makeAccount: acc.make, extraRoutes: (h => linkRoutes({ privy: acc.privy, status: acc.status, safety: acc.safety, stock: acc.stock, stocksEnabled: acc.stocksEnabled, ...h })) as ExtraRoutes };
}

/** An EVM chain from its spec (chains.ts): real accounts signed through each user's Privy Ethereum wallet (baseaccount.ts). MODE=base-mainnet is evmMode(base). */
export function evmMode(spec: ChainSpec, e: NodeJS.ProcessEnv) {
  const v = spec.evm; if (!v) throw new Error(`chain ${spec.id} is not an EVM chain`);
  const rpcUrl = e[v.rpcEnv] || (e.ALCHEMY_API_KEY && v.alchemyNet ? `https://${v.alchemyNet}.g.alchemy.com/v2/${e.ALCHEMY_API_KEY}` : '');
  const c = { appId: e.PRIVY_APP_ID, appSecret: e.PRIVY_APP_SECRET, authKey: e.PRIVY_AUTH_PRIVATE_KEY, signerId: e.PRIVY_AUTH_KEY_ID, policyId: e.PRIVY_EVM_POLICY_ID?.trim() || e[v.policyEnv] }; // Privy lets a signer carry ONE policy, so one shared EVM policy (every rule pinned to its chain id) wins over the per-chain ids
  const missing = [!rpcUrl && `${v.rpcEnv}${v.alchemyNet ? ' (or ALCHEMY_API_KEY)' : ''}`, ...Object.entries({ PRIVY_APP_ID: c.appId, PRIVY_APP_SECRET: c.appSecret, PRIVY_AUTH_PRIVATE_KEY: c.authKey, PRIVY_AUTH_KEY_ID: c.signerId, [`${v.policyEnv} (or PRIVY_EVM_POLICY_ID)`]: c.policyId }).filter(([, x]) => !x?.trim()).map(([k]) => k)].filter(Boolean);
  if (missing.length) throw new Error(`${spec.id} needs ${missing.join(', ')} (README → Base with Privy).`);
  // the platform fee is paid in SOL inside Solana trades; EVM chains have no fee router yet, so a fee set for a server with no Solana chain would never be charged
  if (e.PLATFORM_FEE_BPS && e.PLATFORM_FEE_BPS !== '0' && !parseChains(e).some(s => s.kind === 'solana')) throw new Error(`PLATFORM_FEE_BPS is set, but fees are not collected on ${spec.label} yet (no on-chain fee router): unset it, or add solana to CHAINS (the fee is charged on Solana trades only)`);
  const eth = (k: string, d: string) => { try { return toUnits(e[k] ?? d, 18, k); } catch (x) { throw new Error((x as Error).message); } };
  const caps = { maxTradeWei: eth(`${v.capsPrefix}_MAX_TRADE_ETH`, v.maxTradeDefault), dailyCapWei: eth(`${v.capsPrefix}_DAILY_CAP_ETH`, v.dailyCapDefault) };
  if (caps.dailyCapWei < caps.maxTradeWei) throw new Error(`${v.capsPrefix}_DAILY_CAP_ETH must be at least ${v.capsPrefix}_MAX_TRADE_ETH`);
  // Relay routes for tokens without a direct pool (Coinbase stocks on Base): on unless <relayEnv>=off; the Relay API key is sent when set (Relay's docs require one for quotes)
  // which aggregator routes tokens with no direct pool: relay, kyberswap (KYBER_CLIENT_ID is sent as x-client-id) or off; the chain's default when unset
  const aggRaw = ((v.aggregatorEnv && e[v.aggregatorEnv]?.trim().toLowerCase()) || v.defaultAggregator || 'relay');
  if (aggRaw !== 'relay' && aggRaw !== 'kyberswap' && aggRaw !== 'off') throw new Error(`${v.aggregatorEnv} must be relay, kyberswap or off`);
  const agg = aggRaw === 'off' ? 'relay' as const : aggRaw;
  // routes off when the aggregator is off, or Relay is chosen and turned off (<relayEnv>=off) or not available on this chain (no relayEnv); KyberSwap needs no Relay switch
  const relayOff = aggRaw === 'off' || (agg === 'relay' && (!v.relayEnv || e[v.relayEnv] === 'off')) || (agg === 'kyberswap' && !!v.relayEnv && e[v.relayEnv] === 'off');
  const relay = relayOff ? false as const : { apiKey: (v.relayKeyEnv && e[v.relayKeyEnv]?.trim()) || undefined };
  const acc = baseAccounts({ rpcUrl, privy: { ...(c as Record<keyof typeof c, string>), apiUrl: e.PRIVY_API_URL || undefined }, caps, relay, aggregator: agg, kyber: agg === 'kyberswap' ? { clientId: e.KYBER_CLIENT_ID?.trim() || undefined } : undefined, network: v.network });
  const statusChecks = [
    { name: `${spec.label} RPC`, run: async () => { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j: any = await r.json(); if (Number(j.result) !== v.chainId) throw new Error(`the RPC is chain ${Number(j.result)}, not ${v.chainId}`); } },
    { name: 'Privy', run: async () => { await fetch(e.PRIVY_API_URL || 'https://api.privy.io', { signal: AbortSignal.timeout(5_000) }); } },
  ];
  return { statusChecks, makeAccount: acc.make, extraRoutes: (h => baseLinkRoutes({ privy: acc.privy, status: acc.status, chain: spec.id, label: acc.network.label, ...h })) as ExtraRoutes };
}
/** MODE=base-mainnet: real accounts on Base signed through each user's Privy Ethereum wallet (baseaccount.ts). */
export const baseMode = (e: NodeJS.ProcessEnv) => evmMode(CHAIN_SPECS.base, e);

/** Every chain the server runs (CHAINS, or MODE), built from its settings. The first is the default chain. Status checks with the same name (Privy) are shown once. */
export function buildChains(e: NodeJS.ProcessEnv): { chains: ChainAccounts[]; statusChecks: { name: string; run: () => Promise<unknown> }[]; specs: ChainSpec[]; otherLegacyMarks: { chain: string; mark: string }[] } {
  const specs = parseChains(e), chains: ChainAccounts[] = [], checks = new Map<string, { name: string; run: () => Promise<unknown> }>(), errs: string[] = [];
  for (const s of specs) {
    try {
      if (s.kind === 'practice') { chains.push({ id: s.id, label: s.label, makeAccount: practiceAccount }); continue; }
      const m = s.kind === 'solana' ? solanaMode(e) : evmMode(s, e);
      chains.push({ id: s.id, label: s.label, makeAccount: m.makeAccount, extraRoutes: m.extraRoutes, legacyMarks: [s.kind === 'solana' ? 'solwallet' : walletState(s.id)] });
      for (const c of m.statusChecks) if (!checks.has(c.name)) checks.set(c.name, c);
    } catch (x) { errs.push((x as Error).message); }
  }
  if (errs.length) throw new Error(errs.join('\n'));
  const otherLegacyMarks = Object.values(CHAIN_SPECS).filter(s => !specs.includes(s) && s.kind !== 'practice').map(s => ({ chain: s.id, mark: s.kind === 'solana' ? 'solwallet' : walletState(s.id) }));
  return { chains, statusChecks: [...checks.values()], specs, otherLegacyMarks };
}

if (import.meta.main) {
  let built: ReturnType<typeof buildChains> | undefined; try { built = buildChains(env); } catch (e) { fail((e as Error).message); }
  const real = built!, mode = real.specs.map(s => s.id).join(',');
  let keys: ApiKey[] = []; try { keys = parseKeyFile(readFileSync(need('API_KEYS_FILE'), 'utf8')); } catch (e) { fail((e as Error).message); }
  const httpUrl = (k: string, v: string) => { let u: URL | undefined; try { u = new URL(v); } catch { /* reported below */ } if (u?.protocol !== 'http:') fail(`${k} must be an http:// URL such as http://10.0.3.7:3500 (nodes talk plain HTTP on the private network; TLS belongs at the load balancer)`); return u!; };
  const publicUrl = need('NODE_PUBLIC_URL'), pub = httpUrl('NODE_PUBLIC_URL', publicUrl);
  if (env.SOLANA_SAMPLE_URL) httpUrl('SOLANA_SAMPLE_URL', env.SOLANA_SAMPLE_URL);
  if ((env.HOST ?? '127.0.0.1') === '127.0.0.1' && !/^(localhost|127\.0\.0\.1)$/.test(pub.hostname)) console.warn(`warning: HOST is 127.0.0.1 but NODE_PUBLIC_URL is ${pub.host}: other nodes cannot reach this one. Set HOST=0.0.0.0 (or this machine's private address).`);
  // Privy sign-in for the /app trading app (privyauth.ts): on only when PRIVY_USERS maps Privy user ids to accounts; API keys keep working either way
  let privyAuth: Parameters<typeof createNode>[0]['privyAuth'];
  if (env.PRIVY_USERS?.trim() || env.PRIVY_SIGNUP === 'open') {
    const { parsePrivyUsers, privyKeys, verifyPrivyToken } = await import('./privyauth.ts');
    let users: Map<string, string> = new Map(); try { users = parsePrivyUsers(env.PRIVY_USERS); } catch (e) { fail((e as Error).message); }
    const appId = need('PRIVY_APP_ID').trim(), keysOf = privyKeys(appId, { pem: env.PRIVY_VERIFICATION_KEY?.trim() || undefined });
    privyAuth = { users, ttlS: int('PRIVY_SESSION_HOURS', 12, 1, 168) * 3600, verify: t => verifyPrivyToken(t, { appId, keys: keysOf }),
      ...(env.PRIVY_SIGNUP === 'open' ? { signup: { max: int('PRIVY_SIGNUP_MAX', 1000, 1, 1_000_000) } } : {}) };
    if (env.PRIVY_SIGNUP && env.PRIVY_SIGNUP !== 'open') fail('PRIVY_SIGNUP must be "open" or unset');
  }
  const node = await createNode({
    privyAuth,
    redisUrl: need('REDIS_URL'), namespace: env.NAMESPACE ?? 'memedesk', publicUrl, keys, chains: real.chains, otherLegacyMarks: real.otherLegacyMarks,
    leaseTtlMs: int('LEASE_TTL_MS', 15_000, 3_000, 300_000), maxUsers: int('MAX_USERS_PER_NODE', 300, 1, 100_000), sweepMs: int('SWEEP_MS', 2000, 200, 60_000),
    rate: { perSecond: int('RATE_PER_SECOND', 20, 1, 10_000), burst: int('RATE_BURST', 40, 1, 20_000) }, requireAof: env.REDIS_REQUIRE_AOF !== 'false',
    solanaSampleUrl: env.SOLANA_SAMPLE_URL || undefined, pgUrl: env.PG_URL || undefined, statusChecks: real.statusChecks,
    maxUsersPerApp: int('MAX_USERS_PER_APP', 10_000, 1, 10_000_000), maxAppFeeBps: int('APP_FEE_MAX_BPS', 100, 0, 500), webhooks: { allowHttp: env.WEBHOOKS_ALLOW_HTTP === 'true' },
  }).catch(e => fail((e as Error).message));
  watchKeyFile(env.API_KEYS_FILE!, k => node.setKeys(k));
  if (env.SOLANA_SAMPLE_URL) console.log(`sample page: http://127.0.0.1:${env.PORT ?? 3500}/solana -> ${env.SOLANA_SAMPLE_URL} (this machine only; 404 for remote requests)`);
  const port = await node.listen(int('PORT', 3500, 1, 65_535), env.HOST ?? '127.0.0.1');
  console.log(`execution node on ${env.HOST ?? '127.0.0.1'}:${port} as ${publicUrl} (chains ${mode}${real.chains.length > 1 ? `, default ${real.chains[0].id}: /v1/<chain>/... picks one` : ''}, ${keys.length} key(s); keys are never printed)`);
  let stopping = false; const stop = async (sig: string) => { if (stopping) return; stopping = true; console.log(`${sig}: draining (releasing leases so other nodes take over)`); await node.drain(); process.exit(0); };
  process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
}
