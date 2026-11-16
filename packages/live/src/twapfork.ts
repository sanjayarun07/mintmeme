/** TWAP ORDERS ON A LOCAL ETHEREUM MAINNET FORK. Drives the real-node terminal API (apps/web/livemode.ts, the same code the browser calls) on a loopback anvil fork: a TWAP buy and a TWAP sell of USDC
 *  on the real Uniswap V2 WETH/USDC pool, executed slice by slice by OUR engine through EvmRpcChain, with a price limit, a cancel and a refusal. Time is moved with evm_increaseTime (local fork only).
 *  Local only: throwaway keys, fake ETH, dev-only signer. usage: npm run verify:twap (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, TwapRunner } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import type { RpcLike } from '../../evm/src/index.ts';
import { newWallet, hex, big } from './localnode.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import { startFork } from './forkenv.ts';
import type { LocalNode } from './localnode.ts';
import type { Check } from './localrun.ts';

const PORT = 8663, ETH1 = 10n ** 18n;

export async function runTwapFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const { createLive } = await import('../../../apps/web/livemode.ts');
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const live = await createLive(node), api = (p: string, b: unknown = {}, m = 'POST') => live.api(p, b, m) as Promise<any>;
  const list = async () => (await api('/api/twap', {}, 'GET')) as any[];
  const one = async (id: string) => (await list()).find(o => o.id === id);
  const bal = async (w: string, t: string) => BigInt(await live.chain.balanceOf(live.wallets[w].address, t));
  const usdc = live.usdc;
  const ov: any = await api('/api/overview', {}, 'GET'); const spot = ov.tokens[0].price as number;
  facts.push(`fork of mainnet, chain time ${live.chain.time}; spot ${spot.toPrecision(4)} ETH per USDC; wallet w1 holds 10 ETH of fake ETH; time is moved with evm_increaseTime`);
  const fwd = (s = 300) => api('/api/twap/forward', { seconds: s });

  // T1: TWAP buy, 3 slices, one every 5 minutes
  const eth0 = await bal('w1', NATIVE), us0 = await bal('w1', usdc);
  const c1 = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: String(3n * ETH1 / 10n), slices: 3, intervalS: 300 });
  let o = await one(c1.id);
  check('T1 creating a 3-slice buy sends the first slice now and no more: the others wait for their time', c1.ok === true && o.filled + o.open === 3 && o.filled <= 1 && o.slices[1].status === 'pending' && o.nextInS! > 0, `filled ${o.filled}, next in ${o.nextInS}s`);
  for (let i = 0; i < 4 && !(o = await one(c1.id)).done; i++) await fwd(300);
  o = await one(c1.id); const us1 = await bal('w1', usdc), eth1 = await bal('w1', NATIVE);
  check('T1 after the time passes all 3 slices were traded by the engine, one per interval, and the order is finished', o.done && o.filled === 3 && o.failed === 0 && o.skipped === 0, JSON.stringify({ filled: o.filled, status: o.statusText }));
  check('T1 the wallet\'s real USDC rose by exactly what the slices received, and the ETH spent on trades equals the total', us1 - us0 === BigInt(o.received) && BigInt(o.spent) === 3n * ETH1 / 10n && eth0 - eth1 > BigInt(o.spent), `received ${o.received} USDC units, spent ${o.spent} wei`);
  const keys = [...live.store.records.keys()].filter(k => k.startsWith('twap:tw1:') && !k.endsWith(':approve'));
  check('T1 each slice is its own engine record with its own idempotency key and origin "twap"', keys.length === 3 && keys.every(k => live.store.records.get(k)!.intent.origin === 'twap' && live.store.records.get(k)!.state === 'finalized'), keys.join(', '));
  check('T1 the slices were spread in time: each slice is scheduled exactly one interval (300 s of chain time) after the one before', o.slices.length === 3 && o.slices[1].dueInS - o.slices[0].dueInS === 300 && o.slices[2].dueInS - o.slices[1].dueInS === 300, o.slices.map((s: any) => s.dueInS).join(','));

  // T2: TWAP sell of part of the USDC just bought (the engine adds an exact-amount approval)
  const half = us1 / 2n; const c2 = await api('/api/twap', { side: 'sell', token: usdc, walletId: 'w1', total: String(half), slices: 2, intervalS: 300 });
  for (let i = 0; i < 4 && !(o = await one(c2.id)).done; i++) await fwd(300);
  o = await one(c2.id); const us2 = await bal('w1', usdc);
  check('T2 a 2-slice sell sold exactly the total in USDC, both slices finalized, and the wallet received ETH', c2.ok && o.done && o.filled === 2 && us1 - us2 === half && BigInt(o.received) > 0n, `sold ${half}, received ${o.received} wei`);
  const appr = [...live.store.records.keys()].filter(k => k.startsWith('twap:tw2:') && k.endsWith(':approve')).length;
  check('T2 the sell used exact-amount approvals (child transactions), not unlimited ones', appr >= 1, `${appr} approval record(s)`);

  // T3: a buy price limit far below the market: slices wait, and when their window passes they are skipped, never made up
  const c3 = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: String(ETH1 / 10n), slices: 2, intervalS: 300, limitPrice: String(spot / 2) });
  o = await one(c3.id); const eth2 = await bal('w1', NATIVE);
  check('T3 with the price above the buyer\'s limit the first slice waits (nothing sent) and says why', c3.ok && o.filled === 0 && /Waiting/.test(o.statusText) && /limit|price/i.test(o.slices[0].waiting ?? ''), `${o.statusText}; ${o.slices[0].waiting}`);
  for (let i = 0; i < 6 && !(o = await one(c3.id)).done; i++) await fwd(300);
  o = await one(c3.id); const eth3 = await bal('w1', NATIVE);
  check('T3 when the windows pass the slices are skipped with a reason and the missed amount is NOT made up later; no ETH was spent', o.done && o.skipped === 2 && o.filled === 0 && eth3 === eth2 && o.slices.every((s: any) => s.status === 'skipped' && /window passed/.test(s.reason)), `${o.skipped} skipped: ${o.slices[0].reason}`);

  // T4: cancel stops the unsent slices
  const c4 = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: String(3n * ETH1 / 10n), slices: 3, intervalS: 300 }); await api('/api/twap/cancel', { id: c4.id }); await fwd(300); await fwd(300);
  o = await one(c4.id);
  check('T4 cancelling stops the order: slices not yet sent are skipped and never traded later', o.cancelled && o.done && o.filled <= 1 && o.skipped >= 2, `filled ${o.filled}, skipped ${o.skipped}`);

  // T5: refusals
  const tooBig = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: String(1000n * ETH1), slices: 4, intervalS: 300 });
  const one1 = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: String(ETH1 / 10n), slices: 1, intervalS: 300 });
  const junk = await api('/api/twap', { side: 'buy', token: usdc, walletId: 'w1', total: 'abc', slices: 3, intervalS: 300 });
  check('T5 an order the wallet cannot fund up front, a single-slice order and a junk amount are all refused with a plain reason and nothing is sent', tooBig.ok === false && /Not enough balance/.test(tooBig.title) && one1.ok === false && junk.ok === false, `${tooBig.title} | ${one1.title} | ${junk.title}`);

  // T6: DURABLE across a crash. State lives in two files; "crash" right after a slice is sent, rebuild everything from the files only, and the order carries on without a second buy.
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address;
  const wethAddr = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: router, data: encodeCall('WETH()', []) }, 'latest']))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await node.call<string>('eth_call', [{ to: factory, data: encodeCall('getPair(address,address)', [wethAddr, usdc]) }, 'latest']))[0]);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-twapfork-')), ef = join(dir, 'engine.json'), tf = join(dir, 'twap.json');
  const hs = new CastSigner(), hw = hs.add(newWallet()); await node.call('anvil_setBalance', [hw.address, hex(10n * ETH1)]);
  const pol: WalletPolicy = { userId: 'u1', chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' };
  const spec = { id: 'rs', userId: 'u1', walletId: hw.address, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], side: 'buy' as const, total: 3n * ETH1 / 10n, slices: 3, intervalS: 300, slippageBps: 500 };
  const build = (rpc: RpcLike) => {
    const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth: wethAddr, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, hs), store = Store.open(ef);
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[hw.address, 'x']]), new Map([[hw.address, pol]])), router: new Router(chain), platformFeeBps: 0 });
    return { chain, store, engine, runner: new TwapRunner({ engine, chain, spec, persistPath: tf }) };
  };
  type G = ReturnType<typeof build>;
  const nonce = async () => Number(big(await node.call<string>('eth_getTransactionCount', [hw.address, 'latest'])));
  const usdcOf = async () => { const q = erc20.balanceOf(usdc, hw.address); return erc20.decodeUint(await node.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
  const settleUntil = async (g: G, n: number) => { for (let i = 0; i < 40 && g.runner.summary().filled < n; i++) { await node.call('anvil_mine', ['0x1']); await g.runner.settle(); } };
  const rpcA = new FaultRpc(node), a = build(rpcA); await a.chain.refresh('venues'); rpcA.downAfterSend = true; await a.runner.tick().catch(() => {});
  const b = build(new FaultRpc(node)); await b.chain.refresh('venues');
  check('T6 after a crash right after slice 1 was sent, a runner rebuilt from the two files knows slice 1 is in flight and the order is not finished', b.runner.summary().slices[0].status !== 'pending' && !b.runner.summary().done, JSON.stringify(b.runner.summary().slices.map(x => x.status)));
  await b.runner.resume(); await settleUntil(b, 1); const n1 = await nonce();
  check('T6 the restarted runner finished the SAME transaction: slice 1 is filled, exactly one transaction was ever sent, and slices 2 and 3 have not been sent early', b.runner.summary().filled === 1 && n1 === 1 && b.runner.summary().slices[1].status === 'pending', `filled ${b.runner.summary().filled}, nonce ${n1}`);
  const later = async (g: G) => { await node.call('evm_increaseTime', [hex(300n)]); await node.call('anvil_mine', ['0x1']); await g.runner.tick(); };
  await later(b); await settleUntil(b, 2); const n2 = await nonce();
  const c = build(new FaultRpc(node)); await c.chain.refresh('venues'); await c.runner.resume();     // a second restart, between slices 2 and 3
  await later(c); await settleUntil(c, 3); const n3 = await nonce(), sm = c.runner.summary();
  check('T6 after a second restart the order finished: 3 of 3 slices traded with exactly 3 transactions in all (no slice repeated), and the wallet\'s USDC equals what the slices received', sm.done && sm.filled === 3 && n2 === 2 && n3 === 3 && (await usdcOf()) === sm.received, `nonces ${n1},${n2},${n3}; received ${sm.received}`);
  const onDisk = readFileSync(ef, 'utf8') + readFileSync(tf, 'utf8');
  check('T6 no private key material is written to the state files', !onDisk.includes(hw.key.slice(2)));
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# TWAP orders on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the real-node terminal API (apps/web/livemode.ts) runs TWAP buys and sells on the real Uniswap V2 WETH/USDC pool. Each slice is an ordinary Engine intent with its own idempotency key and origin "twap", executed through EvmRpcChain and the real router. Time is moved with evm_increaseTime so a schedule of minutes can be seen in seconds.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A TWAP spreads the timing of trades; it does not promise an average price or beat the market.', '- The clock is the fork\'s block time, advanced by evm_increaseTime. Real hours of waiting, real hours of waiting and a live chain were not exercised. The restart check (T6) rebuilds the runner, engine and chain objects from the two state files inside the same process; it is not a kill of a separate operating-system process.', '- One pool, no other traffic, no mempool competition or MEV.', '- The browser UI was not driven against the fork in this run.', '- Throwaway keys and a dev-only signer; real custody is not exercised.', ''].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runTwapFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-twap-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('twapfork.ts')) main();
