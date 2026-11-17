/** Throughput and failover measurement for the execution server: real node processes (apps/server/main.ts) on one local Redis, practice accounts, fake funds.
 *  usage: npm run server:loadtest   (env: USERS=200 NODES=3 SECONDS=15 CONCURRENCY=64 ORDERS_PER_USER=5; needs a local Redis on 127.0.0.1:6379)
 *  Phases: (1) reads: GET /v1/overview; (2) writes: market buys; each request goes to the owner half the time, else to a random node (so part are forwarded);
 *  (3) every user places standing orders, then node event-loop delay is read from /metrics idle and under read load; (4) SIGKILL of the busiest node, timing
 *  until every one of its users answers again through the others. Prints a Markdown report; with REPORT=<file> also writes it. Uses its own Redis namespace and deletes it. */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { SyncRedis } from '../../packages/core/src/index.ts';

const env = process.env, USERS = Number(env.USERS ?? 200), NODES = Number(env.NODES ?? 3), SECONDS = Number(env.SECONDS ?? 15), CONC = Number(env.CONCURRENCY ?? 64), OPU = Number(env.ORDERS_PER_USER ?? 5);
const TTL = 15_000, NS = `memedesk-load:${Date.now()}`, dir = mkdtempSync(join(tmpdir(), 'memedesk-load-')), base0 = 3700;
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 }), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const users = Array.from({ length: USERS }, (_, i) => ({ id: `u${i}`, key: randomBytes(24).toString('base64url') }));
writeFileSync(join(dir, 'keys.txt'), users.map(u => `${createHash('sha256').update(u.key).digest('hex')}:${u.id}:trade`).join('\n'));
const nodes = Array.from({ length: NODES }, (_, i) => ({ url: `http://127.0.0.1:${base0 + i}`, port: base0 + i, proc: undefined as ChildProcess | undefined, alive: true }));

type Res = { status: number; ms: number; node: string | undefined };
function call(url: string, path: string, key?: string, method = 'GET', body?: unknown): Promise<Res> {
  const t0 = performance.now(), data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise(ok => {
    const rq = http.request(url + path, { method, agent, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(data ? { 'content-type': 'application/json', 'idempotency-key': 'k' + randomBytes(8).toString('hex') } : {}) } }, r => {
      r.resume(); r.on('end', () => ok({ status: r.statusCode ?? 0, ms: performance.now() - t0, node: r.headers['x-memedesk-node'] as string | undefined }));
    });
    rq.on('error', () => ok({ status: 0, ms: performance.now() - t0, node: undefined })); rq.end(data);
  });
}
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '–');
async function metrics(url: string) { try { const t = await new Promise<string>((ok, no) => http.get(url + '/metrics', r => { let s = ''; r.on('data', d => (s += d)); r.on('end', () => ok(s)); }).on('error', no)); const g = (re: RegExp) => Number(re.exec(t)?.[1] ?? NaN);
  return { users: g(/memedesk_users_owned (\d+)/), orders: g(/memedesk_orders_active (\d+)/), p50: g(/quantile="0.5"} ([\d.]+)/), p99: g(/quantile="0.99"} ([\d.]+)/), max: g(/quantile="1"} ([\d.]+)/) }; } catch { return undefined; } }

/** Run CONC loops for SECONDS: each picks a random user and a node (half the time a non-owner), sends one request, records latency. */
async function load(label: string, make: (u: typeof users[0]) => [string, string, unknown?]) {
  const owner = new Map<string, string>(), lat: { all: number[]; direct: number[]; fwd: number[] } = { all: [], direct: [], fwd: [] }; let ok = 0, err = 0; const end = Date.now() + SECONDS * 1000;
  const live = () => nodes.filter(n => n.alive);
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (Date.now() < end) {
      const u = users[Math.floor(Math.random() * users.length)], own = owner.get(u.id), ln = live();
      const target = own && Math.random() < 0.5 ? own : ln[Math.floor(Math.random() * ln.length)].url;
      const [method, path, body] = make(u); const r = await call(target, path, u.key, method, body);
      if (r.status === 200) { ok++; lat.all.push(r.ms); (r.node === target ? lat.direct : lat.fwd).push(r.ms); if (r.node) owner.set(u.id, r.node); } else err++;
    }
  }));
  return { label, rps: ok / SECONDS, ok, err, p50: pct(lat.all, 50), p99: pct(lat.all, 99), dp50: pct(lat.direct, 50), dp99: pct(lat.direct, 99), fp50: pct(lat.fwd, 50), fp99: pct(lat.fwd, 99), fwdShare: lat.fwd.length / Math.max(1, lat.all.length) };
}

