/** MAINNET-FORK swap test. Starts a LOCAL anvil forked from Ethereum mainnet (using ALCHEMY_API_KEY, read-only), then runs a real
 *  buy -> approve -> sell through the real Uniswap V2 router bytecode with throwaway keys and fake local ETH. Nothing touches mainnet:
 *  all transactions go to the loopback anvil only. The key stays in this process: anvil forks a loopback proxy that adds it (never argv/env of anvil), and it is redacted from output.
 *  usage: npm run verify:fork        (needs `anvil` from Foundry on PATH and ALCHEMY_API_KEY in .env or the environment) */
import { startFork } from './forkenv.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import { encodeCall, decodeParams, decodeReserves, getAmountOut, swapExactETHForTokens, swapExactTokensForETH, erc20, planApproval, MAX_UINT256 } from '../../evm/src/index.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8651, ETH1 = 10n ** 18n;

export async function runFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const chainId = Number(big(await node.call('eth_chainId')));
  const head: any = await node.call('eth_getBlockByNumber', ['latest', false]);
  facts.push(`fork of chainId ${chainId} at mainnet block ${big(head.number)} (anvil local copy; every transaction below is local and uses fake ETH)`);
  check('F0 fork reports mainnet chain id 1', chainId === 1);
  const router = ETH.uniswapV2Router02.address, usdc = ETH.usdc.address, factory = ETH.uniswapV2Factory.address;
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]);
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const token0 = String(decodeParams(['address'], await call(pair, encodeCall('token0()', [])))[0]).toLowerCase();
  const reserves = async () => { const r = decodeReserves(await call(pair, encodeCall('getReserves()', []))); return token0 === weth.toLowerCase() ? { weth: r.reserve0, usdc: r.reserve1 } : { weth: r.reserve1, usdc: r.reserve0 }; };
  const usdcBal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const ethBal = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));

  const w = newWallet();
  await node.call('anvil_setBalance', [w.address, hex(10n * ETH1)]);
  const gp = big(await node.call('eth_gasPrice'));
  const fees = { maxFeeGwei: (Number(gp * 2n) / 1e9).toFixed(9), priorityGwei: '0.1' };
  let nonce = 0;
  const send = async (tx: { to: string; data: string; value: bigint }, gasLimit = 400_000n) => {
    const raw = signRaw(w, { to: tx.to, data: tx.data, valueWei: tx.value, nonce: nonce++, chainId, gasLimit, ...fees });
    const hash = await node.call<string>('eth_sendRawTransaction', [raw]); const rc = await node.waitReceipt(hash);
    return { raw, hash, rc, gas: big(rc.gasUsed) * big(rc.effectiveGasPrice) };
  };
  const deadline = BigInt(head.timestamp) + 3600n;

  // ---- BUY: 0.1 ETH -> USDC, minOut = our exact quote
  const amountIn = ETH1 / 10n, r0 = await reserves();
  const quote = getAmountOut(amountIn, r0.weth, r0.usdc);
  const ethBefore = await ethBal(w.address), usdcBefore = await usdcBal(w.address);
  const buy = await send(swapExactETHForTokens({ router, amountIn, amountOutMin: quote, path: [weth, usdc], to: w.address, deadline }));
  check('F1 buy mined with status success', buy.rc.status === '0x1');
  const got = (await usdcBal(w.address)) - usdcBefore;
  check('F2 USDC received (balance delta) == our quote exactly', got === quote, `received ${got}, quoted ${quote}`);
  const logs = (buy.rc.logs as any[]).filter(l => l.address.toLowerCase() === usdc.toLowerCase() && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && '0x' + l.topics[2].slice(26) === w.address);
  check('F3 fill derived from the receipt Transfer log == balance delta', logs.length === 1 && big(logs[0].data) === got, `log ${logs[0] ? big(logs[0].data) : 'missing'}`);
  const ethSpent = ethBefore - (await ethBal(w.address));
  check('F4 ETH spent == amountIn + gasUsed*effectiveGasPrice', ethSpent === amountIn + buy.gas, `spent ${ethSpent}, expected ${amountIn + buy.gas}`);
  facts.push(`buy: 0.1 ETH -> ${got} USDC units; gas ${big(buy.rc.gasUsed)}`);

  // ---- REPLAY: same raw bytes must not execute twice
  const replay = await node.tryCall('eth_sendRawTransaction', [buy.raw]);
  facts.push(`replay of the included buy -> ${replay.ok ? 'accepted ' + replay.result : 'rejected: ' + replay.error}`);
  check('F5 replaying the buy does not spend again', (await usdcBal(w.address)) === usdcBefore + got);

  // ---- APPROVE exactly the amount (never unlimited)
  let refused = false; try { planApproval(usdc, router, MAX_UINT256, 0n); } catch { refused = true; }
  check('F6 unlimited approval refused by the planner', refused);
  const plan = planApproval(usdc, router, got, 0n);
  check('F7 approval plan is exactly one approve for the bought amount', plan.length === 1);
  const ap = await send(plan[0], 100_000n);
  const al = await call(...Object.values(erc20.allowance(usdc, w.address, router)) as [string, string]);
  check('F8 approve mined and allowance == exact amount', ap.rc.status === '0x1' && erc20.decodeUint(al) === got, `allowance ${erc20.decodeUint(al)}`);

  // ---- SELL guard: minOut one unit above the quote must revert ON-CHAIN, pay gas, move nothing
  const r1 = await reserves();
  const sellQuote = getAmountOut(got, r1.usdc, r1.weth);
  const usdcPre = await usdcBal(w.address);
  const bad = await send(swapExactTokensForETH({ router, amountIn: got, amountOutMin: sellQuote + 1n, path: [usdc, weth], to: w.address, deadline }));
  check('F9 sell with minOut above quote reverts on-chain', bad.rc.status === '0x0');
  check('F10 reverted sell moved no tokens but cost gas', (await usdcBal(w.address)) === usdcPre && bad.gas > 0n, `gas paid ${bad.gas}`);

  // ---- SELL: at the exact quote
  const ethPre = await ethBal(w.address);
  const sell = await send(swapExactTokensForETH({ router, amountIn: got, amountOutMin: sellQuote, path: [usdc, weth], to: w.address, deadline }));
  check('F11 sell mined with status success', sell.rc.status === '0x1');
  const ethGot = (await ethBal(w.address)) - ethPre + sell.gas;
  check('F12 ETH received (balance delta + gas) == our sell quote exactly', ethGot === sellQuote, `received ${ethGot}, quoted ${sellQuote}`);
  check('F13 all USDC sold', (await usdcBal(w.address)) === 0n);
  const loss = Number((amountIn - ethGot) * 10_000n / amountIn);
  facts.push(`sell: ${got} USDC -> ${ethGot} wei; round trip lost ${loss} bps before gas (two 0.3% pool fees + price impact on a ~${r0.weth / ETH1} WETH pool)`);
  check('F14 round trip lost money, within a sane bound (0 < loss < 100 bps)', loss > 0 && loss < 100, `${loss} bps`);
  facts.push(`gas: buy ${big(buy.rc.gasUsed)}, approve ${big(ap.rc.gasUsed)}, reverted sell ${big(bad.rc.gasUsed)}, sell ${big(sell.rc.gasUsed)}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: [`# Mainnet-fork swap test — Uniswap V2 (Ethereum)`, '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake local ETH.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: our calldata builders, quote math and fill derivation run against the REAL Uniswap V2 router/pair bytecode and real mainnet state (forked).', '', '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Not a real mainnet transaction: no MEV, no competing txs, no real mempool or inclusion latency.', '- Only WETH/USDC (a plain token). Tax, honeypot, rebasing and fee-on-transfer tokens are not exercised.', '- The engine still runs on the simulator; this validates its assumptions and the EVM adapter, not an end-to-end engine run.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-fork-uniswapv2.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('forkrun.ts')) main();
