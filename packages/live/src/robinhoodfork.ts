/** SDK ON A LOCAL FORK OF ROBINHOOD CHAIN TESTNET (chain 46630), OVER A UNISWAP V2 DEPLOYED BY THE TEST ITSELF.
 *  Honest scope: the Uniswap V2 factory and router that Uniswap's page lists for "Robinhood Chain" have NO code on the testnet, and Robinhood's docs list no DEX there. So this run puts Uniswap's own V2 bytecode
 *  (read from Ethereum mainnet with eth_getCode, the router's two immutable addresses swapped for Robinhood's documented testnet WETH and our factory) on the LOCAL FORK only, creates a pool against a plain ERC-20, and runs the
 *  same Trader suite as the other forks. It proves the SDK works on this chain's RPC and on a V2-style DEX there. It does NOT prove anything about a Uniswap deployment on the real testnet, and nothing is sent to it.
 *  usage: npm run verify:robinhood (needs ROBINHOOD_TESTNET_RPC_URL and ALCHEMY_API_KEY in .env, and anvil). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeCall, decodeParams, getAmountOut } from '../../evm/src/index.ts';
import { keccak256, hexToBytes, bytesToHex } from '../../evm/src/keccak.ts';
import { ETH, urls } from './config.ts';
import { startFork } from './forkenv.ts';
import { runTraderFork } from './traderfork.ts';
import type { ForkTarget } from './traderfork.ts';
import type { Check } from './localrun.ts';

const PORT = 8668, DOC_WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa', DOC_SRC = 'https://docs.robinhood.com/chain/protocol-contracts';
const FACTORY = '0x00000000000000000000000000000000f0000001', ROUTER = '0x00000000000000000000000000000000f0000002', TOKEN = '0x00000000000000000000000000000000f0000003', ME = '0x00000000000000000000000000000000f0000009';
const MAINNET_WETH9 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', pad = (x: bigint | string) => (typeof x === 'string' ? x.replace(/^0x/, '').toLowerCase() : x.toString(16)).padStart(64, '0');

async function main() {
  const url = process.env.ROBINHOOD_TESTNET_RPC_URL, akey = process.env.ALCHEMY_API_KEY;
  if (!url || !akey) { console.error('ROBINHOOD_TESTNET_RPC_URL and ALCHEMY_API_KEY must be set in .env.'); process.exit(2); }
  const fork = await startFork(akey, PORT, url), node = fork.node;
  try {
    const pre: Check[] = []; const ck = (name: string, pass: boolean, detail = '') => { pre.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
    const call = (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
    const eth = async (to: string) => { const r = await fetch(urls(akey).eth, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [to, 'latest'] }) }); return String((await r.json() as any).result); };
    const code = async (a: string) => String(await node.call<string>('eth_getCode', [a, 'latest']));
    const tx = async (to: string, data: string, value = 0n) => { const h = await node.call<string>('eth_sendTransaction', [{ from: ME, to, data, value: '0x' + value.toString(16), gas: '0x2dc6c0' }]); await node.call('anvil_mine', ['0x1']); const r: any = await node.call('eth_getTransactionReceipt', [h]); if (r?.status !== '0x1') throw new Error('transaction reverted: ' + data.slice(0, 10)); };
    ck('R0 the fork reports chain id 46630', Number(BigInt(await node.call<string>('eth_chainId'))) === 46630);
    ck('R1 the documented testnet WETH has code on the chain', (await code(DOC_WETH)).length > 100, DOC_SRC);
    ck('R2 the Uniswap V2 addresses listed for "Robinhood Chain" have no code on this testnet (so they are not usable here)', (await code('0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f')).length <= 4 && (await code('0x89e5db8b5aa49aa85ac63f691524311aeb649eba')).length <= 4, 'eth_getCode on both returned 0x');
    for (const a of [FACTORY, ROUTER, TOKEN]) if ((await code(a)).length > 4) throw new Error(`${a} already has code on the fork: pick other addresses`);
    await node.call('anvil_setBalance', [ME, '0x' + (10n ** 22n).toString(16)]); await node.call('anvil_impersonateAccount', [ME]);
    // our stand-ins, all LOCAL to the fork
    let fcode = await eth(ETH.uniswapV2Factory.address); let rcode = await eth(ETH.uniswapV2Router02.address);
    const swap = (c: string, from: string, to: string) => { const f = from.replace(/^0x/, '').toLowerCase(), t = to.replace(/^0x/, '').toLowerCase(); const n = c.toLowerCase().split(f).length - 1; return { code: c.toLowerCase().split(f).join(t), n }; };
    const r1 = swap(rcode, ETH.uniswapV2Factory.address, FACTORY), r2 = swap(r1.code, MAINNET_WETH9, DOC_WETH); rcode = r2.code;
    ck('R3 the router bytecode embeds the factory and WETH addresses as constants and both were swapped', r1.n >= 1 && r2.n >= 1, `factory x${r1.n}, WETH x${r2.n}`);
    await node.call('anvil_setCode', [FACTORY, fcode]); await node.call('anvil_setCode', [ROUTER, rcode]); await node.call('anvil_setCode', [TOKEN, await eth(MAINNET_WETH9)]);
    const rf = String(decodeParams(['address'], await call(ROUTER, encodeCall('factory()', [])))[0]).toLowerCase(), rw = String(decodeParams(['address'], await call(ROUTER, encodeCall('WETH()', [])))[0]).toLowerCase();
    ck('R4 router.factory() and router.WETH() return our factory and the documented testnet WETH', rf === FACTORY && rw === DOC_WETH.toLowerCase(), `${rf} ${rw}`);
    // plain ERC-20 for the pool: WETH9's own code as a token (its balanceOf mapping is at storage slot 3), 1,000,000 tokens to the funder
    const slot = bytesToHex(keccak256(hexToBytes('0x' + pad(ME) + pad(3n)))); await node.call('anvil_setStorageAt', [TOKEN, slot, '0x' + pad(10n ** 6n * 10n ** 18n)]);
    await tx(FACTORY, encodeCall('createPair(address,address)', [DOC_WETH, TOKEN]));
    await tx(TOKEN, '0x095ea7b3' + pad(ROUTER) + pad((1n << 256n) - 1n));
    await tx(ROUTER, encodeCall('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [TOKEN, 5n * 10n ** 5n * 10n ** 18n, 0n, 0n, ME, BigInt(Math.floor(Date.now() / 1000) + 86400 * 30)]), 50n * 10n ** 18n);
    const pair = String(decodeParams(['address'], await call(FACTORY, encodeCall('getPair(address,address)', [DOC_WETH, TOKEN])))[0]).toLowerCase();
    const res = decodeParams(['uint112', 'uint112', 'uint32'], await call(pair, '0x0902f1ac')) as bigint[], t0 = String(decodeParams(['address'], await call(pair, '0x0dfe1681'))[0]).toLowerCase();
    const [rIn, rOut] = t0 === DOC_WETH.toLowerCase() ? [res[0], res[1]] : [res[1], res[0]], probe = 10n ** 15n;
    ck('R5 a pool with 50 ETH and 500,000 tokens exists through our factory', rIn === 50n * 10n ** 18n && rOut === 5n * 10n ** 5n * 10n ** 18n, `reserves ${rIn} / ${rOut}`);
    const rq = (decodeParams(['uint256[]'], await call(ROUTER, encodeCall('getAmountsOut(uint256,address[])', [probe, [DOC_WETH, TOKEN]])))[0] as bigint[])[1];
    const fee = [{ num: 997n, den: 1000n }, { num: 9975n, den: 10000n }].find(f => getAmountOut(probe, rIn, rOut, f) === rq);
    ck('R6 the pool fee is read from the router\'s own getAmountsOut', !!fee, `router ${rq}`); if (!fee) throw new Error('fee not identified');
    const target: ForkTarget = { label: 'Robinhood Chain testnet (local fork, self-deployed Uniswap V2)', chainId: 46630, router: ROUTER, factory: FACTORY, token: TOKEN, unit: 10n ** 18n, family: 'uniswap-v2', fee, nativeName: 'ETH' };
    const r = await runTraderFork(node, target); const checks = [...pre, ...r.checks.map(c => ({ ...c, name: c.name.replace(/^F(\d+)/, 'R$1x') }))];
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`);
    const pass = checks.every(c => c.pass);
    const text = ['# SDK on a Robinhood Chain testnet fork (self-deployed Uniswap V2)', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork of Robinhood Chain testnet (chain 46630) at ${node.url}. NOT the real testnet; nothing was sent to it. Throwaway keys, fake ETH.`,
      `Deployed on the fork only: factory ${FACTORY}, router ${ROUTER}, token ${TOKEN} (Uniswap's own V2 bytecode read from Ethereum mainnet; WETH9 code reused as a plain ERC-20). WETH: ${DOC_WETH} (documented at ${DOC_SRC}).`,
      `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '', '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
      '## Not covered', '- There is no Uniswap V2 on the real Robinhood testnet that we could find: the listed addresses have no code there. This run does not show that Uniswap or any DEX works on the real testnet, only that the SDK works against this chain\'s RPC and fork behaviour with a V2-style pool.', '- No transaction went to the real testnet.', '- The fork uses anvil\'s EVM, not Arbitrum Nitro: Nitro gas accounting (L1 data fee) and precompiles are not reproduced.', '- Uniswap V3 and Robinhood\'s stock tokens are not exercised.'].join('\n');
    mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-robinhood-testnet.md`; writeFileSync(file, fork.redact(text));
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(pass ? 0 : 1);
  } catch (e) { console.error(fork.redact((e as Error).stack ?? (e as Error).message)); fork.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('robinhoodfork.ts')) main();
