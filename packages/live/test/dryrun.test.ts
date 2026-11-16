import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCall, encodeParams, decodeParams, getAmountOut } from '../../evm/src/index.ts';
import { ETH } from '../src/config.ts';
import { main } from '../src/run.ts';

// MOCK provider: tests harness logic only. The real result comes from `npm run verify:live -- --only eth --dry-run`.
const WETH = '0x' + 'ee'.repeat(20), PAIR = '0x' + 'dd'.repeat(20), KEY = 'SECRETKEY-XYZ';
const R0 = 5_000n * 10n ** 18n, R1 = 15_000_000n * 10n ** 6n;
const D: Record<string, any[]> = { 'getPair(address,address)': [WETH, WETH], 'getAmountsOut(uint256,address[])': [1n, [WETH]], 'allowance(address,address)': [WETH, WETH],
  'swapExactETHForTokens(uint256,address[],address,uint256)': [0n, [WETH], WETH, 0n], 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)': [0n, [WETH], WETH, 0n] };
const sel = (sig: string) => encodeCall(sig, D[sig] ?? []).slice(0, 10);
const quote = getAmountOut(10n ** 17n, R0, R1);
function evm(m: string, p: any[], o: { gas?: string; skewQuote?: bigint; noMinGuard?: boolean }) {
  if (m === 'eth_chainId') return '0x1'; if (m === 'eth_blockNumber') return '0x10'; if (m === 'eth_getBlockByNumber') return { timestamp: '0x65000000' };
  if (m === 'eth_getCode') return String(p[0]).toLowerCase() === '0x1234567890123456789012345678901234567890' ? '0x' : '0x6080';
  if (m === 'eth_estimateGas') return o.gas ?? '0x30d40';
  const { data } = p[0]; const s = data.slice(0, 10);
  if (s === sel('factory()')) return encodeParams(['address'], [ETH.uniswapV2Factory.address]);
  if (s === sel('getAmountsOut(uint256,address[])')) return encodeParams(['uint256[]'], [[10n ** 18n, getAmountOut(10n ** 18n, R0, R1)]]);
  if (s === sel('WETH()')) return encodeParams(['address'], [WETH]); if (s === sel('getPair(address,address)')) return encodeParams(['address'], [PAIR]);
  if (s === sel('token0()')) return encodeParams(['address'], [WETH]); if (s === sel('getReserves()')) return encodeParams(['uint256', 'uint256', 'uint256'], [R0, R1, 1n]);
  if (s === sel('allowance(address,address)')) return encodeParams(['uint256'], [0n]);
  const fot = s === sel('swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)');
  if (s === sel('swapExactETHForTokens(uint256,address[],address,uint256)') || fot) {
    const [min, , , dl] = decodeParams(['uint256', 'address[]', 'address', 'uint256'], '0x' + data.slice(10)) as bigint[];
    if (dl < 0x65000000n) throw new Error('execution reverted: UniswapV2Router: EXPIRED');
    const out = quote + (o.skewQuote ?? 0n); if (!o.noMinGuard && min > out) throw new Error('execution reverted: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT');
    return fot ? '0x' : encodeParams(['uint256[]'], [[10n ** 17n, out]]);
  }
  throw new Error('unexpected call ' + s);
}
const mk = (o = {}) => (async (url: any, init: any) => { const b = JSON.parse(init.body); try { return Response.json({ jsonrpc: '2.0', id: b.id, result: evm(b.method, b.params, o) }); } catch (e) { return Response.json({ jsonrpc: '2.0', id: b.id, error: { message: (e as Error).message } }); } }) as typeof fetch;
const run = async (o = {}) => { let out = ''; const code = await main({ ALCHEMY_API_KEY: KEY }, ['--only', 'eth', '--dry-run'], mk(o), s => (out += s), mkdtempSync(join(tmpdir(), 'dry-')), 0); return { code, out }; };

test('dry-run passes against a consistent mock and never leaves the read-only allowlist', async () => {
  const r = await run(); assert.equal(r.code, 0, r.out);
  for (const id of ['dry.swap.eth-for-usdc', 'dry.minout.exact', 'dry.minout.guard', 'dry.deadline.expired', 'dry.fee-on-transfer.variant', 'dry.gas', 'dry.approval.plan']) assert.match(r.out, new RegExp(`PASS \\| ${id.replace('.', '\\.')}`));
  assert.match(r.out, /SKIPPED \| dry.sell-leg/); assert.ok(!r.out.includes(KEY));
});
test('router output that differs from our math fails the dry-run', async () => { const r = await run({ skewQuote: 5n }); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| dry.swap.eth-for-usdc/); });
test('a router that does NOT enforce amountOutMin is caught', async () => { const r = await run({ noMinGuard: true }); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| dry.minout.guard/); });
test('implausible gas estimate fails instead of feeding bad fee previews', async () => { const r = await run({ gas: '0x10' }); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| dry.gas/); });
