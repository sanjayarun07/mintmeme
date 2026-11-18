/** ONE EXECUTION SERVER, FOUR CHAINS, ONE KEY, END TO END ON LOCAL FORKS. Two real nodes share the local Redis and serve CHAINS=solana,base,bnb,robinhood (the same
 *  createNode chains wiring main.ts builds), so one user links a wallet per chain and trades all four through the same nodes and the same API key:
 *    Solana     solana-test-validator with the pump.fun program and one live curve cloned (packages/live/src/pumpenv.ts)
 *    Base       anvil forked from Base mainnet, Uniswap V2 (KEYCAT)
 *    BNB Chain  anvil forked from BNB mainnet, PancakeSwap V2 (USDT, the deepest WBNB pool)
 *    Robinhood  anvil forked from Robinhood Chain mainnet, Uniswap V2 (USDG, Paxos's dollar)
 *  Privy is the local stand-ins (same request signing; one EVM key, one policy per chain with its own chain id, router and cap). Fake funds, throwaway keys, nothing
 *  reaches any mainnet. usage: npm run verify:server-multi (needs ALCHEMY_API_KEY with Base, BNB and Robinhood enabled, anvil, solana-test-validator and Redis). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { startFork } from './forkenv.ts';
import { startPumpValidator } from './pumpenv.ts';
import { SolJsonRpc, DevSolSigner } from '../../sol/src/index.ts';
import { SyncRedis } from '../../core/src/index.ts';
import { fakePrivy } from '../../sol/test/fakeprivy.ts';
import { fakePrivyEvm } from '../../evm/test/fakeprivyevm.ts';
import { personalSign } from '../../evm/test/ecdsa.ts';
import { erc20 } from '../../evm/src/index.ts';
import { createNode } from '../../../apps/server/node.ts';
import type { ChainAccounts } from '../../../apps/server/node.ts';
import { solanaAccounts, linkRoutes } from '../../../apps/server/solaccount.ts';
import { baseAccounts, baseLinkRoutes, walletState } from '../../../apps/server/baseaccount.ts';
import { EVM_NETWORKS } from '../../sdk/src/base.ts';
import { MemeClient } from '../../sdk/src/client.ts';

const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const EVM = [
  { id: 'base', port: 8681, net: 'base-mainnet', token: '0x9a26f5433671751c3276a065f57e5a02d2817973', sym: 'KEYCAT', buy: '0.002', cap: 10n ** 16n, over: '0.02' },
  { id: 'bnb', port: 8682, net: 'bnb-mainnet', token: '0x55d398326f99059ff775485246999027b3197955', sym: 'USDT', buy: '0.005', cap: 2n * 10n ** 16n, over: '0.03' },
  { id: 'robinhood', port: 8683, net: 'robinhood-mainnet', token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', sym: 'USDG', buy: '0.002', cap: 10n ** 16n, over: '0.02' },
] as const;

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const redactAll: ((s: string) => string)[] = [], red = (s: string) => redactAll.reduce((x, f) => f(x), s.split(key).join('***'));
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: red(detail) }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + red(detail).slice(0, 400)}`); };
  const stops: (() => void)[] = [];
  // the chains: three anvil forks and a validator (a pump.fun curve is picked from live mainnet traffic; retried, it is sometimes briefly missing)
  const forks = await Promise.all(EVM.map(c => startFork(key, c.port, `https://${c.net}.g.alchemy.com/v2/${key}`)));
  forks.forEach(f => { stops.push(f.stop); redactAll.push(f.redact); });
  let sol: Awaited<ReturnType<typeof startPumpValidator>> | undefined, solErr = '';
  for (let i = 0; i < 3 && !sol; i++) { try { sol = await startPumpValidator(key, 8994); } catch (e) { solErr = (e as Error).message; await sleep(5000); } }
  if (sol) stops.push(sol.stop);
  const ns = `memedesk-servermulti:${Date.now()}`, API_KEY = 'multi-fork-key-0123456789abcdef', keys = [{ keyHash: createHash('sha256').update(API_KEY).digest('hex'), userId: 'mia' }];
  // Privy stand-ins: one Solana wallet; one Ethereum key whose Privy wallet carries one policy per chain (chain id, that chain's V2 router, that chain's cap)
  const seed = randomBytes(32), sw = new DevSolSigner(), solAddr = sw.add(seed), fps = fakePrivy({ seed });
  const fpb = fakePrivyEvm({ policyId: 'policy-base' }), evmKey = fpb.key;
  const fpe = [fpb, ...EVM.slice(1).map(c => fakePrivyEvm({ key: evmKey, policyId: `policy-${c.id}`, chainId: EVM_NETWORKS[c.id].chainId, router: EVM_NETWORKS[c.id].router, capWei: c.cap }))];
  const srv = await Promise.all(fpe.map(f => f.listen())); srv.forEach(s => stops.push(() => s.close()));
  const evmAddr = evmKey.address;
  const chains: ChainAccounts[] = [];
  if (sol) { const sa = solanaAccounts({ rpcUrl: sol.url, privy: { ...fps.cfg, fetchFn: fps.fetchFn }, venues: ['pump'], solUsd: async () => ({ price: 150, at: Date.now() }) });
    chains.push({ id: 'solana', makeAccount: sa.make, extraRoutes: h => linkRoutes({ privy: sa.privy, status: sa.status, safety: sa.safety, ...h }), legacyMarks: ['solwallet'] }); }
  EVM.forEach((c, i) => { const acc = baseAccounts({ rpcUrl: forks[i].node.url, privy: { ...fpe[i].cfg, apiUrl: srv[i].url }, relay: c.id === 'robinhood' ? undefined : false, aggregator: c.id === 'robinhood' ? 'kyberswap' : undefined, network: c.id, caps: { maxTradeWei: c.cap, dailyCapWei: c.cap * 5n } });
    chains.push({ id: c.id, makeAccount: acc.make, extraRoutes: h => baseLinkRoutes({ privy: acc.privy, status: acc.status, chain: c.id, ...h }), legacyMarks: [walletState(c.id)] }); });
  const nodes: { nd: Awaited<ReturnType<typeof createNode>>; url: string }[] = [];
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`; const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns, publicUrl: url, keys, chains, leaseTtlMs: 3000, sweepMs: 1000, requireAof: false, log: () => {} }); await nd.listen(port); const x = { nd, url }; nodes.push(x); return x; };
  const call = async (base: string, method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any, node: r.headers.get('x-memedesk-node') }; };
  const bal = async (i: number) => { const q = erc20.balanceOf(EVM[i].token, evmAddr); return erc20.decodeUint(await forks[i].node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
  const native = async (i: number) => BigInt(await forks[i].node.call<string>('eth_getBalance', [evmAddr, 'latest']));
  /** Drive an EVM trade to an end state: advance, mining blocks so it reaches that chain's finality depth. */
  const runEvm = async (base: string, i: number, path: string, body: any) => {
    const r = await call(base, 'POST', `/v1/${EVM[i].id}${path}`, body); if (r.status !== 200) return { status: r.status, t: r.j };
    let t = r.j; for (let k = 0; k < 40 && !['finalized', 'failed', 'expired'].includes(t.state); k++) { await forks[i].node.call('anvil_mine', ['0x3']); t = (await call(base, 'POST', `/v1/${EVM[i].id}/trades/${encodeURIComponent(t.key)}/advance`)).j; }
    return { status: 200, t };
  };
  const sent = (t: any) => (t?.history ?? []).some((x: any) => x.state === 'submitted');
  check('M0 Solana validator with a live pump.fun curve started', !!sol, solErr);
  try {
    for (let i = 0; i < EVM.length; i++) await forks[i].node.call('anvil_setBalance', [evmAddr, '0x' + (5n * 10n ** 16n).toString(16)]);   // 0.05 fake ETH / BNB
    if (sol) { const air = await sol.rpc.call<string>('requestAirdrop', [solAddr, 2_000_000_000]); for (let i = 0; i < 80; i++) { const s: any = await sol.rpc.call('getSignaturesForAddress', [solAddr, { limit: 1 }]).catch(() => []); if (s.length) break; await sleep(250); } void air; }
    const a = await mk(), b = await mk();
    const list = await (await fetch(a.url + '/v1/chains')).json() as any;
    check('M1 one node lists every chain, the first (default) answers the old paths', JSON.stringify(list.chains.map((c: any) => c.id)) === JSON.stringify(chains.map(c => c.id)) && list.default === chains[0].id, JSON.stringify(list));
    // link each chain's wallet through node b (forwarded to the owner when a owns the user)
    const linked: Record<string, any> = {};
    for (const [i, c] of EVM.entries()) { const st = await call(b.url, 'POST', `/v1/${c.id}/wallet/link/start`, { address: evmAddr });
      linked[c.id] = await call(b.url, 'POST', `/v1/${c.id}/wallet/link/finish`, { address: evmAddr, signature: personalSign(evmKey, st.j.message) }); void i; }
    if (sol) { const st = await call(b.url, 'POST', '/v1/solana/wallet/link/start', { address: solAddr });
      linked.solana = await call(b.url, 'POST', '/v1/solana/wallet/link/finish', { address: solAddr, signature: Buffer.from(sw.sign(solAddr, new TextEncoder().encode(st.j.message))).toString('base64') }); }
    check('M2 the same API key links a wallet on every chain, each checked against that chain\'s Privy policy', Object.values(linked).every((x: any) => x.status === 200 && x.j.active === true), JSON.stringify(Object.fromEntries(Object.entries(linked).map(([k, v]: any) => [k, v.j]))).slice(0, 600));
    const r = new SyncRedis(); let keysOk = false; try { keysOk = EVM.every(c => Number(r.cmd('EXISTS', `${ns}:u:mia:${chains[0].id === c.id ? '' : '@' + c.id + ':'}${walletState(c.id)}`)) === 1) && (!sol || Number(r.cmd('EXISTS', `${ns}:u:mia:solwallet`)) === 1); } finally { r.close(); }
    check('M3 each link is stored under its own chain (the default chain unprefixed)', keysOk);
    const owner = (await call(a.url, 'GET', '/v1/overview')).node!, other = owner === a.url ? b.url : a.url;

    // a buy on every EVM chain through the node that does NOT own the user, with the same idempotency key on each (no clash between chains)
    const bought: Record<string, { t: any; before: bigint; after: bigint; spent: bigint }> = {};
    for (const [i, c] of EVM.entries()) { const t0 = await bal(i), n0 = await native(i), r1 = await runEvm(other, i, '/trades/buy', { token: c.token, eth: c.id === 'bnb' ? undefined : c.buy, bnb: c.id === 'bnb' ? c.buy : undefined, slippagePct: 3, key: 'same-key' });
      bought[c.id] = { t: r1.t, before: t0, after: await bal(i), spent: n0 - await native(i) };
      const amt = BigInt(Math.round(Number(c.buy) * 1e6)) * 10n ** 12n;
      check(`M4 ${c.id}: buy ${c.buy} ${EVM_NETWORKS[c.id].native} of ${c.sym} on ${EVM_NETWORKS[c.id].dex} through the non-owner node: finalized, tokens arrived, about the amount + gas spent`,
        r1.t.state === 'finalized' && bought[c.id].after > t0 && bought[c.id].spent >= amt && bought[c.id].spent < amt * 3n / 2n, `${r1.t.state} ${r1.t.failure ?? JSON.stringify(r1.t).slice(0, 300)} tokens ${t0}->${bought[c.id].after} spent ${bought[c.id].spent}`); }
    const tks = EVM.map(c => bought[c.id].t.key);
    check('M5 the same idempotency key on three chains made three trades, each on its own chain (keys do not clash across chains)', tks.every(k => k === tks[0]) && EVM.every(c => bought[c.id].t.state === 'finalized'), JSON.stringify(tks));
    { const q = await call(other, 'POST', '/v1/bnb/quote', { side: 'buy', token: EVM[1].token, bnb: '0.001' }), n = EVM_NETWORKS.bnb, w = (x: string) => x.slice(2).padStart(64, '0');
      // PancakeSwap's own router: getAmountsOut(0.001 BNB, [WBNB, USDT]) at the same block
      const ro = await forks[1].node.call<string>('eth_call', [{ to: n.router, data: '0xd06ca61f' + (10n ** 15n).toString(16).padStart(64, '0') + w('0x40') + w('0x2') + w(n.weth) + w(EVM[1].token) }, 'latest']), want = BigInt('0x' + ro.slice(-64));
      check('M6 a BNB quote equals PancakeSwap\'s own router getAmountsOut (0.25% pool fee, not Uniswap\'s 0.3%)', q.status === 200 && BigInt(q.j.amountOut) === want, `${JSON.stringify(q.j).slice(0, 200)} router ${want}`); }
    if (sol) { const cl = new MemeClient({ baseUrl: other, apiKey: API_KEY, chain: 'solana', timeoutMs: 120_000 });
      let tr: any = await cl.swap({ side: 'buy', mint: sol.mint, sol: '0.02', slippagePct: 5, key: 'same-key' }).catch(e => ({ state: 'failed', failure: (e as Error).message }));
      for (let i = 0; i < 40 && !['finalized', 'failed', 'expired'].includes(tr.state); i++) { await sleep(1000); tr = (await call(other, 'POST', `/v1/solana/trades/${encodeURIComponent(tr.key)}/advance`)).j; }
      check('M7 solana: a pump.fun buy (0.02 SOL) through the same nodes and key, with the same idempotency key, lands', ['confirmed', 'finalized'].includes(tr.state) && fps.state.signed >= 1, JSON.stringify(tr).slice(0, 300)); }
    // caps are per chain: above BNB's cap is refused before signing; Base's own cap is unaffected
    { const signed = fpe[1].state.signed, c1 = await runEvm(other, 1, '/trades/buy', { token: EVM[1].token, bnb: EVM[1].over, key: 'over-cap' });
      check('M8 a BNB buy above the BNB cap fails before signing: nothing sent', c1.t.state === 'failed' && !sent(c1.t) && fpe[1].state.signed === signed, `${c1.t.state} ${c1.t.failure ?? JSON.stringify(c1.t).slice(0, 200)}`); }

    // the owner crashes: the other node takes the user over with every chain's wallet
    const o = nodes.find(x => x.url === owner)!; await o.nd.crash(); nodes.splice(nodes.indexOf(o), 1);
    let views: any[] = []; for (let i = 0; i < 40; i++) { await sleep(500); views = await Promise.all(chains.map(c => call(other, 'GET', `/v1/${c.id}/wallet`))); if (views.every(v => v.status === 200 && v.node === other)) break; }
    check('M9 after the owner crashes, the other node runs the user on every chain, every wallet linked and active again', views.every(v => v.node === other && v.j.linked && v.j.active), JSON.stringify(views.map(v => [v.status, v.node === other, v.j.linked, v.j.active])));
    // sells after failover: exact approval + swap on each EVM chain, tokens back to zero, native back
    for (const [i, c] of EVM.entries()) { const signed = fpe[i].state.signed, n0 = await native(i), s1 = await runEvm(other, i, '/trades/sell', { token: c.token, pct: 100, slippagePct: 5, key: 'sell-all' });
      check(`M10 ${c.id}: sell 100% of ${c.sym} on the new owner: approval + swap signed, tokens gone, ${EVM_NETWORKS[c.id].native} back`, s1.t.state === 'finalized' && (await bal(i)) === bought[c.id].before && (await native(i)) > n0 && fpe[i].state.signed - signed === 2,
        `${s1.t.state} ${s1.t.failure ?? ''} signed ${fpe[i].state.signed - signed} tokens ${await bal(i)}`); }
    // unlinking one chain leaves the others trading
    await call(other, 'DELETE', '/v1/bnb/wallet');
    const nb = await call(other, 'POST', '/v1/bnb/trades/buy', { token: EVM[1].token, bnb: '0.001', key: 'after-unlink' }), rb = await runEvm(other, 2, '/trades/buy', { token: EVM[2].token, eth: '0.001', slippagePct: 3, key: 'after-unlink' });
    check('M11 unlinking BNB refuses BNB trades (wallet_not_active) and leaves Robinhood trading', nb.j.error?.code === 'wallet_not_active' && rb.t.state === 'finalized', `${JSON.stringify(nb.j).slice(0, 200)} ${rb.t.state} ${rb.t.failure ?? ''}`);
    // Robinhood's own stock tokens have no usable V2 pool: KyberSwap (the chain's default aggregator) routes them. Its quotes are LIVE mainnet state while this fork is
    // frozen at its start block, so a route can revert here (the simulation then refuses it and nothing is sent): up to three attempts, each a new trade key.
    { const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d', KR = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
      const tb = async () => { const q = erc20.balanceOf(TSLA, evmAddr); return erc20.decodeUint(await forks[2].node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
      const tries = async (path: string, body: any) => { let x: any; for (let k = 1; k <= 3; k++) { x = await runEvm(other, 2, path, { ...body, key: `${body.key}-${k}` }); if (x.t.state === 'finalized' || !/simulation|KyberSwap/.test(x.t.failure ?? '')) break; await sleep(3000); } return x; };
      const t0 = await tb(), kb = await tries('/trades/buy', { token: TSLA, eth: '0.002', slippagePct: 3, key: 'kyber-tsla' }), t1 = await tb();
      const btx: any = kb.t.txHash ? await forks[2].node.call('eth_getTransactionByHash', [kb.t.txHash]) : null;
      check('M12 robinhood: buy 0.002 ETH of Robinhood\'s TSLA (no usable V2 pool) through KyberSwap\'s router, gated and simulated, finalized, tokens arrived',
        kb.t.state === 'finalized' && t1 > t0 && String(btx?.to).toLowerCase() === KR && String(kb.t.venue ?? '').startsWith('kyber:'), `${kb.t.state} ${kb.t.failure ?? ''} venue ${kb.t.venue} to ${btx?.to} tokens ${t0}->${t1}`);
      const signed = fpe[2].state.signed, n0 = await native(2), ks = await tries('/trades/sell', { token: TSLA, pct: 100, slippagePct: 5, key: 'kyber-tsla-sell' });
      const stx: any = ks.t.txHash ? await forks[2].node.call('eth_getTransactionByHash', [ks.t.txHash]) : null;
      check('M13 robinhood: sell 100% of that TSLA through KyberSwap: exact approval of the router + swap signed, tokens gone, ETH back',
        ks.t.state === 'finalized' && (await tb()) === t0 && (await native(2)) > n0 && String(stx?.to).toLowerCase() === KR && fpe[2].state.signed - signed >= 1, `${ks.t.state} ${ks.t.failure ?? ''} venue ${ks.t.venue} to ${stx?.to} signed ${fpe[2].state.signed - signed}`); }
  } catch (e) { check('run', false, (e as Error).stack ?? String(e)); }
  finally { for (const x of nodes) await x.nd.drain().catch(() => {}); const c = new SyncRedis(); try { for (const k of (c.cmd('KEYS', `${ns}:*`) ?? []) as string[]) c.cmd('DEL', k); } finally { c.close(); } for (const s of stops) try { s(); } catch { /* stopping */ } }
  const pass = checks.every(c => c.pass);
  const text = ['# Execution server, CHAINS=solana,base,bnb,robinhood, on local forks', '', `Run: ${new Date().toISOString()}`,
    'Two nodes, local Redis, one API key. Solana: solana-test-validator with pump.fun and one live curve cloned. Base, BNB Chain, Robinhood Chain: anvil forks of mainnet. Privy stand-ins (one policy per chain). NOT mainnet. Fake funds, throwaway keys.', '',
    `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '', ...checks.map(c => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.pass ? '' : ` (${c.detail.slice(0, 300)})`}`), '',
    '## Not covered', '- Real Privy (its policy engine) and real chains: a tiny mainnet trade per chain, approved by the user, covers them.', '- Relay and KyberSwap on BNB; Relay on Robinhood (KyberSwap on Robinhood is covered: M12, M13): those chains trade on their V2 pools only.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-server-multi.md`; writeFileSync(file, text + '\n');
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: ${checks.filter(c => c.pass).length}/${checks.length}. Report: ${file}`); process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(String((e as Error).stack ?? e).split(process.env.ALCHEMY_API_KEY || '\u0000').join('***')); process.exit(1); });
