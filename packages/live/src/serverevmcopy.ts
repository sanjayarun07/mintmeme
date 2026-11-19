/** EVM COPY TRADING THROUGH THE EXECUTION SERVER, END TO END ON A LOCAL BASE FORK. A real node (Redis on 127.0.0.1:6379) runs the production account code
 *  (apps/server/baseaccount.ts with evmcopy.ts); the chain is a loopback anvil forked from Base mainnet; Privy is the local stand-in (packages/evm/test/fakeprivyevm.ts).
 *  A LEADER wallet (impersonated on the fork) really trades KEYCAT on Uniswap V2; the follower's copy config must copy its buy and follow its sell, signed by the Privy
 *  stand-in within the policy, found by the leader watcher in 'logs' mode. Fake ETH, throwaway keys, nothing reaches mainnet.
 *  usage: npm run verify:server-evmcopy (needs ALCHEMY_API_KEY with Base enabled, or BASE_RPC_URL, plus Foundry's anvil and Redis). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { startFork } from './forkenv.ts';
import { fakePrivyEvm } from '../../evm/test/fakeprivyevm.ts';
import { personalSign } from '../../evm/test/ecdsa.ts';
import { erc20, swapExactETHForTokens, swapExactTokensForETH } from '../../evm/src/index.ts';
import { createNode } from '../../../apps/server/node.ts';
import { baseAccounts, baseLinkRoutes } from '../../../apps/server/baseaccount.ts';

const V2_ROUTER = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', WETH = '0x4200000000000000000000000000000000000006', KEYCAT = '0x9a26f5433671751c3276a065f57e5a02d2817973', PORT = 8673;
const LEADER = '0x1eade0000000000000000000000000000000c0de';
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const key = process.env.ALCHEMY_API_KEY ?? '', upstream = process.env.BASE_RPC_URL || (key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : '');
  if (!upstream) { console.error('Set ALCHEMY_API_KEY (with Base enabled) or BASE_RPC_URL.'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const fork = await startFork(key || 'no-key', PORT, upstream), node = fork.node, red = fork.redact;
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: red(detail) }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + red(detail).slice(0, 400)}`); };
  const fp = fakePrivyEvm(), privySrv = await fp.listen(), addr = fp.address;
  const API_KEY = 'evmcopy-fork-key-0123456789abcdef', keys = [{ keyHash: createHash('sha256').update(API_KEY).digest('hex'), userId: 'flo' }], ns = `memedesk-evmcopy:${Date.now()}`;
  const acc = baseAccounts({ rpcUrl: node.url, privy: { ...fp.cfg, apiUrl: privySrv.url } });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: ns, publicUrl: url, keys, makeAccount: acc.make, extraRoutes: h => baseLinkRoutes({ privy: acc.privy, status: acc.status, ...h }), leaseTtlMs: 3000, sweepMs: 1000, requireAof: false, log: () => {} });
  await nd.listen(port);
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(url + path, { method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) as any }; };
  const bal = async (who: string) => { const q = erc20.balanceOf(KEYCAT, who); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
  /** The leader trades by itself: an impersonated wallet sends its own transactions to the router (as a real leader would). */
  const leaderSend = async (tx: { to: string; data: string; value: bigint }) => { const h = await node.call<string>('eth_sendTransaction', [{ from: LEADER, to: tx.to, data: tx.data, value: '0x' + tx.value.toString(16), gas: '0x7a120' }]); await node.call('anvil_mine', ['0x1']); return h; };
  const deadline = async () => Number(BigInt((await node.call<any>('eth_getBlockByNumber', ['latest', false])).timestamp)) + 600;
  /** The copy's trades: wait for the node's loop to see the leader and send, mining blocks so trades reach finality. */
  const copyTrades = async () => { const r = await call('GET', '/v1/trades?origin=copy'); return (Array.isArray(r.j) ? r.j : r.j.trades ?? []) as any[]; };
  const waitCopy = async (n: number, ms = 60_000) => { const t0 = Date.now(); let ts: any[] = []; while (Date.now() - t0 < ms) { await node.call('anvil_mine', ['0x2']); ts = await copyTrades(); for (const t of ts) if (!['finalized', 'failed', 'expired'].includes(t.state)) await call('POST', `/v1/trades/${encodeURIComponent(t.key)}/advance`); if (ts.filter(t => ['finalized', 'failed', 'expired'].includes(t.state)).length >= n) break; await sleep(800); } return ts; };
  try {
    await node.call('anvil_setBalance', [addr, '0x' + (5n * 10n ** 16n).toString(16)]); await node.call('anvil_setBalance', [LEADER, '0x' + (10n ** 18n).toString(16)]);
    await node.call('anvil_impersonateAccount', [LEADER]);
    const st = await call('POST', '/v1/wallet/link/start', { address: addr }), ln = await call('POST', '/v1/wallet/link/finish', { address: addr, signature: personalSign(fp.key, st.j.message) });
    check('E1 the follower links its wallet (Privy stand-in, Base policy)', ln.status === 200 && ln.j.active === true, JSON.stringify(ln.j));
    // a leader buy BEFORE the copy exists: never copied
    await leaderSend(swapExactETHForTokens({ router: V2_ROUTER, amountIn: 10n ** 15n, amountOutMin: 0n, path: [WETH, KEYCAT], to: LEADER, deadline: await deadline() }));
    const over = await call('POST', '/v1/copies', { leader: LEADER, fixedEth: '0.02' });
    check('E2 a copy above the per-trade cap (0.01 ETH) is refused with the reason', over.status === 400 && over.j.error?.code === 'above_cap', JSON.stringify(over.j));
    const bad = await call('POST', '/v1/copies', { leader: LEADER, fixedSol: '0.1' });
    check('E3 Solana field names are refused on Base, naming the right ones', bad.status === 400 && /fixedEth/.test(bad.j.error?.fix ?? ''), JSON.stringify(bad.j));
    const cr = await call('POST', '/v1/copies', { id: 'lead', leader: LEADER, fixedEth: '0.002', slippagePct: 10, exitMode: 'full-on-exit' });
    check('E4 the copy is created and running', cr.status === 200 && cr.j.running === true && cr.j.fixedEth === '0.002', JSON.stringify(cr.j));
    await node.call('anvil_mine', ['0x3']); await sleep(2500);
    check('E5 the leader\'s buy from before the copy existed is not copied', (await copyTrades()).length === 0 && (await bal(addr)) === 0n, JSON.stringify(await copyTrades()));
    // the leader buys: the follower copies 0.002 ETH, signed by Privy, tokens arrive
    const signed0 = fp.state.signed;
    await leaderSend(swapExactETHForTokens({ router: V2_ROUTER, amountIn: 5n * 10n ** 15n, amountOutMin: 0n, path: [WETH, KEYCAT], to: LEADER, deadline: await deadline() }));
    const t1 = await waitCopy(1), got = await bal(addr), buy = t1.find(t => t.state === 'finalized');
    check('E6 the leader\'s buy is copied: 0.002 ETH of KEYCAT, finalized, signed by Privy, tokens in the follower\'s wallet', !!buy && got > 0n && BigInt(buy.amountIn ?? 0) === 2n * 10n ** 15n && fp.state.signed > signed0, JSON.stringify(t1.map(t => ({ s: t.state, a: t.amountIn, f: t.failure }))) + ` tokens ${got}`);
    // the leader sells everything: full-on-exit follows it out
    const lb = await bal(LEADER), ap = erc20.approve(KEYCAT, V2_ROUTER, lb);
    await leaderSend({ to: ap.to, data: ap.data, value: 0n });
    await leaderSend(swapExactTokensForETH({ router: V2_ROUTER, amountIn: lb, amountOutMin: 0n, path: [KEYCAT, WETH], to: LEADER, deadline: await deadline() }));
    const t2 = await waitCopy(2), left = await bal(addr);
    check('E7 the leader sells everything: the follower sells its copied KEYCAT too (full-on-exit)', left === 0n && t2.filter(t => t.state === 'finalized').length >= 2, JSON.stringify(t2.map(t => ({ s: t.state, a: t.amountIn, f: t.failure }))) + ` left ${left}`);
    const ls = await call('GET', '/v1/copies'), c = (Array.isArray(ls.j) ? ls.j : [])[0];
    check('E8 GET /v1/copies shows the config with its decisions and no error', ls.status === 200 && c?.id === 'lead' && !c.lastError && (c.decisions?.length ?? 0) >= 1, JSON.stringify(c).slice(0, 400));
    const del = await call('DELETE', '/v1/copies/lead'), n0 = (await copyTrades()).length;
    await leaderSend(swapExactETHForTokens({ router: V2_ROUTER, amountIn: 10n ** 15n, amountOutMin: 0n, path: [WETH, KEYCAT], to: LEADER, deadline: await deadline() }));
    await node.call('anvil_mine', ['0x3']); await sleep(3000);
    check('E9 after DELETE, the leader\'s next buy is not copied', del.status === 200 && (await copyTrades()).length === n0, `${del.status} ${n0} -> ${(await copyTrades()).length}`);
  } catch (e) { check('run', false, (e as Error).stack ?? String(e)); }
  finally { await nd.drain().catch(() => {}); privySrv.close(); fork.stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# EVM copy trading through the execution server, on a local Base fork', '', `Run: ${new Date().toISOString()}`, 'Node: local anvil fork of Base mainnet; Privy: local stand-in; leader: an impersonated wallet trading KEYCAT on Uniswap V2.', '',
    `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '', ...checks.map(c => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.pass ? '' : ` (${c.detail.slice(0, 300)})`}`), '',
    '## Not covered', '- Real Privy and real Base: a small mainnet copy the user approves covers them.', '- Leaders trading through aggregators (KyberSwap, Relay) are found the same way (Transfer logs) but are not exercised here.', '- BNB Chain and Robinhood Chain run the same code with their own networks; not forked here.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); writeFileSync(`docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-server-evmcopy.md`, red(text));
  console.log(`\n${pass ? 'PASS' : 'FAIL'} ${checks.filter(c => c.pass).length}/${checks.length}`); process.exit(pass ? 0 : 1);
}
void main();
