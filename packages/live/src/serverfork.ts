/** THE EXECUTION SERVER IN MODE=solana-mainnet, END TO END ON A LOCAL VALIDATOR. Two real nodes share the local Redis; the chain is a solana-test-validator with the pump.fun
 *  program and one live curve cloned; Privy is the local stand-in (packages/sol/test/fakeprivy.ts: same request signing, the README policy, signs with the test key).
 *  Fake SOL, throwaway key, nothing reaches mainnet. usage: npm run verify:server-sol (needs ALCHEMY_API_KEY in .env, solana-test-validator and Redis on 127.0.0.1:6379). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { SolJsonRpc, DevSolSigner, b58decode } from '../../sol/src/index.ts';
import { SyncRedis } from '../../core/src/index.ts';
import { startPumpValidator } from './pumpenv.ts';
import { fakePrivy } from '../../sol/test/fakeprivy.ts';
import { createNode } from '../../../apps/server/node.ts';
import { MemeClient } from '../../sdk/src/client.ts';
import { solanaAccounts, linkRoutes } from '../../../apps/server/solaccount.ts';

const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = []; const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const env = await startPumpValidator(key, 8991), rpc = new SolJsonRpc(env.url), ns = `memedesk-serverfork:${Date.now()}`, mint = env.mint;
  const seed = randomBytes(32), wallet = new DevSolSigner(), addr = wallet.add(seed), fp = fakePrivy({ seed });
  const API_KEY = 'alice-fork-key-0123456789abcdef', keys = [{ keyHash: createHash('sha256').update(API_KEY).digest('hex'), userId: 'alice' }];
  // a stand-in Jito block engine and tip floor: it records what it receives and forwards the transaction to the local validator (the real engine exists only on mainnet)
  const tipAcct = new DevSolSigner().add(randomBytes(32)), jitoSeen: { url: string; method: string; raw?: string }[] = [];
  const jitoFetch = (async (url: any, init: any = {}) => { const u = String(url), ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    if (u.includes('tip_floor')) return new Response(JSON.stringify([{ landed_tips_75th_percentile: 0.00001 }]), { status: 200 });
    const b = JSON.parse(init.body); jitoSeen.push({ url: u, method: b.method, raw: b.params?.[0] });
    if (b.method === 'getTipAccounts') return ok([tipAcct]);
    if (b.method === 'sendTransaction') return ok(await rpc.call('sendTransaction', [b.params[0], { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]));
    return new Response('{}', { status: 400 }); }) as typeof fetch;
  const acc = solanaAccounts({ rpcUrl: env.url, privy: { ...fp.cfg, fetchFn: fp.fetchFn }, venues: ['pump'], jito: { url: 'http://jito.test', tipFloorUrl: 'http://jito.test/tip_floor', fetchFn: jitoFetch, minIntervalMs: 0 }, solUsd: async () => ({ price: 150, at: Date.now() }) });
  const nodes: { nd: Awaited<ReturnType<typeof createNode>>; url: string }[] = [];
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns, publicUrl: url, keys, makeAccount: acc.make, extraRoutes: h => linkRoutes({ privy: acc.privy, status: acc.status, safety: acc.safety, ...h }), leaseTtlMs: 3000, sweepMs: 1000, requireAof: false, log: () => {} });
    await nd.listen(port); const x = { nd, url }; nodes.push(x); return x; };
  const cl = (base: string) => new MemeClient({ baseUrl: base, apiKey: API_KEY, timeoutMs: 120_000 });
  const call = async (base: string, method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any, node: r.headers.get('x-memedesk-node') ?? '' }; };
  const tokens = async () => (await rpc.call<any>('getTokenAccountsByOwner', [addr, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  try {
    const air = await rpc.call<string>('requestAirdrop', [addr, 2_000_000_000]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[air]]); if (s.value[0]?.confirmationStatus) break; await sleep(250); }
    const a = await mk(), b = await mk();
    // link through node b
    const st = await call(b.url, 'POST', '/v1/wallet/link/start', { address: addr });
    const ln = await call(b.url, 'POST', '/v1/wallet/link/finish', { address: addr, signature: Buffer.from(wallet.sign(addr, new TextEncoder().encode(st.j.message))).toString('base64') });
    check('S1 linking the Privy wallet over the API activates the account', ln.status === 200 && ln.j.active === true, JSON.stringify(ln.j));
    const owner = (await call(a.url, 'GET', '/v1/wallet')).node, other = owner === a.url ? b : a;
    // a market buy sent to the node that does NOT own the user: forwarded, signed by Privy, lands on the validator
    const t0 = await tokens(), buy = { status: 200, j: await cl(other.url).swap({ side: 'buy', mint, sol: '0.02', slippagePct: 5, key: 'fork-buy-1' }) };   // plain units, the linked wallet by default
    let tr = buy.j; for (let i = 0; i < 40 && !['finalized', 'failed', 'expired'].includes(tr.state); i++) { await sleep(1000); tr = (await call(other.url, 'POST', `/v1/trades/alice.fork-buy-1/advance`)).j; }
    check('S2 a market buy in plain units (sol: "0.02", no walletId) through the non-owner node is signed by Privy and lands', buy.status === 200 && tr.state !== 'failed' && (await tokens()) > t0 && fp.state.signed >= 1, JSON.stringify(tr).slice(0, 240));
    { const t: any = await rpc.call('getTransaction', [tr.txHash, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); const m = t?.transaction?.message, cb = m ? m.accountKeys.indexOf('ComputeBudget111111111111111111111111111111') : -1;
      const ds = (m?.instructions ?? []).filter((i: any) => i.programIdIndex === cb).map((i: any) => Buffer.from(b58decode(i.data))), lim = ds.find((d: Buffer) => d[0] === 2)?.readUInt32LE(1), price = ds.find((d: Buffer) => d[0] === 3)?.readBigUInt64LE(1);
      check('S10 the buy carries a compute-unit limit from simulation (not 300,000 or 1.4M) and a priority price capped at 0.0001 SOL in total', !!lim && lim < 300_000 && price !== undefined && price > 0n && price * BigInt(lim) <= 100_000n * 1_000_000n && BigInt(t.meta.computeUnitsConsumed ?? 0) <= BigInt(lim), JSON.stringify({ lim, price: String(price), used: t?.meta?.computeUnitsConsumed, fee: t?.meta?.fee })); }
    { const sf = await call(other.url, 'GET', `/v1/tokens/${mint}/safety`), j = sf.j;
      check('S13 the buy passed the token safety check: the pump.fun token has both authorities revoked, a sell route, and its bonding curve is not counted as a holder', sf.status === 200 && j.verdict !== 'block' && j.facts.sellRoute === true && j.facts.mintAuthority === null && j.facts.freezeAuthority === null && j.facts.excludedHolders.length === 2, JSON.stringify({ status: sf.status, verdict: j.verdict, risks: j.risks?.map((r: any) => r.code), facts: j.facts }).slice(0, 400)); }
    check('S3 the same idempotency key again does not trade twice', (await cl(other.url).swap({ side: 'buy', mint, sol: '0.02', slippagePct: 5, key: 'fork-buy-1' })).key === tr.key && fp.state.signed === 1, String(fp.state.signed));
    check('S4 a buy above the per-trade cap (0.05 SOL) is refused by the policy signer', /per-tx limit/.test(JSON.stringify((await call(other.url, 'POST', '/v1/trades/buy', { walletId: addr, token: mint, amount: '60000000', slippageBps: 500 })).j)));
    // a standing order that cannot fire yet; then the owner crashes
    const ord = { status: 200, j: await cl(other.url).placeOrder({ type: 'limit-buy', id: 'dip-1', mint, sol: '0.01', price: '0.000000000000000001', slippagePct: 5 }) };
    check('S5 a limit buy is placed and waits', ord.status === 200 && ord.j.status === 'active', JSON.stringify(ord.j).slice(0, 200));
    const ownerNode = nodes.find(x => x.url === owner)!; await ownerNode.nd.crash(); nodes.splice(nodes.indexOf(ownerNode), 1);
    let w: any; for (let i = 0; i < 30; i++) { await sleep(500); w = await call(other.url, 'GET', '/v1/wallet'); if (w.status === 200 && w.node === other.url) break; }
    check('S6 after the owner crashes, the other node takes the user over, asks Privy again and is active', w?.node === other.url && w.j.active === true, JSON.stringify(w?.j));
    const signedBefore = fp.state.signed, t1 = await tokens();
    const ed = await call(other.url, 'PATCH', `/v1/orders/${ord.j.id}`, { priceE18: (10n ** 30n).toString() });
    for (let i = 0; i < 40 && (await tokens()) === t1; i++) await sleep(500);
    const o2 = await call(other.url, 'GET', `/v1/orders/${ord.j.id}`);
    check('S7 the restored order, edited on the new owner, fires by itself, Privy signs it and the tokens arrive', ed.status === 200 && fp.state.signed > signedBefore && (await tokens()) > t1 && o2.j.status === 'fired', JSON.stringify(o2.j).slice(0, 240));
    const h0 = await tokens(), sl = await cl(other.url).swap({ side: 'sell', mint, pct: 50, slippagePct: 10, key: 'fork-sell-half' });
    let sv: any = sl; for (let i = 0; i < 40 && !['finalized', 'failed', 'expired'].includes(sv.state); i++) { await sleep(1000); sv = (await call(other.url, 'POST', '/v1/trades/alice.fork-sell-half/advance')).j; }
    const h1 = await tokens(); check('S8 a sell of half the holding in plain units (pct: 50) lands and leaves about half', sv.state !== 'failed' && h1 < h0 && h1 >= h0 / 2n - 1n && h1 <= h0 / 2n + 1n, JSON.stringify({ state: sv.state, before: String(h0), after: String(h1), failure: sv.failure }));
    // MEV protection on: the next buy goes privately to the (stand-in) block engine with a tip and the jitodontfront flag, and still lands
    { const ta = await rpc.call<string>('requestAirdrop', [tipAcct, 1_000_000_000]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[ta]]); if (s.value[0]?.confirmationStatus) break; await sleep(250); }
      const on = await cl(other.url).updateSettings({ mevProtection: true }), t4 = await tokens(), mb = await cl(other.url).swap({ side: 'buy', mint, sol: '0.01', slippagePct: 5, key: 'fork-mev-1' });
      let mv: any = mb; for (let i = 0; i < 40 && !['finalized', 'failed', 'expired'].includes(mv.state); i++) { await sleep(1000); mv = (await call(other.url, 'POST', '/v1/trades/alice.fork-mev-1/advance')).j; }
      const sent = jitoSeen.filter(x => x.method === 'sendTransaction'), lt2: any = mv.txHash ? await rpc.call('getTransaction', [mv.txHash, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) : null, keys: string[] = lt2?.transaction?.message?.accountKeys ?? [];
      const ti = keys.indexOf(tipAcct), tipPaid = ti >= 0 ? lt2.meta.postBalances[ti] - lt2.meta.preBalances[ti] : 0;
      check('S11 with MEV protection on, the buy is sent privately (sendTransaction?bundleOnly=true) with a 10,000-lamport tip from the tip floor and the jitodontfront flag, and lands', on.mevProtection === true && sent.length === 1 && /bundleOnly=true/.test(sent[0].url) && tipPaid === 10_000 && keys.includes('jitodontfront111111111111111111111111111111') && mv.state !== 'failed' && (await tokens()) > t4, JSON.stringify({ state: mv.state, sends: sent.length, tipPaid, flag: keys.includes('jitodontfront111111111111111111111111111111'), failure: mv.failure }));
      // per trade: the setting is off now, so a plain buy goes publicly and a buy with mevProtection: true goes privately
      const before = jitoSeen.filter(x => x.method === 'sendTransaction').length;
      await cl(other.url).updateSettings({ mevProtection: false }); const pb = await cl(other.url).swap({ side: 'buy', mint, sol: '0.005', slippagePct: 5, key: 'fork-pub-1' });
      const settle = async (k: string, v: any) => { for (let i = 0; i < 40 && !['finalized', 'failed', 'expired'].includes(v.state); i++) { await sleep(1000); v = (await call(other.url, 'POST', `/v1/trades/alice.${k}/advance`)).j; } return v; };
      const pbF = await settle('fork-pub-1', pb);   // let it land first: both buys move the same curve, and a buy priced before the other lands can exceed its slippage
      const afterPublic = jitoSeen.filter(x => x.method === 'sendTransaction').length, xb = await cl(other.url).swap({ side: 'buy', mint, sol: '0.005', slippagePct: 5, key: 'fork-mev-2', mevProtection: true });
      const afterPrivate = jitoSeen.filter(x => x.method === 'sendTransaction').length;
      const xbF = await settle('fork-mev-2', xb);
      check('S12 per trade: with the setting off a buy goes publicly, and one with mevProtection: true goes privately', afterPublic === before && afterPrivate === before + 1 && pbF.state === 'finalized' && xbF.state === 'finalized', JSON.stringify({ before, afterPublic, afterPrivate, pub: pbF.state, priv: xbF.state, f2: xbF.failure, h2: (xbF.history ?? []).map((h: any) => h.state + (h.note ? ":" + String(h.note).slice(0, 120) : "")) })); }
    // revoked in Privy: nothing is signed, nothing is sent
    fp.state.delegated = false; const t2 = await tokens(), sb = fp.state.signed;
    const rb = await call(other.url, 'POST', '/v1/trades/buy', { walletId: addr, token: mint, amount: '10000000', slippageBps: 500, key: 'fork-buy-revoked' });
    await sleep(3000);
    const t3 = await tokens(); check('S9 after the user revokes the signer in Privy, a buy fails with nothing sent', rb.j.state === 'failed' && fp.state.signed === sb && t3 === t2 && !(rb.j.history ?? []).some((h: any) => h.state === 'submitted'), JSON.stringify({ state: rb.j.state, signed: fp.state.signed - sb, tokens: String(t3 - t2), sent: (rb.j.history ?? []).some((h: any) => h.state === 'submitted'), failure: rb.j.failure }));
    const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-server-sol.md`;
    writeFileSync(file, ['# Execution server, MODE=solana-mainnet, on a local validator', '', `Run: ${new Date().toISOString()}`, 'Two nodes, local Redis, solana-test-validator with pump.fun and one live curve cloned, Privy stand-in. NOT mainnet. Fake SOL, throwaway key.',
      `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length} of ${checks.length})`, '', ...checks.map(c => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.pass ? '' : ` (${c.detail.replace(/[A-Za-z0-9_-]{40,}/g, '***')})`}`), '',
      '## Not covered', '- Real Privy (the stand-in applies the README policy the way Privy documents it). Jupiter routes (they point at mainnet accounts the clone does not have). Mainnet.'].join('\n'));
    console.log(`\nreport: ${file}`); process.exitCode = pass ? 0 : 1;
  } finally { for (const x of nodes) await x.nd.drain().catch(() => {}); const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${ns}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); } env.stop(); }
}
main().catch(e => { console.error(String((e as Error).stack ?? e).replace(/[A-Za-z0-9_-]{24,}/g, m => m.length > 40 ? '***' : m)); process.exit(1); });
