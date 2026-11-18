/** COPY TRADING THROUGH THE EXECUTION SERVER (MODE=solana-mainnet), END TO END ON A LOCAL VALIDATOR. Two real nodes share the local Redis; the chain is a solana-test-validator
 *  with the pump.fun program and one live curve cloned; Privy is the local stand-in (packages/sol/test/fakeprivy.ts). The LEADER is an independent wallet that trades the curve
 *  with its own stand-in Privy signer (not a server user); the FOLLOWER (alice) copies it through POST /v1/copies.
 *  Fake SOL, throwaway keys, nothing reaches mainnet. usage: npm run verify:server-copy (needs ALCHEMY_API_KEY in .env, solana-test-validator and Redis on 127.0.0.1:6379). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { SolJsonRpc, DevSolSigner } from '../../sol/src/index.ts';
import { SyncRedis } from '../../core/src/index.ts';
import { startPumpValidator } from './pumpenv.ts';
import { fakePrivy } from '../../sol/test/fakeprivy.ts';
import { createNode } from '../../../apps/server/node.ts';
import { solanaAccounts, linkRoutes } from '../../../apps/server/solaccount.ts';

const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DONE = ['finalized', 'failed', 'expired'];
async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = []; const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const env = await startPumpValidator(key, 8995), rpc = new SolJsonRpc(env.url), ns = `memedesk-copyfork:${Date.now()}`, mint = env.mint;
  // follower: a server user with a linked (stand-in) Privy wallet
  const seed = randomBytes(32), wallet = new DevSolSigner(), addr = wallet.add(seed), fp = fakePrivy({ seed });
  const API_KEY = 'alice-copy-key-0123456789abcdef', keys = [{ keyHash: createHash('sha256').update(API_KEY).digest('hex'), userId: 'alice' }];
  const acc = solanaAccounts({ rpcUrl: env.url, privy: { ...fp.cfg, fetchFn: fp.fetchFn }, venues: ['pump'], solUsd: async () => ({ price: 150, at: Date.now() }) });
  // leader: an independent wallet trading the same curve, driven in process (its own stand-in Privy and state; not on the server)
  const lseed = randomBytes(32), leader = new DevSolSigner().add(lseed), lfp = fakePrivy({ seed: lseed }), lstate = new Map<string, string>();
  const lacc = solanaAccounts({ rpcUrl: env.url, privy: { ...lfp.cfg, fetchFn: lfp.fetchFn }, venues: ['pump'], caps: { maxTradeLamports: 1_000_000_000n, dailyCapLamports: 5_000_000_000n }, solUsd: async () => ({ price: 150, at: Date.now() }) });
  const lst = (n: string) => ({ read: () => lstate.get(n), write: (d: string) => { lstate.set(n, d); }, describe: () => n });
  const nodes: { nd: Awaited<ReturnType<typeof createNode>>; url: string }[] = [];
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns, publicUrl: url, keys, makeAccount: acc.make, extraRoutes: h => linkRoutes({ privy: acc.privy, status: acc.status, safety: acc.safety, ...h }), leaseTtlMs: 3000, sweepMs: 1000, requireAof: false, log: () => {} });
    await nd.listen(port); const x = { nd, url }; nodes.push(x); return x; };
  const call = async (base: string, method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any, node: r.headers.get('x-memedesk-node') ?? '' }; };
  const tokensOf = async (who: string) => (await rpc.call<any>('getTokenAccountsByOwner', [who, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  const airdrop = async (who: string, lamports: number) => { const s0 = await rpc.call<string>('requestAirdrop', [who, lamports]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[s0]]); if (s.value[0]?.confirmationStatus) return; await sleep(250); } };
  const copyTrades = async (base: string) => ((await call(base, 'GET', '/v1/trades?origin=copy&limit=50')).j as any[]) ?? [];
  const waitFor = async (f: () => Promise<boolean>, ms: number) => { for (let t = 0; t < ms; t += 500) { if (await f()) return true; await sleep(500); } return false; };
  try {
    await airdrop(addr, 2_000_000_000); await airdrop(leader, 3_000_000_000);
    lst('solwallet').write(JSON.stringify({ address: leader, walletId: 'wallet-1', linkedAt: Date.now() })); const L = await lacc.make('leader', lst); await L.trader.resume();
    const leaderTrade = async (side: 'buy' | 'sell', amount: string, k: string) => { const body = await L.prepare!({ token: mint, amount, slippageBps: 1000, key: k }, `/v1/trades/${side}`);
      let t: any = await (side === 'buy' ? L.trader.buy(body) : L.trader.sell(body)); for (let i = 0; i < 40 && !DONE.includes(t.state); i++) { await sleep(1000); t = await L.trader.advance(t.key); } return t; };
    const a = await mk(), b = await mk();
    const st = await call(b.url, 'POST', '/v1/wallet/link/start', { address: addr });
    const ln = await call(b.url, 'POST', '/v1/wallet/link/finish', { address: addr, signature: Buffer.from(wallet.sign(addr, new TextEncoder().encode(st.j.message))).toString('base64') });
    check('C1 the follower links its Privy wallet over the API and is active', ln.status === 200 && ln.j.active === true, JSON.stringify(ln.j));
    // history: the leader buys BEFORE the copy exists
    const h = await leaderTrade('buy', '100000000', 'lead-history');
    check('C2 the leader buys 0.1 SOL of the cloned pump.fun token (before any copy exists)', h.state === 'finalized' && (await tokensOf(leader)) > 0n, JSON.stringify({ state: h.state, failure: h.failure }));
    const owner = (await call(a.url, 'GET', '/v1/wallet')).node, other = owner === a.url ? b : a;
    // validation and caps over the API, then a real copy config through the NON-owner node (forwarded)
    const bad = await call(other.url, 'POST', '/v1/copies', { leader, fixedSol: '0.01', maxPerTradeSol: '0.5' });
    check('C3 a copy whose per-trade cap is above the account cap (0.05 SOL) is refused with the limit named', bad.status === 400 && bad.j.error?.code === 'above_cap' && /0\.05 SOL/.test(bad.j.error.message), JSON.stringify(bad.j));
    const cr = await call(other.url, 'POST', '/v1/copies', { id: 'lead', leader, fixedSol: '0.01', slippagePct: 10 });
    const ls = await call(other.url, 'GET', '/v1/copies');
    check('C4 a copy config is created through the non-owner node and listed with its settings', cr.status === 200 && cr.j.id === 'lead' && cr.j.fixedSol === '0.01' && ls.j.length === 1 && ls.j[0].running === true && ls.j[0].leaders[0] === leader, JSON.stringify({ cr: cr.j, ls: ls.j }).slice(0, 400));
    await sleep(4000);
    check('C5 history is not copied: the leader\'s buy from before the copy produced no trade', (await copyTrades(other.url)).length === 0 && (await tokensOf(addr)) === 0n, JSON.stringify(await copyTrades(other.url)).slice(0, 300));
    // the leader buys: the follower copies 0.01 SOL by itself
    const t0 = await tokensOf(addr), l1 = await leaderTrade('buy', '100000000', 'lead-1');   // before: the copy can land while the leader's trade is still settling
    const got1 = await waitFor(async () => (await copyTrades(other.url)).some(t => t.state === 'finalized'), 30_000);
    const ct1 = await copyTrades(other.url), f1 = await tokensOf(addr);
    check('C6 the leader\'s next buy is copied: the follower\'s wallet buys with fixedSol 0.01 (signed by Privy), and the tokens arrive', l1.state === 'finalized' && got1 && ct1.length === 1 && String(ct1[0].amountIn) === '10000000' && f1 > t0 && fp.state.signed >= 1, JSON.stringify({ leader: l1.state, trades: ct1.map(t => ({ s: t.state, a: t.amountIn, f: t.failure })), tokens: String(f1), view: (await call(other.url, 'GET', '/v1/copies')).j[0] }).slice(0, 600));
    const tx1: any = ct1[0]?.txHash ? await rpc.call('getTransaction', [ct1[0].txHash, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) : null;
    check('C7 the copied buy is a pump.fun transaction paid by the follower wallet', !!tx1 && tx1.transaction.message.accountKeys[0] === addr && tx1.transaction.message.accountKeys.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), String(ct1[0]?.txHash));
    // the owner crashes: the other node takes the user over and the copy config comes back from Redis
    const ownerNode = nodes.find(x => x.url === owner)!; await ownerNode.nd.crash(); nodes.splice(nodes.indexOf(ownerNode), 1);
    let w: any; for (let i = 0; i < 30; i++) { await sleep(500); w = await call(other.url, 'GET', '/v1/copies'); if (w.status === 200 && w.node === other.url) break; }
    check('C8 after the owner node crashes, the surviving node owns the user and the copy config is back, running', w?.node === other.url && w.j.length === 1 && w.j[0].id === 'lead' && w.j[0].running === true, JSON.stringify(w?.j).slice(0, 300));
    const l2 = await leaderTrade('buy', '100000000', 'lead-2');
    const got2 = await waitFor(async () => (await copyTrades(other.url)).filter(t => t.state === 'finalized').length >= 2, 30_000), ct2 = await copyTrades(other.url), f2 = await tokensOf(addr);
    check('C9 after the failover, the next leader buy is copied exactly once, and the earlier one is not copied again', l2.state === 'finalized' && got2 && ct2.length === 2 && f2 > f1, JSON.stringify({ trades: ct2.map(t => ({ s: t.state, k: t.key, f: t.failure })), tokens: String(f2) }).slice(0, 500));
    // the leader sells everything: the follower follows the exit (full-on-exit) with what the copies bought
    const lt = await tokensOf(leader), ls1 = await leaderTrade('sell', String(lt), 'lead-exit');
    const got3 = await waitFor(async () => (await copyTrades(other.url)).some(t => t.state === 'finalized' && t.tokenIn === mint), 30_000), f3 = await tokensOf(addr);
    check('C10 the leader sells its whole position; the follower sells what the copies bought (follows the exit)', ls1.state === 'finalized' && got3 && f3 < f2, JSON.stringify({ leader: ls1.state, tokens: String(f3), trades: (await copyTrades(other.url)).map(t => ({ s: t.state, in: t.tokenIn === mint ? 'token' : 'sol', f: t.failure })) }).slice(0, 500));
    // delete: no more copies
    const del = await call(other.url, 'DELETE', '/v1/copies/lead'), after = await call(other.url, 'GET', '/v1/copies'), n0 = (await copyTrades(other.url)).length;
    const l4 = await leaderTrade('buy', '50000000', 'lead-after-delete'); await sleep(6000);
    check('C11 DELETE /v1/copies/:id stops the copy: the list is empty and the leader\'s next buy is not copied', del.status === 200 && del.j.removed === true && after.j.length === 0 && l4.state === 'finalized' && (await copyTrades(other.url)).length === n0, JSON.stringify({ del: del.j, after: after.j, n0 }));
    const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-server-copy.md`;
    writeFileSync(file, ['# Copy trading through the execution server, MODE=solana-mainnet, on a local validator', '', `Run: ${new Date().toISOString()}`,
      'Two server nodes, local Redis, solana-test-validator with pump.fun and one live curve cloned from mainnet, Privy stand-ins for both wallets. NOT mainnet. Fake SOL, throwaway keys.',
      'The leader is an independent wallet (not a server user) that buys and sells the curve; the follower copies it through POST /v1/copies with fixedSol 0.01.', '',
      `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length} of ${checks.length})`, '', ...checks.map(c => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.pass ? '' : ` (${c.detail.replace(/[A-Za-z0-9_-]{40,}/g, '***')})`}`), '',
      '## Not covered', '- Real Privy, Jupiter routes (they point at mainnet accounts the clone does not have), tokenized stocks (checked offline in apps/server/copies.test.ts), mainnet.',
      '- Leader trades on venues this server cannot execute: the copy rules skip them (no price), covered offline.'].join('\n'));
    console.log(`\nreport: ${file}`); process.exitCode = pass ? 0 : 1;
  } finally { for (const x of nodes) await x.nd.drain().catch(() => {}); const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${ns}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); } env.stop(); }
}
main().catch(e => { console.error(String((e as Error).stack ?? e).replace(/[A-Za-z0-9_-]{24,}/g, m => m.length > 40 ? '***' : m)); process.exit(1); });