const report: string[] = []; const say = (s = '') => { report.push(s); console.log(s); };
try {
  for (const n of nodes) {
    n.proc = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/server/main.ts'], { stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:6379', REDIS_REQUIRE_AOF: 'false', API_KEYS_FILE: join(dir, 'keys.txt'), NAMESPACE: NS, NODE_PUBLIC_URL: n.url, PORT: String(n.port),
        LEASE_TTL_MS: String(TTL), SWEEP_MS: '500', MAX_USERS_PER_NODE: String(USERS), RATE_PER_SECOND: '1000', RATE_BURST: '2000' } });
  }
  for (const n of nodes) { for (let i = 0; i < 100 && (await call(n.url, '/readyz')).status !== 200; i++) await sleep(200); }
  // let the sweeps spread the users, then touch every user once so all are owned
  await sleep(3000); for (const u of users) await call(nodes[0].url, '/v1/overview', u.key);
  const spread = await Promise.all(nodes.map(n => metrics(n.url)));
  say(`# Execution server load test`); say();
  say(`Run ${new Date().toISOString()} on this machine (${cpus().length} CPU threads, ${cpus()[0]?.model ?? 'unknown CPU'}), local Redis, ${NODES} node processes, ${USERS} practice users (fake funds), ${CONC} concurrent clients, ${SECONDS} s per phase. Each request goes to the user's owner node half the time and to a random node otherwise, so about ${Math.round(50 * (NODES - 1) / NODES)}% are forwarded one hop.`); say();
  say(`Users per node after the sweep: ${spread.map((m, i) => `node ${i + 1}: ${m?.users ?? '?'}`).join(', ')}.`); say();

  const reads = await load('Reads (GET /v1/overview)', () => ['GET', '/v1/overview']);
  const writes = await load('Market buys (POST /v1/trades/buy)', () => ['POST', '/v1/trades/buy', { walletId: 'w1', token: '0xMEME', amount: '100' }]);
  say(`| Phase | Requests/s | OK | Errors | p50 ms | p99 ms | direct p50 / p99 | forwarded p50 / p99 | forwarded share |`); say(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of [reads, writes]) say(`| ${r.label} | ${f1(r.rps)} | ${r.ok} | ${r.err} | ${f1(r.p50)} | ${f1(r.p99)} | ${f1(r.dp50)} / ${f1(r.dp99)} | ${f1(r.fp50)} / ${f1(r.fp99)} | ${(r.fwdShare * 100).toFixed(0)}% |`);
  say();

  // standing orders: far from the market so they are watched every tick but never fire
  let placed = 0; for (const u of users) for (let k = 0; k < OPU; k++) { const r = await call(nodes[0].url, '/v1/orders/limit-sell', u.key, 'POST', { walletId: 'w1', token: '0xMEME', amount: '10', priceE18: (10n ** 30n).toString() }); if (r.status === 200) placed++; }
  await Promise.all(nodes.map(n => metrics(n.url))); await sleep(5000);
  const idle = await Promise.all(nodes.map(n => metrics(n.url)));
  const busy = load('Reads with orders watched', () => ['GET', '/v1/overview']); await sleep(SECONDS * 500); const under = await Promise.all(nodes.map(n => metrics(n.url))); const r3 = await busy;
  say(`Standing orders placed: ${placed} (${OPU} per user). Event-loop delay per node, idle for 5 s and then under the read load (ms, p50 / p99 / max):`); say();
  say(`| Node | Users | Active orders | Idle p50 / p99 / max | Under load p50 / p99 / max |`); say(`|---|---|---|---|---|`);
  nodes.forEach((n, i) => { const a = idle[i], b = under[i]; say(`| ${i + 1} | ${a?.users} | ${a?.orders} | ${f1(a!.p50)} / ${f1(a!.p99)} / ${f1(a!.max)} | ${f1(b!.p50)} / ${f1(b!.p99)} / ${f1(b!.max)} |`); });
  say(); say(`Reads with every order being watched: ${f1(r3.rps)} requests/s, p50 ${f1(r3.p50)} ms, p99 ${f1(r3.p99)} ms, ${r3.err} errors.`); say();

  // failover: SIGKILL the node with the most users, time until each of its users answers again elsewhere
  const counts = idle.map(m => m?.users ?? 0), vi = counts.indexOf(Math.max(...counts)), victim = nodes[vi];
  const before = new Map<string, string>(); for (const u of users) { const r = await call(nodes[(vi + 1) % NODES].url, '/v1/overview', u.key); if (r.node) before.set(u.id, r.node); }
  const theirs = users.filter(u => before.get(u.id) === victim.url);
  const t0 = Date.now(); victim.proc!.kill('SIGKILL'); victim.alive = false;
  const back = new Map<string, number>(); const other = nodes.filter(n => n.alive);
  while (back.size < theirs.length && Date.now() - t0 < TTL + 30_000) {
    await Promise.all(theirs.filter(u => !back.has(u.id)).map(async u => { const r = await call(other[Math.floor(Math.random() * other.length)].url, '/v1/overview', u.key); if (r.status === 200) back.set(u.id, Date.now() - t0); }));
    await sleep(250);
  }
  const times = [...back.values()];
  say(`Failover: SIGKILL of node ${vi + 1}, which owned ${theirs.length} users (lease TTL ${TTL / 1000} s). ${back.size} of ${theirs.length} answered again through the other nodes; first after ${f1(Math.min(...times) / 1000)} s, half after ${f1(pct(times, 50) / 1000)} s, all after ${f1(Math.max(...times) / 1000)} s.`);
  const after = await Promise.all(other.map(n => metrics(n.url))); say(); say(`Users per surviving node afterwards: ${after.map((m, i) => `${m?.users}`).join(', ')}; their active orders: ${after.map(m => m?.orders).join(', ')}.`);
  if (env.REPORT) writeFileSync(env.REPORT, report.join('\n') + '\n');
} finally {
  for (const n of nodes) n.proc?.kill('SIGTERM'); await sleep(1500); for (const n of nodes) n.proc?.kill('SIGKILL');
  const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${NS}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); }
  agent.destroy();
}
