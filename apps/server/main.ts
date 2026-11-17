/** Production entry point for one node of the execution server. Run several, behind a load balancer, all pointed at one Redis.
 *  usage: node --env-file-if-exists=.env --experimental-transform-types --no-warnings apps/server/main.ts   (or: npm run server)
 *  Environment (see docs/PRODUCTION_SERVER.md):
 *    REDIS_URL           redis://[:password@]host:6379   (required; run Redis with appendonly yes)
 *    NODE_PUBLIC_URL     how the OTHER nodes reach this one, e.g. http://10.0.3.7:3500   (required)
 *    API_KEYS_FILE       file of "sha256hex:userId[:read|trade]" lines (make lines with apps/server/keys.ts)   (required)
 *    PORT=3500  HOST=127.0.0.1 (0.0.0.0 in a container)  NAMESPACE=memedesk  MODE=practice
 *    LEASE_TTL_MS=15000  MAX_USERS_PER_NODE=300  SWEEP_MS=2000  RATE_PER_SECOND=20  RATE_BURST=40  REDIS_REQUIRE_AOF=true
 *    SOLANA_SAMPLE_URL   optional, e.g. http://127.0.0.1:3000: serve the /solana test page (and its /api/sol/* calls) from that running terminal, to THIS machine only
 *  MODE: only `practice` (simulated chain, fake funds) is built in. Real-chain accounts need your own factory and signer (accounts.ts). */
import { readFileSync } from 'node:fs';
import { createNode } from './node.ts';
import { practiceAccount } from './accounts.ts';
import type { ApiKey } from '../api/server.ts';

const env = process.env, fail = (m: string): never => { console.error(m); process.exit(2); };
const need = (k: string) => env[k] || fail(`${k} is not set. See the header of apps/server/main.ts or docs/PRODUCTION_SERVER.md.`);
const int = (k: string, d: number, min: number, max: number) => { const v = env[k] === undefined ? d : Number(env[k]); if (!Number.isInteger(v) || v < min || v > max) fail(`${k} must be a whole number from ${min} to ${max}`); return v; };

export function parseKeyFile(text: string): ApiKey[] {
  const out: ApiKey[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim(); if (!s || s.startsWith('#')) return;
    const [keyHash, userId, scope = 'trade'] = s.split(':');
    if (!/^[0-9a-f]{64}$/i.test(keyHash ?? '') || !userId || (scope !== 'trade' && scope !== 'read')) throw new Error(`API_KEYS_FILE line ${i + 1}: expected "sha256hex:userId[:read|trade]" (plain keys are not accepted here)`);
    out.push({ keyHash, userId, scope });
  });
  if (!out.length) throw new Error('API_KEYS_FILE has no keys');
  return out;
}

if (import.meta.main) {
  const mode = env.MODE ?? 'practice'; if (mode !== 'practice') fail(`MODE=${mode} is not built in. Only MODE=practice ships; real chains need your own account factory and signer (apps/server/accounts.ts).`);
  let keys: ApiKey[] = []; try { keys = parseKeyFile(readFileSync(need('API_KEYS_FILE'), 'utf8')); } catch (e) { fail((e as Error).message); }
  const httpUrl = (k: string, v: string) => { let u: URL | undefined; try { u = new URL(v); } catch { /* reported below */ } if (u?.protocol !== 'http:') fail(`${k} must be an http:// URL such as http://10.0.3.7:3500 (nodes talk plain HTTP on the private network; TLS belongs at the load balancer)`); return u!; };
  const publicUrl = need('NODE_PUBLIC_URL'), pub = httpUrl('NODE_PUBLIC_URL', publicUrl);
  if (env.SOLANA_SAMPLE_URL) httpUrl('SOLANA_SAMPLE_URL', env.SOLANA_SAMPLE_URL);
  if ((env.HOST ?? '127.0.0.1') === '127.0.0.1' && !/^(localhost|127\.0\.0\.1)$/.test(pub.hostname)) console.warn(`warning: HOST is 127.0.0.1 but NODE_PUBLIC_URL is ${pub.host}: other nodes cannot reach this one. Set HOST=0.0.0.0 (or this machine's private address).`);
  const node = await createNode({
    redisUrl: need('REDIS_URL'), namespace: env.NAMESPACE ?? 'memedesk', publicUrl, keys, makeAccount: practiceAccount,
    leaseTtlMs: int('LEASE_TTL_MS', 15_000, 3_000, 300_000), maxUsers: int('MAX_USERS_PER_NODE', 300, 1, 100_000), sweepMs: int('SWEEP_MS', 2000, 200, 60_000),
    rate: { perSecond: int('RATE_PER_SECOND', 20, 1, 10_000), burst: int('RATE_BURST', 40, 1, 20_000) }, requireAof: env.REDIS_REQUIRE_AOF !== 'false',
    solanaSampleUrl: env.SOLANA_SAMPLE_URL || undefined,
  }).catch(e => fail((e as Error).message));
  if (env.SOLANA_SAMPLE_URL) console.log(`sample page: http://127.0.0.1:${env.PORT ?? 3500}/solana -> ${env.SOLANA_SAMPLE_URL} (this machine only; 404 for remote requests)`);
  const port = await node.listen(int('PORT', 3500, 1, 65_535), env.HOST ?? '127.0.0.1');
  console.log(`execution node on ${env.HOST ?? '127.0.0.1'}:${port} as ${publicUrl} (mode ${mode}, ${keys.length} key(s); keys are never printed)`);
  let stopping = false; const stop = async (sig: string) => { if (stopping) return; stopping = true; console.log(`${sig}: draining (releasing leases so other nodes take over)`); await node.drain(); process.exit(0); };
  process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
}
