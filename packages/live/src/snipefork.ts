/** SNIPER + TRAILING STOP ON A MAINNET FORK. A test token whose trading is closed until a block is deployed on a LOCAL anvil fork of Ethereum mainnet, a pool is created
 *  against the real Uniswap V2 factory/router, and OUR V2LaunchWatcher -> LaunchDetector -> Sniper -> Engine -> OrderRunner (exits) pipeline reacts over JSON-RPC.
 *  Also: a trailing stop (peak tracking, restart with the peak restored, trigger on a real price fall). Local only: throwaway keys, fake ETH, loopback anvil.
 *  The token contract is a test fixture compiled with Foundry (`forge`, needs a solc it can download or has cached): packages/live/contracts/LaunchToken.sol.
 *  usage: npm run verify:snipe (needs ALCHEMY_API_KEY in .env and Foundry). */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, OrderRunner, SnipeRunner } from '../../core/src/index.ts';
import type { Order, SnipeConfig, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, V2LaunchWatcher, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import type { RpcLike } from '../../evm/src/index.ts';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8657, ETH1 = 10n ** 18n, MAX = (1n << 256n) - 1n;

function compileToken(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-forge-')); mkdirSync(join(dir, 'src'));
  copyFileSync(new URL('../contracts/LaunchToken.sol', import.meta.url), join(dir, 'src/LaunchToken.sol')); writeFileSync(join(dir, 'foundry.toml'), "[profile.default]\nsrc='src'\nout='out'\n");
  execFileSync('forge', ['build', '--root', dir, '--silent'], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'out/LaunchToken.sol/LaunchToken.json'), 'utf8')).bytecode.object as string;
}

