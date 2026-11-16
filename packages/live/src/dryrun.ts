import { encodeCall, decodeParams, decodeReserves, getAmountOut, swapExactETHForTokens, erc20, planApproval, MAX_UINT256 } from '../../evm/src/index.ts';
import { Rpc } from './rpc.ts';
import { ETH } from './config.ts';
import type { Check } from './verify.ts';

const ok = (id: string, detail: string): Check => ({ id, status: 'pass', detail });
const bad = (id: string, detail: string): Check => ({ id, status: 'fail', detail });
const hex = (n: bigint) => '0x' + n.toString(16);
/** Throwaway sender with no key anywhere: eth_call does not need a signature, and a balance override lets it "hold" ETH for the simulation only. */
const FROM = '0x1234567890123456789012345678901234567890';
const AMOUNT_IN = 10n ** 17n;   // 0.1 ETH, simulated only

/** Simulates real Uniswap V2 swap transactions built by OUR calldata builders against live mainnet state. Nothing is signed or sent. */
export async function verifyEthSwapDryRun(rpc: Rpc): Promise<{ checks: Check[]; block?: number }> {
  const checks: Check[] = []; let block: number | undefined;
  const guard = async (id: string, f: () => Promise<Check>) => { try { checks.push(await f()); } catch (e) { checks.push(bad(id, (e as Error).message)); } };
  const blockHex = await rpc.call<string>('eth_blockNumber'); block = Number(BigInt(blockHex));
  const header: any = await rpc.call('eth_getBlockByNumber', [blockHex, false]); const ts = BigInt(header.timestamp);
  const router = ETH.uniswapV2Router02.address, usdc = ETH.usdc.address;
  const override = { [FROM]: { balance: hex(100n * 10n ** 18n) } };
  const read = (to: string, data: string) => rpc.call<string>('eth_call', [{ to, data }, blockHex]);
  const [wethRaw] = decodeParams(['address'], await read(router, encodeCall('WETH()', []))); const weth = String(wethRaw);
  const [pair] = decodeParams(['address'], await read(ETH.uniswapV2Factory.address, encodeCall('getPair(address,address)', [weth, usdc])));
  const t0 = String(decodeParams(['address'], await read(String(pair), encodeCall('token0()', [])))[0]);
  const rs = decodeReserves(await read(String(pair), encodeCall('getReserves()', [])));
  const [rIn, rOut] = t0.toLowerCase() === weth.toLowerCase() ? [rs.reserve0, rs.reserve1] : [rs.reserve1, rs.reserve0];
  const expected = getAmountOut(AMOUNT_IN, rIn, rOut);
  const sim = (tx: { to: string; data: string; value: bigint }) => rpc.call<string>('eth_call', [{ from: FROM, to: tx.to, data: tx.data, value: hex(tx.value) }, blockHex, override]);
  const build = (min: bigint, o: { fot?: boolean; deadline?: bigint } = {}) => swapExactETHForTokens({ router, amountIn: AMOUNT_IN, amountOutMin: min, path: [weth, usdc], to: FROM, deadline: o.deadline ?? ts + 1200n, feeOnTransfer: o.fot });
  const expectRevert = async (id: string, tx: ReturnType<typeof build>, needle: string, what: string) => {
    try { await sim(tx); checks.push(bad(id, `${what}: the simulation succeeded but should have reverted`)); }
    catch (e) { const m = (e as Error).message; checks.push(m.includes(needle) ? ok(id, `${what}: reverted with "${needle}" as expected`) : bad(id, `${what}: reverted with an unexpected reason: ${m}`)); }
  };

  await guard('dry.sender-is-eoa', async () => { const c = await rpc.call<string>('eth_getCode', [FROM, blockHex]); return c === '0x' ? ok('dry.sender-is-eoa', `simulated sender ${FROM} has no code (balance is an override, no key exists)`) : bad('dry.sender-is-eoa', 'sender address has contract code; pick another'); });
  await guard('dry.swap.eth-for-usdc', async () => {
    const [amounts] = decodeParams(['uint256[]'], await sim(build(0n))) as [bigint[]];
    return amounts[0] === AMOUNT_IN && amounts[1] === expected ? ok('dry.swap.eth-for-usdc', `0.1 ETH -> ${amounts[1]} USDC units; matches our math exactly at block ${block}`) : bad('dry.swap.eth-for-usdc', `router returned ${amounts[0]}/${amounts[1]}, our math expects ${AMOUNT_IN}/${expected}`);
  });
  await guard('dry.minout.exact', async () => { await sim(build(expected)); return ok('dry.minout.exact', 'amountOutMin equal to the quote is accepted (boundary)'); });
  await expectRevert('dry.minout.guard', build(expected + 1n), 'INSUFFICIENT_OUTPUT_AMOUNT', 'amountOutMin one unit above the quote');
  await expectRevert('dry.deadline.expired', build(0n, { deadline: ts - 1n }), 'EXPIRED', 'deadline in the past');
  await guard('dry.fee-on-transfer.variant', async () => { const r = await sim(build(0n, { fot: true })); return ok('dry.fee-on-transfer.variant', `SupportingFeeOnTransferTokens variant executes without revert (returns ${r === '0x' ? 'no data, as designed' : r})`); });
  await guard('dry.gas', async () => {
    const t = build(0n); const g = BigInt(await rpc.call<string>('eth_estimateGas', [{ from: FROM, to: t.to, data: t.data, value: hex(t.value) }, blockHex, override]));
    return g >= 60_000n && g <= 400_000n ? ok('dry.gas', `estimated gas ${g} (plausible range 60k-400k for a single-hop V2 swap)`) : bad('dry.gas', `estimated gas ${g} is outside the plausible range; investigate before trusting fee previews`);
  });
  await guard('dry.approval.plan', async () => {
    const a = erc20.allowance(usdc, FROM, router); const allowance = erc20.decodeUint(await read(a.to, a.data));
    const txs = planApproval(usdc, router, 1_000_000n, allowance); let refused = false; try { planApproval(usdc, router, MAX_UINT256, 0n); } catch { refused = true; }
    return allowance === 0n && txs.length === 1 && refused ? ok('dry.approval.plan', 'fresh sender has allowance 0; plan is one approve for exactly the amount; unlimited approval is refused') : bad('dry.approval.plan', `allowance ${allowance}, txs ${txs.length}, unlimited refused ${refused}`);
  });
  checks.push({ id: 'dry.sell-leg', status: 'skipped', detail: 'USDC -> ETH needs a token balance override, which depends on the token storage layout (not verified). Selling is covered by fork tests later.' });
  return { checks, block };
}
