import { encodeCall, decodeParams, getAmountOut, decodeReserves } from '../../evm/src/index.ts';
import { Rpc } from './rpc.ts';
import { ETH, SOL, ETH_UNCONFIGURED } from './config.ts';

export interface Check { id: string; status: 'pass' | 'fail' | 'skipped'; detail: string }
const ok = (id: string, detail: string): Check => ({ id, status: 'pass', detail });
const bad = (id: string, detail: string): Check => ({ id, status: 'fail', detail });
const skip = (id: string, detail: string): Check => ({ id, status: 'skipped', detail });
const addr = (v: unknown) => String(v).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

export async function verifyEthereum(rpc: Rpc): Promise<{ checks: Check[]; block?: number }> {
  const checks: Check[] = []; let block: number | undefined;
  const guard = async (id: string, f: () => Promise<Check>) => { try { checks.push(await f()); } catch (e) { checks.push(bad(id, (e as Error).message)); } };
  let blockHex = 'latest';
  await guard('eth.chainId', async () => { const id = BigInt(await rpc.call<string>('eth_chainId')); return id === ETH.chainIdExpected ? ok('eth.chainId', `node reports chain id ${id}`) : bad('eth.chainId', `expected ${ETH.chainIdExpected}, node reports ${id}`); });
  await guard('eth.block', async () => { blockHex = await rpc.call<string>('eth_blockNumber'); block = Number(BigInt(blockHex)); return ok('eth.block', `all reads below are pinned to block ${block}`); });
  const call = (to: string, data: string) => rpc.call<string>('eth_call', [{ to, data }, blockHex]);
  for (const [k, v] of [['factory', ETH.uniswapV2Factory], ['router', ETH.uniswapV2Router02], ['usdc', ETH.usdc]] as const)
    await guard(`eth.code.${k}`, async () => { const c = await rpc.call<string>('eth_getCode', [v.address, blockHex]); return c && c !== '0x' ? ok(`eth.code.${k}`, `contract code present at ${v.address} (${(c.length - 2) / 2} bytes)`) : bad(`eth.code.${k}`, `no contract code at ${v.address}`); });
  let weth = '';
  await guard('eth.router.factory', async () => { const [f] = decodeParams(['address'], await call(ETH.uniswapV2Router02.address, encodeCall('factory()', []))); return addr(f) === addr(ETH.uniswapV2Factory.address) ? ok('eth.router.factory', 'router.factory() equals the configured factory') : bad('eth.router.factory', `router points to ${f}`); });
  await guard('eth.router.weth', async () => { const [w] = decodeParams(['address'], await call(ETH.uniswapV2Router02.address, encodeCall('WETH()', []))); weth = String(w); return ok('eth.router.weth', `WETH from official router: ${weth}`); });
  let pair = '';
  await guard('eth.pair', async () => { const [p] = decodeParams(['address'], await call(ETH.uniswapV2Factory.address, encodeCall('getPair(address,address)', [weth, ETH.usdc.address]))); pair = String(p); return addr(pair) === ZERO ? bad('eth.pair', 'factory has no WETH/USDC pair') : ok('eth.pair', `WETH/USDC pair ${pair}`); });
  let r0 = 0n, r1 = 0n, t0 = '';
  await guard('eth.reserves', async () => { t0 = String(decodeParams(['address'], await call(pair, encodeCall('token0()', [])))[0]); const r = decodeReserves(await call(pair, encodeCall('getReserves()', []))); r0 = r.reserve0; r1 = r.reserve1; return r0 > 0n && r1 > 0n ? ok('eth.reserves', `reserves ${r0} / ${r1} (token0 ${t0})`) : bad('eth.reserves', 'empty reserves'); });
  await guard('eth.quote.matches-router', async () => {
    const amountIn = 10n ** 18n, [rIn, rOut] = addr(t0) === addr(weth) ? [r0, r1] : [r1, r0];
    const mine = getAmountOut(amountIn, rIn, rOut);
    const [arr] = decodeParams(['uint256[]'], await call(ETH.uniswapV2Router02.address, encodeCall('getAmountsOut(uint256,address[])', [amountIn, [weth, ETH.usdc.address]]))) as [bigint[]];
    return arr[1] === mine ? ok('eth.quote.matches-router', `our getAmountOut equals the router's for 1 WETH at block ${block}: ${mine} USDC units`) : bad('eth.quote.matches-router', `ours ${mine} vs router ${arr[1]}`);
  });
  for (const u of ETH_UNCONFIGURED) checks.push(skip('eth.unconfigured', u));
  return { checks, block };
}

export async function verifySolana(rpc: Rpc): Promise<{ checks: Check[]; slot?: number }> {
  const checks: Check[] = []; let slot: number | undefined;
  const guard = async (id: string, f: () => Promise<Check>) => { try { checks.push(await f()); } catch (e) { checks.push(bad(id, (e as Error).message)); } };
  await guard('sol.version', async () => { const v: any = await rpc.call('getVersion'); return ok('sol.version', `solana-core ${v['solana-core']}`); });
  await guard('sol.genesis', async () => ok('sol.genesis', `genesis hash ${await rpc.call<string>('getGenesisHash')} (recorded; not compared to an official source in this run)`));
  await guard('sol.slot', async () => { slot = await rpc.call<number>('getSlot'); return ok('sol.slot', `current slot ${slot}`); });
  for (const p of SOL.programs) await guard(`sol.program.${p.name}`, async () => {
    const r: any = await rpc.call('getAccountInfo', [p.address, { encoding: 'base64' }]);
    if (!r?.value) return bad(`sol.program.${p.name}`, `account ${p.address} does not exist`);
    return r.value.executable ? ok(`sol.program.${p.name}`, `${p.address} exists and is executable (owner ${r.value.owner})`) : bad(`sol.program.${p.name}`, `${p.address} exists but is not executable`);
  });
  for (const u of SOL.unconfigured) checks.push(skip('sol.unconfigured', u));
  return { checks, slot };
}
