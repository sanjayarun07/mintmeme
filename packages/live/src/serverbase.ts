/** THE EXECUTION SERVER IN MODE=base-mainnet, END TO END ON A LOCAL BASE FORK. A real node (Redis on 127.0.0.1:6379) runs the same account code as production
 *  (apps/server/baseaccount.ts); the chain is a loopback anvil forked from Base mainnet; Privy is the local stand-in (packages/evm/test/fakeprivyevm.ts: same request
 *  signing, the README's Base policy, signs with a throwaway key). Fake ETH, throwaway key, nothing reaches mainnet. The token is KEYCAT, one of the few Base memecoins
 *  with a deep Uniswap V2 WETH pool. usage: npm run verify:server-base (needs ALCHEMY_API_KEY with Base enabled, or BASE_RPC_URL, plus Foundry's anvil and Redis). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { startFork } from './forkenv.ts';
import { fakePrivyEvm, RELAY_ROUTER, RELAY_PROXY } from '../../evm/test/fakeprivyevm.ts';
import { testKey, personalSign } from '../../evm/test/ecdsa.ts';
import { erc20 } from '../../evm/src/index.ts';
import { createNode } from '../../../apps/server/node.ts';
import { baseAccounts, baseLinkRoutes } from '../../../apps/server/baseaccount.ts';

const V2_ROUTER = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', KEYCAT = '0x9a26f5433671751c3276a065f57e5a02d2817973', ZORA = '0x1111111111166b7fe7bd91427724b487980afc69', PORT = 8671;
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
async function main() {
  const key = process.env.ALCHEMY_API_KEY ?? '', upstream = process.env.BASE_RPC_URL || (key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : '');
  if (!upstream) { console.error('Set ALCHEMY_API_KEY (with Base enabled) or BASE_RPC_URL.'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const fork = await startFork(key || 'no-key', PORT, upstream), node = fork.node, red = fork.redact;
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: red(detail) }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + red(detail).slice(0, 400)}`); };
  const fp = fakePrivyEvm(), privySrv = await fp.listen(), addr = fp.address;
  const API_KEY = 'base-fork-key-0123456789abcdef', keys = [{ keyHash: createHash('sha256').update(API_KEY).digest('hex'), userId: 'bea' }], ns = `memedesk-serverbase:${Date.now()}`;
  const acc = baseAccounts({ rpcUrl: node.url, privy: { ...fp.cfg, apiUrl: privySrv.url } });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns, publicUrl: url, keys, makeAccount: acc.make, extraRoutes: h => baseLinkRoutes({ privy: acc.privy, status: acc.status, ...h }), leaseTtlMs: 3000, sweepMs: 1000, requireAof: false, log: () => {} });
  await nd.listen(port);
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(url + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any }; };
  const eth = async () => BigInt(await node.call<string>('eth_getBalance', [addr, 'latest']));
  const keycat = async () => { const q = erc20.balanceOf(KEYCAT, addr); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
  /** Drive a trade to an end state: advance, and mine blocks so it reaches the finality depth (anvil mines one block per transaction otherwise). */
  const run = async (path: string, body: any) => {
    const r = await call('POST', path, body); if (r.status !== 200) return { status: r.status, t: r.j };
    let t = r.j; for (let i = 0; i < 30 && !['finalized', 'failed', 'expired'].includes(t.state); i++) { await node.call('anvil_mine', ['0x2']); t = (await call('POST', `/v1/trades/${encodeURIComponent(t.key)}/advance`)).j; }
    return { status: 200, t };
  };
  const sent = (t: any) => (t?.history ?? []).some((x: any) => x.state === 'submitted');
  try {
    await node.call('anvil_setBalance', [addr, '0x' + (5n * 10n ** 16n).toString(16)]);   // 0.05 fake ETH
    const w0 = await call('GET', '/v1/wallet');
    check('B1 before linking: no wallet, the account explains how to link', w0.status === 200 && w0.j.linked === false && /link/i.test(w0.j.why ?? ''), JSON.stringify(w0.j));
    const r0 = await call('POST', '/v1/trades/buy', { token: KEYCAT, eth: '0.001', key: 'b0' });
    check('B2 a buy before linking is refused (wallet_not_active), nothing signed', r0.status === 409 && r0.j.error?.code === 'wallet_not_active' && fp.state.signed === 0, JSON.stringify(r0.j));
    // linking: a signature from another key is refused; the wallet's own personal_sign links it
    let st = await call('POST', '/v1/wallet/link/start', { address: addr });
    const bad = await call('POST', '/v1/wallet/link/finish', { address: addr, signature: personalSign(testKey(), st.j.message) });
    check('B3 linking with a signature from another key is refused', bad.status === 401 && bad.j.error?.code === 'bad_signature', JSON.stringify(bad.j));
    st = await call('POST', '/v1/wallet/link/start', { address: addr });
    const ln = await call('POST', '/v1/wallet/link/finish', { address: addr, signature: personalSign(fp.key, st.j.message) });
    check('B4 linking with the wallet\'s personal_sign activates the account', ln.status === 200 && ln.j.active === true && ln.j.chain === 'base', JSON.stringify(ln.j));
    // a market buy in plain units: the token's V2 pool is found, Privy signs within the policy, the node sends, the engine confirms
    const e1 = await eth(), k1 = await keycat(), b1 = await run('/v1/trades/buy', { token: KEYCAT, eth: '0.002', slippagePct: 3, key: 'b1' });
    const k2 = await keycat(), e2 = await eth();
    check('B5 buy 0.002 ETH of KEYCAT: finalized, tokens arrived, about 0.002 ETH + gas left the wallet', b1.t.state === 'finalized' && k2 > k1 && e1 - e2 >= 2n * 10n ** 15n && e1 - e2 < 3n * 10n ** 15n, `${b1.t.state} ${b1.t.failure ?? ''} tokens ${k1}->${k2} eth spent ${e1 - e2}`);
    check('B6 the signed transaction Privy returned was checked and sent as is (hash on chain)', !!b1.t.txHash && !!(await node.call('eth_getTransactionReceipt', [b1.t.txHash])), String(b1.t.txHash));
    // sell everything: the exact-amount approval goes first (allowed by the policy: approve(router)), then the swap
    const signedBefore = fp.state.signed, s1 = await run('/v1/trades/sell', { token: KEYCAT, pct: 100, slippagePct: 5, key: 's1' }), e3 = await eth();
    check('B7 sell 100%: approval + swap both signed by Privy, tokens gone, ETH back', s1.t.state === 'finalized' && (await keycat()) === 0n && e3 > e2 && fp.state.signed - signedBefore === 2, `${s1.t.state} ${s1.t.failure ?? ''} signed ${fp.state.signed - signedBefore} eth ${e2}->${e3}`);
    // a token whose V2 pool is dust (ZORA: about 0.003 WETH there, liquid on V3/V4): Relay venues are added next to it and win; the swap goes to Relay's router,
    // gated (pinned contracts, reviewed inner swap, on-chain minimum) and simulated with eth_simulateV1 on this fork before Privy is asked
    const zora = async () => { const q = erc20.balanceOf(ZORA, addr); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
    // Relay quotes LIVE mainnet state while this fork is frozen at its start block, so a route can revert here ("inactive pair"): the simulation then refuses it and
    // nothing is sent. Relay also varies its inner route between quotes, and the gate refuses one through a contract it has not reviewed (fail closed; nothing is
    // sent either). A fresh quote may pick another route, so up to five attempts (each a new trade key).
    const relayRun = async (path: string, body: any) => { let r: any; for (let i = 1; i <= 5; i++) { r = await run(path, { ...body, key: `${body.key}-${i}` }); if (r.t.state === 'finalized' || !/simulation|Relay quote|not reviewed|the route approves/.test(r.t.failure ?? '')) break; await new Promise(ok => setTimeout(ok, 3000)); } return r; };
    const z1 = await zora(), rb = await relayRun('/v1/trades/buy', { token: ZORA, eth: '0.002', slippagePct: 3, key: 'rb1' }), z2 = await zora();
    const rtx: any = rb.t.txHash ? await node.call('eth_getTransactionByHash', [rb.t.txHash]) : null;
    check('B14 buy 0.002 ETH of ZORA (dust V2 pool): routed through Relay\'s router, gated and simulated, finalized, tokens arrived', rb.t.state === 'finalized' && z2 > z1 && String(rtx?.to).toLowerCase() === RELAY_ROUTER, `${rb.t.state} ${rb.t.failure ?? ''} to ${rtx?.to} tokens ${z1}->${z2}`);
    const signedR = fp.state.signed, eR = await eth(), rs = await relayRun('/v1/trades/sell', { token: ZORA, pct: 100, slippagePct: 5, key: 'rs1' }), eR2 = await eth();
    const stx: any = rs.t.txHash ? await node.call('eth_getTransactionByHash', [rs.t.txHash]) : null;
    // The router takes the best quote of the token's venues: usually Relay, but at times the dust V2 pool quotes this small sell better, and then using it is right.
    // Either way the sell must finalize with an exact approval + swap signed by Privy, tokens gone and ETH back, sent to that venue's contract. (The Relay sell path
    // itself is also covered in packages/evm/test/relay.test.ts.)
    const viaRelay = String(rs.t.venue ?? '').startsWith('relay'), wantTo = viaRelay ? RELAY_PROXY : V2_ROUTER;
    check(`B15 sell 100% of ZORA (best venue: ${viaRelay ? 'Relay, through its approval proxy' : 'Uniswap V2, it quoted better'}): exact approval + swap signed by Privy, tokens gone, ETH back`, rs.t.state === 'finalized' && (await zora()) === 0n && eR2 > eR && fp.state.signed - signedR === 2 && String(stx?.to).toLowerCase() === wantTo, `${rs.t.state} ${rs.t.failure ?? ''} venue ${rs.t.venue} to ${stx?.to} signed ${fp.state.signed - signedR} eth ${eR}->${eR2}`);
    // the per-trade cap (0.01 ETH by default) is checked before Privy is asked
    const signedCap = fp.state.signed, c1 = await run('/v1/trades/buy', { token: KEYCAT, eth: '0.02', key: 'c1' });
    check('B8 a buy above the per-trade cap fails before signing: nothing sent', c1.t.state === 'failed' && !sent(c1.t) && fp.state.signed === signedCap, `${c1.t.state} ${c1.t.failure ?? JSON.stringify(c1.t)}`);
    // a signing service that changes the transaction, or signs with another key: refused, nothing sent
    fp.state.mode = 'tamper'; const tm = await run('/v1/trades/buy', { token: KEYCAT, eth: '0.001', key: 't1' });
    check('B9 Privy returns a changed transaction: refused, nothing sent', tm.t.state === 'failed' && !sent(tm.t) && /different transaction/.test(tm.t.failure ?? ''), `${tm.t.state} ${tm.t.failure}`);
    fp.state.mode = 'wrong-key'; const wk = await run('/v1/trades/buy', { token: KEYCAT, eth: '0.001', key: 't2' });
    check('B10 Privy signs with another key: refused, nothing sent', wk.t.state === 'failed' && !sent(wk.t) && /different key/.test(wk.t.failure ?? ''), `${wk.t.state} ${wk.t.failure}`);
    fp.state.mode = 'honest';
    // the user removes the signer in Privy: Privy refuses at once, and relinking is refused until it is added again
    fp.state.delegated = false; const rv = await run('/v1/trades/buy', { token: KEYCAT, eth: '0.001', key: 'r1' });
    check('B11 signer removed in Privy: the next trade fails, nothing sent', rv.t.state === 'failed' && !sent(rv.t), `${rv.t.state} ${rv.t.failure}`);
    st = await call('POST', '/v1/wallet/link/start', { address: addr }); const rl = await call('POST', '/v1/wallet/link/finish', { address: addr, signature: personalSign(fp.key, st.j.message) });
    check('B12 relinking while the signer is removed is refused with the reason', rl.status === 409 && rl.j.error?.code === 'not_delegated', JSON.stringify(rl.j));
    // a token with no V2 pool is refused before anything else
    const np = await call('POST', '/v1/trades/buy', { token: '0x000000000000000000000000000000000000dEaD', eth: '0.001', key: 'n1' });
    check('B13 a token with neither a Uniswap V2 WETH pool nor a Relay route is refused with the reason', np.status >= 400 && np.j.error?.code === 'no_route', JSON.stringify(np.j));
  } catch (e) { check('run', false, (e as Error).stack ?? String(e)); }
  finally { await nd.drain().catch(() => {}); privySrv.close(); fork.stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# Execution server, MODE=base-mainnet, on a local Base fork', '', `Run: ${new Date().toISOString()}`, 'Node: loopback anvil forked from Base mainnet; NOT mainnet. Fake ETH, throwaway key, Privy stand-in (same request signing, README Base policy).',
    `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '', ...checks.map(c => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.pass ? '' : ` (${c.detail.slice(0, 300)})`}`), '',
    '## Not covered', '- Real Privy (its policy engine and TEE) and real Base: the one tiny mainnet trade the user approves covers them.', '- Uniswap V3/V4 and Aerodrome pools are not supported; only V2 WETH pools.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); writeFileSync(`docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-server-base.md`, red(text));
  console.log(`\n${pass ? 'PASS' : 'FAIL'} ${checks.filter(c => c.pass).length}/${checks.length}`); process.exit(pass ? 0 : 1);
}
void main();