export async function runSnipeFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address;
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const initcode = compileToken();
  facts.push('test token compiled with Foundry from packages/live/contracts/LaunchToken.sol (trading closed until a block set by the owner); real Uniswap V2 factory + router bytecode; local fork, fake ETH');
  const blockNo = async () => Number(big(await node.call('eth_blockNumber')));
  const nonceOf = async (a: string) => Number(big(await node.call('eth_getTransactionCount', [a, 'latest'])));
  const tokBal = async (t: string, a: string) => { const q = erc20.balanceOf(t, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const ethBal = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));
  const mine = (n = 1) => node.call('anvil_mine', [hex(BigInt(n))]);
  const fee = { maxFeeGwei: '300', priorityGwei: '1' };

  const D = newWallet(); await node.call('anvil_setBalance', [D.address, hex(5000n * ETH1)]);
  const sendRaw = async (raw: string) => { const r: any = await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [raw])); if (r.status !== '0x1') throw new Error(`fixture transaction reverted: ${r.transactionHash}`); return r; };
  const dSend = async (to: string, data: string, value = 0n, gas = 600_000n) => sendRaw(signRaw(D, { to, data, valueWei: value, nonce: await nonceOf(D.address), chainId: 1, gasLimit: gas, ...fee }));
  const deploy = async (supply: bigint) => {
    const code = initcode + supply.toString(16).padStart(64, '0');
    const raw = execFileSync('cast', ['mktx', '--nonce', String(await nonceOf(D.address)), '--chain', '1', '--gas-limit', '2000000', '--gas-price', '300gwei', '--priority-gas-price', '1gwei', '--private-key', D.key, '--create', code], { encoding: 'utf8' }).trim();
    return String((await sendRaw(raw)).contractAddress).toLowerCase();
  };
  const dl = async () => BigInt(Number(big((await node.call<any>('eth_getBlockByNumber', ['latest', false])).timestamp)) + 3600);
  const launch = async (token: string, openInBlocks: number, ethLiq = 5n) => {          // D lists the token: pool created + first liquidity in ONE tx (like a real launch)
    await dSend(token, encodeCall('approve(address,uint256)', [router, MAX]), 0n, 100_000n);
    if (openInBlocks > 0) await dSend(token, encodeCall('setOpen(uint256)', [BigInt((await blockNo()) + openInBlocks)]), 0n, 100_000n);
    return dSend(router, encodeCall('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [token, 5n * 10n ** 26n, 0n, 0n, D.address, await dl()]), ethLiq * ETH1, 3_000_000n);
  };
  const dBuy = async (token: string, eth: bigint) => dSend(router, encodeCall('swapExactETHForTokens(uint256,address[],address,uint256)', [0n, [weth, token], D.address, await dl()]), eth, 500_000n);
  const dSell = async (token: string, amt: bigint) => dSend(router, encodeCall('swapExactTokensForETH(uint256,uint256,address[],address,uint256)', [amt, 0n, [token, weth], D.address, await dl()]), 0n, 500_000n);

  const policyFor = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1 }, dailyLimit: { [NATIVE]: 100n * ETH1 }, destinations: [], deviceSecret: 'dev' });
  const allowToken = (p: WalletPolicy, t: string) => { p.maxPerTx[t] = 10n ** 40n; p.dailyLimit[t] = 10n ** 41n; };
  const cfgFor = (w: Wallet, o: Partial<SnipeConfig> = {}): SnipeConfig => ({ userId: 'u-' + w.address, walletId: w.address, chain: 'evm-fork', quoteToken: NATIVE, venues: ['uniswap-v2'], maxSpend: ETH1 / 10n, delayBlocks: 0, minLiquidity: ETH1,
    maxTaxBps: 500, maxAttempts: 2, slippageBps: 100, exit: { takeProfitBps: 5000, stopLossBps: 3000, minLiquidity: ETH1, maxQuoteAgeMs: 60_000, maxDeviationBps: 2000 }, ...o });
  const mk = async (o: { cfg?: Partial<SnipeConfig>; persist?: { ef: string; sf: string; of?: string }; signer?: CastSigner; wallet?: Wallet; policy?: WalletPolicy } = {}) => {
    const signer = o.signer ?? new CastSigner(), rpc = new FaultRpc(node), w = o.wallet ?? signer.add(newWallet()); if (!o.wallet) await node.call('anvil_setBalance', [w.address, hex(10n * ETH1)]);
    const pol = o.policy ?? policyFor(w.address), chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [], finalityDepth: 3 }, rpc, signer), store = o.persist ? Store.open(o.persist.ef) : new Store();
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'x']]), new Map([[w.address, pol]])), router: new Router(chain), platformFeeBps: 0 });
    const orders = new OrderRunner({ engine, chain, clockMs: () => Date.now(), persistPath: o.persist?.of });
    const watcher = new V2LaunchWatcher({ chain: 'evm-fork', factory, weth, startBlock: (await blockNo()) + 1 }, rpc);
    const runner = new SnipeRunner({ engine, chain, source: watcher, cfg: cfgFor(w, o.cfg), orders, persistPath: o.persist?.sf }); await chain.refresh('head');
    return { signer, rpc, w, pol, chain, store, engine, orders, watcher, runner };
  };
  type S = Awaited<ReturnType<typeof mk>>;
  const lk = (t: string) => `evm-fork:${t}`;
  const drive = async (s: S, until: () => boolean, n = 40) => { for (let i = 0; i < n; i++) { await s.runner.tick(); await s.chain.refresh('venues'); await s.orders.tick(); if (until()) return true; await mine(1); } return false; };

  // ================= SNIPER =================
  const T1 = await deploy(10n ** 27n), A = await mk(); allowToken(A.pol, T1);
  await launch(T1, 25); const openAt = Number(big(await call(T1, encodeCall('openAt()', []))));
  const t0 = await A.runner.tick();
  check('N1 pool creation + first liquidity detected from factory/pair logs: one launch, tradable by events', t0.events === 2 && A.runner.detector.launches().length === 1 && A.runner.detector.launches()[0].status === 'tradable', `events ${t0.events}`);
  check('N2 trading is closed: the dry-run of the real buy reverts, the reason is shown, NO attempt is consumed, nothing is sent', /not tradable yet: .*reverted/.test(A.runner.status.get(lk(T1)) ?? '') && A.runner.sniper.state(lk(T1)).attempts.length === 0 && A.rpc.sends === 0 && (await nonceOf(A.w.address)) === 0, A.runner.status.get(lk(T1)) ?? '');
  await mine(openAt - (await blockNo()) + 1);
  const ok = await drive(A, () => A.runner.results.has(lk(T1)) && !A.runner.inflight.size); const rec = A.store.records.get(`snipe:${A.w.address}:${lk(T1)}:a1`);
  check('N3 once trading opened it bought through the engine: finalized, origin snipe, exactly maxSpend (0.1 ETH)', ok && rec?.state === 'finalized' && rec.intent.origin === 'snipe' && rec.intent.amountIn === ETH1 / 10n, `${rec?.state}`);
  const held = await tokBal(T1, A.w.address);
  check('N3 the wallet\'s real token balance equals the fill; measured buy tax recorded (0 bps for this token)', held === rec?.fill?.received && held > 0n && A.runner.results.get(lk(T1))!.buyTaxBps === 0, `held ${held}`);
  const ids = [...A.orders.orders.orders.keys()].sort();
  check('N4 exit orders placed automatically as one OCO take-profit/stop-loss pair with the tokens reserved once', ids.length === 2 && ids.every(i => i.startsWith(`snipe:${lk(T1)}:`)) && A.orders.reservations.reservedTotal(A.w.address, T1) === held, ids.join());
  const sendsA = A.rpc.sends; await A.runner.tick(); await mine(2); await A.runner.tick();
  check('N5 it never buys the same launch twice', A.rpc.sends === sendsA && [...A.store.records.keys()].filter(k => k.startsWith('snipe:') && !k.endsWith(':approve')).length === 1);
  const ethBefore = await ethBal(A.w.address); await dBuy(T1, 3n * ETH1);       // competitor lifts the price ~2.5x -> take-profit
  const sold = await drive(A, () => [...A.store.records.keys()].some(k => k.startsWith('order:') && !k.endsWith(':approve') && A.store.records.get(k)!.state === 'finalized'));
  const tp = [...A.orders.orders.orders.values()].find(o => o.status === 'fired');
  check('N6 price rose past +50% on the REAL pool: the take-profit fired (stop-loss cancelled), approve + sell finalized, tokens sold, ETH received', sold && tp?.kind === 'take_profit' && [...A.orders.orders.orders.values()].find(o => o.kind === 'stop_loss')!.status === 'cancelled' && (await tokBal(T1, A.w.address)) === 0n && (await ethBal(A.w.address)) > ethBefore, `${tp?.kind} ${tp?.status}`);

  // ================= TRAILING STOP (T1 pool, restart in the middle) =================
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-snipefork-')), pf = { ef: join(dir, 'engine.json'), sf: join(dir, 'snipe.json'), of: join(dir, 'orders.json') };
  const R = await mk({ persist: pf }); allowToken(R.pol, T1); R.chain.addPool({ id: 'uni:T1', pair: [...A.watcher.pairs.values()][0].pair }); await R.chain.refresh('venues');
  const venue = () => R.chain.venues()[0] as any, px = () => venue().spotPriceE18(T1, NATIVE) as bigint;
  await R.engine.submit({ idempotencyKey: 'tr-buy', userId: 'u-' + R.w.address, walletId: R.w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: T1, amountIn: ETH1 / 2n, minOut: 0n, slippageBps: 300, deadline: R.chain.time + 600, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual' });
  for (let i = 0; i < 25 && R.store.records.get('tr-buy')!.state !== 'finalized'; i++) { await mine(1); await R.engine.advance('tr-buy'); }
  const trHeld = await tokBal(T1, R.w.address); await R.chain.refresh('venues'); const entryPx = px();
  const trail: Order = { id: 'trail1', userId: 'u-' + R.w.address, walletId: R.w.address, chain: 'evm-fork', token: T1, quoteToken: NATIVE, kind: 'trailing_stop', amount: trHeld, trailBps: 1000, expiresAt: R.chain.time + 86_400, maxQuoteAgeMs: 60_000,
    minLiquidity: ETH1, maxDeviationBps: 2000, maxAttempts: 2, slippageBps: 100, venues: ['uniswap-v2'], status: 'active', attempts: 0 };
  await R.orders.place(trail); const a1 = await R.orders.tick();
  check('R1 trailing stop placed on the real pool: not triggered at the entry price, peak recorded = current price', a1.fired.length === 0 && R.orders.orders.orders.get('trail1')!.peakE18 === px(), `peak ${R.orders.orders.orders.get('trail1')!.peakE18} px ${px()}`);
  await dBuy(T1, 2n * ETH1); await R.chain.refresh('venues'); await R.orders.tick(); const peak1 = R.orders.orders.orders.get('trail1')!.peakE18!;
  check('R2 price rose: the peak followed it up and the order did not fire', peak1 > entryPx && R.orders.orders.orders.get('trail1')!.status === 'active', `entry ${entryPx} peak ${peak1}`);
  const R2 = await mk({ persist: pf, signer: R.signer, wallet: R.w, policy: R.pol }); R2.chain.addPool({ id: 'uni:T1', pair: [...A.watcher.pairs.values()][0].pair }); await R2.chain.refresh('venues');   // restart from the files only
  check('R3 after a restart from files only the trailing order and its PEAK are restored', R2.orders.orders.orders.get('trail1')?.peakE18 === peak1 && R2.orders.orders.orders.get('trail1')!.status === 'active', `restored ${R2.orders.orders.orders.get('trail1')?.peakE18}`);
  await dBuy(T1, 2n * ETH1); await R2.chain.refresh('venues'); await R2.orders.tick(); const peak2 = R2.orders.orders.orders.get('trail1')!.peakE18!;
  check('R3 the restored order keeps tracking the peak upward', peak2 > peak1);
  const dTokens = await tokBal(T1, D.address); await dSell(T1, dTokens / 2n); await R2.chain.refresh('venues');
  const fall = Number((peak2 - (R2.chain.venues()[0] as any).spotPriceE18(T1, NATIVE)) * 10_000n / peak2);
  const hit = await R2.orders.tick();
  check(`R4 price fell ${fall} bps from the peak (> 1000 bps trail): the trailing stop fired once`, fall > 1000 && hit.fired.join() === 'trail1', `fall ${fall} bps, fired ${hit.fired}`);
  for (let i = 0; i < 25 && R2.orders.inflight.size; i++) { await mine(1); await R2.orders.settle(); }
  const sell = R2.store.records.get('order:trail1:a0');
  check('R4 the engine sold exactly the order amount (approve + swap) and released the reservation', sell?.state === 'finalized' && sell.intent.amountIn === trHeld && (await tokBal(T1, R.w.address)) === 0n && R2.orders.reservations.reservedTotal(R.w.address, T1) === 0n, `${sell?.state}`);

  // ================= DURABLE RESTART of the sniper =================
  const T3 = await deploy(10n ** 27n); const files = { ef: join(dir, 'e3.json'), sf: join(dir, 's3.json') };
  const B = await mk({ persist: files }); allowToken(B.pol, T3); await launch(T3, 0);
  (B.engine as any).submit = async () => { throw new Error('process killed'); };
  let crashed = false; try { await B.runner.tick(); } catch (e) { crashed = /process killed/.test((e as Error).message); }
  const B2 = await mk({ persist: files, signer: B.signer, wallet: B.w, policy: B.pol });
  check('Z1 crash after the write-ahead checkpoint: the buy decision is on disk (attempt counted, intent in the outbox), nothing was sent', crashed && B2.runner.outbox.length === 1 && B2.runner.sniper.state(lk(T3)).attempts.length === 1 && (await nonceOf(B.w.address)) === 0);
  await B2.runner.resume(); await drive(B2, () => B2.runner.results.has(lk(T3)) && !B2.runner.inflight.size);
  check('Z2 restarted from files only: exactly ONE buy on chain, finalized, exits placed once', (await nonceOf(B.w.address)) === 1 && B2.runner.sniper.state(lk(T3)).done && B2.orders.orders.orders.size === 2 && (await tokBal(T3, B.w.address)) === B2.runner.results.get(lk(T3))!.tokens);
  const disk = readFileSync(files.ef, 'utf8') + readFileSync(files.sf, 'utf8');
  check('Z3 no private key material in the state files', !disk.includes(B.signer.keys.get(B.w.address)!.key.slice(2)));

  // ================= LAUNCH REORGED OUT (last: it reverts the chain to a snapshot) =================
  const snap = await node.call<string>('evm_snapshot'); const T2 = await deploy(10n ** 27n); const C = await mk(); allowToken(C.pol, T2); await launch(T2, 40);
  await C.runner.tick(); const seen = C.runner.detector.launches().length;
  await node.call('evm_revert', [snap]); await mine(3); await C.runner.tick(); await C.runner.tick();
  check('X1 the launch was seen, then the chain reorged it away: it is revoked, nothing is ever bought', seen === 1 && /launch revoked/.test(C.runner.status.get(lk(T2)) ?? '') && C.rpc.sends === 0 && C.runner.sniper.state(lk(T2)).attempts.length === 0, (C.runner.status.get(lk(T2)) ?? '') + ` tracked ${JSON.stringify(C.watcher.tracked.length)} cursor ${C.watcher.cursor} head ${await blockNo()} launches ${JSON.stringify(C.runner.detector.launches().map(l => [l.token.slice(0, 8), l.status]))} T2 ${T2.slice(0, 8)}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Sniper and trailing stop on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer, a TEST token we deployed.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: new Uniswap V2 pools and their first liquidity are detected from factory/pair logs over JSON-RPC; the sniper waits out a real "trading not enabled" revert without wasting attempts, buys once within its budget, places take-profit/stop-loss exits automatically, and the exits fire from the real pool price; a trailing stop follows the peak, survives a restart and fires on a real price fall; a crash between decision and submission resumes with one buy; a reorged launch is revoked.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- NO pre-trade sell or tax simulation: honeypots and sell tax are not detected before the buy (only a buy dry-run is used). Buy tax is measured after the fill. Spend is bounded by maxSpend and maxAttempts.', '- The test token has no tax, blacklist, max-wallet or max-tx rules; real launches do.',
    '- Detection is Uniswap-V2-style pools against WETH only (no v3/v4, no launchpad curves). No mempool: the sniper always acts after the launch is mined, so it is never first.', '- Trailing stops are sampled at tick time: a spike and fall between two ticks is not seen. Exit orders compete for nothing else here; no MEV, no competing bots.',
    '- The reorg is simulated with evm_snapshot/evm_revert.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runSnipeFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-snipe-fork.md`; writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('snipefork.ts')) main();
