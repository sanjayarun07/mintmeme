/** SDK AND HTTP API ON A LOCAL FORK OF BNB SMART CHAIN TESTNET (chain 97), OVER THE REAL PANCAKESWAP V2 CONTRACTS DEPLOYED THERE. The router and factory addresses come from PancakeSwap's own developer page and are
 *  re-verified on chain (router.factory() equals the factory; WBNB is read from router.WETH()). A WBNB pool with real reserves is picked from the testnet factory and the same `Trader` suite as the Ethereum fork runs over it.
 *  Local only: anvil forks the testnet through a loopback proxy; fake BNB, throwaway keys, dev-only signer. Testnet liquidity is tiny and junk-heavy, so amounts are small.
 *  usage: npm run verify:bsc-testnet (needs BNB_TESTNET_RPC_URL in .env and anvil). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeCall, decodeParams, getAmountOut } from '../../evm/src/index.ts';
import { startFork } from './forkenv.ts';
import { runTraderFork } from './traderfork.ts';
import type { ForkTarget } from './traderfork.ts';
import type { Check } from './localrun.ts';

const PORT = 8665, ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1', FACTORY = '0x6725F303b657a9451d8BA641348b6761A6CC7a17', SRC = 'https://developer.pancakeswap.finance/contracts/v2/addresses';
// WBNB pools found by scanning the testnet factory, largest reserves first. The first (about 2.9 WBNB) turned out to be a fee-on-transfer token (a buy delivered about 7% less than the router quoted, and sells failed), so a run needs one that is a plain ERC-20; pick with BSC_POOL=<index>.
const POOLS = [{ pair: '0x9868c347345a5b4e9cef43ebe96763d5541fd3e3', token: '0x9882bb282afc895678b331f6bd46200b68767d52' }, { pair: '0x9ce11e89b2821a98a8ce227c19b5cfe6858acf49', token: '0xae3b55e9d20fcff6a8dd39485328acbefff34af6' }, { pair: '0x4127370269a3e374e708dea4af641069b7833fd5', token: '0x6778dca7aea3f3d6a823b7e28c19104753330d89' }, { pair: '0x9c40fc4585b36eabda4f0a31cc3728d7c7691e92', token: '0x508bd49af9426fba66f9abdb7fbac3ceed97c7f7' }];
const POOL = POOLS[Number(process.env.BSC_POOL ?? 0)];

async function main() {
  const url = process.env.BNB_TESTNET_RPC_URL;
  if (!url) { console.error('BNB_TESTNET_RPC_URL is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  const fork = await startFork('', PORT, url);
  try {
    const node = fork.node, call = (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
    const pre: Check[] = []; const ck = (name: string, pass: boolean, detail = '') => { pre.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
    const chainId = Number(BigInt(await node.call<string>('eth_chainId')));
    const rf = String(decodeParams(['address'], await call(ROUTER, encodeCall('factory()', [])))[0]).toLowerCase(), wbnb = String(decodeParams(['address'], await call(ROUTER, encodeCall('WETH()', [])))[0]).toLowerCase();
    ck('B0 the fork reports chain id 97', chainId === 97, String(chainId));
    ck('B1 the router documented by PancakeSwap has code, and router.factory() equals the documented factory', rf === FACTORY.toLowerCase(), `router.factory ${rf}`);
    const pair = String(decodeParams(['address'], await call(FACTORY, encodeCall('getPair(address,address)', [wbnb, POOL.token])))[0]).toLowerCase();
    ck('B2 the factory\'s getPair(WBNB, token) equals the pool we picked', pair === POOL.pair, pair);
    const res = decodeParams(['uint112', 'uint112', 'uint32'], await call(pair, '0x0902f1ac')) as bigint[], t0 = String(decodeParams(['address'], await call(pair, '0x0dfe1681'))[0]).toLowerCase();
    const [rIn, rOut] = t0 === wbnb ? [res[0], res[1]] : [res[1], res[0]]; const probe = 10n ** 15n;
    const rout = (decodeParams(['uint256[]'], await call(ROUTER, encodeCall('getAmountsOut(uint256,address[])', [probe, [wbnb, POOL.token]])))[0] as bigint[])[1];
    const fee = [{ num: 997n, den: 1000n }, { num: 9975n, den: 10000n }, { num: 998n, den: 1000n }].find(f => getAmountOut(probe, rIn, rOut, f) === rout);
    ck('B3 the pool fee is read from the router\'s own getAmountsOut (one of 0.3%, 0.25%, 0.2% reproduces it exactly)', !!fee, `router ${rout}`);
    if (!fee) throw new Error('fee not identified');
    const target: ForkTarget = { label: 'BNB Smart Chain testnet', chainId: 97, router: ROUTER, factory: FACTORY, token: POOL.token, unit: 10n ** 17n, family: 'pancakeswap-v2', fee, nativeName: 'BNB' };
    const r = await runTraderFork(node, target); const checks = [...pre, ...r.checks.map(c => ({ ...c, name: c.name.replace(/^F(\d+)/, 'B$1x')}))];
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`);
    const pass = checks.every(c => c.pass);
    const text = ['# SDK and HTTP API on a BNB Smart Chain testnet fork (PancakeSwap V2)', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork of BNB testnet (chain 97) at ${node.url}; NOT mainnet, NOT a live testnet transaction. Throwaway keys, fake BNB.`, `Contracts: router ${ROUTER}, factory ${FACTORY} (source: ${SRC}); WBNB ${wbnb} read from router.WETH(); pool ${pair} with token ${POOL.token}; pool fee ${fee.num}/${fee.den}.`,
      `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '', '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
      '## Not covered', '- The pool is a junk-prone public testnet pool with a few WBNB of reserves; prices mean nothing, only the mechanics are exercised.', '- Nothing was sent to the real testnet: the forked chain is local. Real testnet submission needs a funded throwaway key and was not done.', '- Only PancakeSwap V2 (not V3), and only plain ERC-20s; fee-on-transfer tokens were not tested here.', '- Four.meme and BSC mainnet are not exercised by this run.'].join('\n');
    mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-bsc-testnet.md`; writeFileSync(file, fork.redact(text));
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(pass ? 0 : 1);
  } catch (e) { console.error(fork.redact((e as Error).stack ?? (e as Error).message)); fork.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('bsctestnetfork.ts')) main();
