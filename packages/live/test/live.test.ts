import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCall, encodeParams, getAmountOut } from '../../evm/src/index.ts';
import { ETH, SOL } from '../src/config.ts';
import { Rpc } from '../src/rpc.ts';
import { main } from '../src/run.ts';

// MOCK provider: tests the harness logic only. It proves nothing about mainnet.
const WETH = '0x' + 'ee'.repeat(20), PAIR = '0x' + 'dd'.repeat(20), KEY = 'SUPERSECRETKEY123';
const R0 = 5_000n * 10n ** 18n, R1 = 15_000_000n * 10n ** 6n;
const DUMMY: Record<string, any[]> = { 'getPair(address,address)': [WETH, WETH], 'getAmountsOut(uint256,address[])': [1n, [WETH]] };
const sel = (sig: string) => encodeCall(sig, DUMMY[sig] ?? []).slice(0, 10);
function evm(m: string, p: any[], opt: { routerQuoteDelta?: bigint; chain?: string } = {}) {
  if (m === 'eth_chainId') return opt.chain ?? '0x1'; if (m === 'eth_blockNumber') return '0x10'; if (m === 'eth_getCode') return '0x6080';
  const { to, data } = p[0]; const s = data.slice(0, 10);
  if (s === sel('factory()')) return encodeParams(['address'], [ETH.uniswapV2Factory.address]);
  if (s === sel('WETH()')) return encodeParams(['address'], [WETH]);
  if (s === sel('getPair(address,address)')) return encodeParams(['address'], [PAIR]);
  if (s === sel('token0()')) return encodeParams(['address'], [WETH]);
  if (s === sel('getReserves()')) return encodeParams(['uint256', 'uint256', 'uint256'], [R0, R1, 1n]);
  if (s === sel('getAmountsOut(uint256,address[])')) return encodeParams(['uint256[]'], [[10n ** 18n, getAmountOut(10n ** 18n, R0, R1) + (opt.routerQuoteDelta ?? 0n)]]);
  throw new Error('unexpected call ' + s);
}
function sol(m: string, p: any[]) {
  if (m === 'getVersion') return { 'solana-core': '9.9.9' }; if (m === 'getGenesisHash') return 'GENESIS'; if (m === 'getSlot') return 123;
  if (m === 'getAccountInfo') return { value: p[0] === SOL.programs[2].address ? { executable: false, owner: 'x' } : { executable: true, owner: 'BPFLoader' } };
}
const mk = (opt = {}, status = 200) => (async (url: any, init: any) => { const b = JSON.parse(init.body); let result;
  try { result = String(url).includes('solana') ? sol(b.method, b.params) : evm(b.method, b.params, opt); } catch (e) { return Response.json({ jsonrpc: '2.0', id: b.id, error: { message: (e as Error).message + ' at ' + url } }); }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }), { status }); }) as typeof fetch;
const run = async (f: typeof fetch, args: string[] = [], env: any = { ALCHEMY_API_KEY: KEY }) => { const dir = mkdtempSync(join(tmpdir(), 'live-')); let out = ''; const code = await main(env, args, f, s => (out += s), dir, 0); return { code, out, file: readdirSync(dir).length ? readFileSync(join(dir, readdirSync(dir)[0]), 'utf8') : '' }; };

test('refuses to run without a key and explains how to set it', async () => { const r = await run(mk(), [], {}); assert.equal(r.code, 2); assert.match(r.out, /export ALCHEMY_API_KEY/); });
test('ethereum checks pass against a consistent mock; unconfigured items are reported as skipped', async () => {
  const r = await run(mk(), ['--only', 'eth']); assert.equal(r.code, 0, r.out); assert.match(r.out, /PASS \| eth.quote.matches-router/); assert.match(r.out, /SKIPPED \| eth.unconfigured/);
});
test('a router quote that differs from our math FAILS the run', async () => { const r = await run(mk({ routerQuoteDelta: 1n }), ['--only', 'eth']); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| eth.quote.matches-router/); });
test('wrong chain id fails', async () => { const r = await run(mk({ chain: '0x38' }), ['--only', 'eth']); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| eth.chainId/); });
test('solana: executable programs pass, non-executable fails, unconfigured ids are skipped', async () => {
  const r = await run(mk(), ['--only', 'sol']); assert.equal(r.code, 1); assert.match(r.out, /PASS \| sol.program.Raydium AMM v4/); assert.match(r.out, /FAIL \| sol.program.Raydium CLMM/); assert.match(r.out, /SKIPPED \| sol.unconfigured/);
});
test('the API key never appears in output, report file, or error messages', async () => {
  const leaky = mk({}); const wrapped = (async (u: any, i: any) => { const res = await leaky(u, i); const b = JSON.parse(i.body); if (b.method === 'eth_getCode') return Response.json({ jsonrpc: '2.0', id: 1, error: { message: `denied for ${u}` } }); return res; }) as typeof fetch;
  const r = await run(wrapped, ['--only', 'eth']); assert.ok(!r.out.includes(KEY) && !r.file.includes(KEY)); assert.match(r.out, /\*\*\*/);
});
test('rpc client only allows read-only methods', async () => { const rpc = new Rpc('https://x/v2/k', 'k', mk()); await assert.rejects(rpc.call('eth_sendRawTransaction', ['0x']), /not on the read-only allowlist/); await assert.rejects(rpc.call('sendTransaction', []), /allowlist/); });
test('rate limiting (429) is retried with backoff, then reported clearly', async () => {
  let n = 0; const f = (async () => { n++; return new Response('{}', { status: 429 }); }) as typeof fetch;
  await assert.rejects(new Rpc('https://x/v2/k', 'k', f, 0).call('eth_blockNumber'), /rate limited/); assert.equal(n, 4);
});

test('two runs on the same day write two separate report files (evidence is never overwritten)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-')); const f = mk();
  await main({ ALCHEMY_API_KEY: KEY }, ['--only', 'sol'], f, () => {}, dir, 0); await new Promise(r => setTimeout(r, 5));
  await main({ ALCHEMY_API_KEY: KEY }, ['--only', 'eth'], f, () => {}, dir, 0);
  assert.equal(readdirSync(dir).length, 2);
});
