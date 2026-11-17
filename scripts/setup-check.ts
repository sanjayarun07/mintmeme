/** What is configured and what is missing, per part (README "Setup" and the custody setup checklist). Read-only: changes nothing, and never prints a secret value,
 *  only whether it is set and looks plausible. usage: npm run setup:check */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SyncRedis } from '../packages/core/src/index.ts';

const env = process.env, rows: [string, string, 'ok' | 'missing' | 'warn' | 'n/a', string][] = [];
const add = (part: string, item: string, state: 'ok' | 'missing' | 'warn' | 'n/a', hint = '') => rows.push([part, item, state, hint]);
const set = (k: string) => typeof env[k] === 'string' && env[k]!.trim() !== '';
const has = (cmd: string) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };

// basics
const [maj, min] = process.versions.node.split('.').map(Number); add('basics', `Node ${process.versions.node}`, maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'missing', 'needs Node 22.18 or newer');
add('basics', '.env file', existsSync('.env') ? 'ok' : 'missing', 'cp .env.example .env');
let ignored = false; try { execFileSync('git', ['check-ignore', '-q', '.env']); ignored = true; } catch { /* not ignored or no git */ }
add('basics', '.env is git-ignored', ignored ? 'ok' : 'warn', 'secrets must never be committed');

// Solana test UI
add('/solana UI', 'ALCHEMY_API_KEY', set('ALCHEMY_API_KEY') ? 'ok' : 'missing', 'mainnet reads; Alchemy dashboard');
add('/solana UI', 'PRIVY_APP_ID (Privy login)', set('PRIVY_APP_ID') ? 'ok' : 'warn', 'optional: Privy dashboard → app id');
add('/solana UI', 'Privy bundle built', existsSync('apps/web/privy.bundle.js') ? 'ok' : (set('PRIVY_APP_ID') ? 'missing' : 'n/a'), 'npm run build:privy');

// execution server
let redis: 'ok' | 'missing' | 'warn' = 'missing', aof = '?';
try { const r = new SyncRedis(env.REDIS_URL || 'redis://127.0.0.1:6379', 1500); try { if (r.cmd('PING') === 'PONG') { redis = 'ok'; try { aof = r.cmd('CONFIG', 'GET', 'appendonly')?.[1] ?? '?'; } catch { /* managed Redis */ } } } finally { r.close(); } } catch { redis = 'missing'; }
add('server', `Redis at ${env.REDIS_URL ? 'REDIS_URL' : '127.0.0.1:6379'}`, redis, 'install and start Redis (or set REDIS_URL)');
add('server', `Redis appendonly = ${aof}`, aof === 'yes' ? 'ok' : redis === 'ok' ? 'warn' : 'n/a', 'production: appendonly yes; local tests: REDIS_REQUIRE_AOF=false');
add('server', 'NODE_PUBLIC_URL', set('NODE_PUBLIC_URL') ? (/^http:\/\//.test(env.NODE_PUBLIC_URL!) ? 'ok' : 'missing') : 'missing', 'http://<this node, reachable by the others>:3500');
const kf = env.API_KEYS_FILE; let keys = 0; if (kf && existsSync(kf)) keys = readFileSync(kf, 'utf8').split(/\r?\n/).filter(l => /^[0-9a-f]{64}:/i.test(l.trim())).length;
add('server', `API_KEYS_FILE (${keys} key line${keys === 1 ? '' : 's'})`, keys > 0 ? 'ok' : 'missing', 'npm run server:key -- <user>, append the hash line');

// delegated signing (planned)
const looksKey = (k: string) => set(k) && env[k]!.trim().length >= 40;
add('Privy signing', 'PRIVY_APP_SECRET', looksKey('PRIVY_APP_SECRET') ? 'ok' : set('PRIVY_APP_SECRET') ? 'warn' : 'missing', 'App settings → Basics → API keys');
add('Privy signing', 'PRIVY_AUTH_KEY_ID', set('PRIVY_AUTH_KEY_ID') ? 'ok' : 'missing', 'Wallet infrastructure → Keys and quorums → New key');
add('Privy signing', 'PRIVY_AUTH_PRIVATE_KEY', looksKey('PRIVY_AUTH_PRIVATE_KEY') ? 'ok' : set('PRIVY_AUTH_PRIVATE_KEY') ? 'warn' : 'missing', 'shown once when the key is created');
add('Privy signing', 'PRIVY_SOLANA_POLICY_ID', set('PRIVY_SOLANA_POLICY_ID') ? 'ok' : 'missing', 'Wallet infrastructure → Policies (chain type Solana)');
add('Privy signing', 'PRIVY_ETHEREUM_POLICY_ID', set('PRIVY_ETHEREUM_POLICY_ID') ? 'ok' : 'n/a', 'later, for EVM');

// verification tools
add('fork tests', 'solana-test-validator (verify:sol-guard)', has('solana-test-validator') ? 'ok' : 'warn', 'Solana CLI');
add('fork tests', 'anvil (verify:evm)', has('anvil') ? 'ok' : 'warn', 'Foundry');
add('fork tests', 'docker (3-node stack)', has('docker') ? 'ok' : 'warn', 'Docker Desktop');

const mark = { ok: '✓', missing: '✗', warn: '!', 'n/a': '–' }, w = Math.max(...rows.map(r => r[1].length));
let part = ''; for (const [p, item, s, hint] of rows) { if (p !== part) { console.log(`\n${p}`); part = p; } console.log(`  ${mark[s]} ${item.padEnd(w)}  ${s === 'ok' || s === 'n/a' ? '' : hint}`); }
const missing = rows.filter(r => r[2] === 'missing');
console.log(`\n${missing.length ? `${missing.length} missing: ${[...new Set(missing.map(r => r[0]))].join(', ')} not fully set up (README → Setup / Custody plan).` : 'Everything checked is set up.'}  ✓ ok  ✗ missing  ! check  – not needed yet`);
