import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOL, SOL_POOL, AMM_V4_LAYOUT as L } from '../src/config.ts';
import { base58, decodePoolState, quoteOut } from '../src/solpool.ts';
import { main } from '../src/run.ts';

// MOCK provider and mock Raydium API: tests decoding and comparison logic only.
const KEY = 'SOLKEY-123';
const unb58 = (s: string) => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); let h = n.toString(16); if (h.length % 2) h = '0' + h; const b = Buffer.from(h, 'hex'); const z = [...s].findIndex(c => c !== '1'); return Buffer.concat([Buffer.alloc(z < 0 ? s.length : z), b]); };
const V_BASE = base58(Buffer.alloc(32, 7)), V_QUOTE = base58(Buffer.alloc(32, 8)), LP = base58(Buffer.alloc(32, 9)), OO = base58(Buffer.alloc(32, 10));   // arbitrary distinct 32-byte fixture keys
function pool(o: { size?: number } = {}) {
  const b = Buffer.alloc(o.size ?? L.size); const put = (off: number, v: bigint) => b.writeBigUInt64LE(v, off);
  put(L.status, 6n); put(L.baseDecimal, 9n); put(L.quoteDecimal, 6n); put(L.swapFeeNumerator, 25n); put(L.swapFeeDenominator, 10_000n); put(L.baseNeedTakePnl, 1_000_000n); put(L.quoteNeedTakePnl, 50_000n);
  const pk = (off: number, s: string) => unb58(s).copy(b, off + 32 - unb58(s).length);
  pk(L.baseVault, V_BASE); pk(L.quoteVault, V_QUOTE); pk(L.baseMint, SOL_POOL.wsol.mint); pk(L.quoteMint, SOL_POOL.usdc.mint); pk(L.lpMint, LP); pk(L.openOrders, OO); return b;
}
const BASE_BAL = 100_000n * 10n ** 9n + 1_000_000n, QUOTE_BAL = 8_000_000n * 10n ** 6n + 50_000n;   // effective reserves: 100,000 SOL / 8,000,000 USDC => price 80
const OURS = quoteOut(10n ** 9n, 100_000n * 10n ** 9n, 8_000_000n * 10n ** 6n, 25n, 10_000n);
function fetcher(o: { owner?: string; apiPrice?: number; apiOut?: bigint; size?: number; vaultMint?: string } = {}) {
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('raydium.io/pools/info/ids')) return Response.json({ success: true, data: [{ price: o.apiPrice ?? 80 }] });
    if (u.includes('compute/swap-base-in')) return Response.json({ success: true, data: { outputAmount: String(o.apiOut ?? OURS) } });
    const b = JSON.parse(init.body); const [addr, cfg] = b.params ?? [];
    const res = (result: any) => Response.json({ jsonrpc: '2.0', id: b.id, result });
    if (b.method === 'getSlot') return res(777); if (b.method === 'getVersion') return res({ 'solana-core': 'mock' }); if (b.method === 'getGenesisHash') return res('MOCKGENESIS');
    if (b.method === 'getAccountInfo') {
      if (addr === SOL_POOL.id) return res({ value: { owner: o.owner ?? SOL.programs[0].address, data: [pool({ size: o.size }).toString('base64'), 'base64'] } });
      if (SOL.programs.some(p => p.address === addr)) return res({ value: { executable: true, owner: 'BPFLoader' } });
      const isBase = addr === V_BASE; return res({ value: { data: { parsed: { info: { mint: o.vaultMint ?? (isBase ? SOL_POOL.wsol.mint : SOL_POOL.usdc.mint), tokenAmount: { amount: String(isBase ? BASE_BAL : QUOTE_BAL) } } } } } });
    }
    return Response.json({ jsonrpc: '2.0', id: b.id, error: { message: 'unexpected ' + b.method } });
  }) as typeof fetch;
}
const run = async (o = {}) => { let out = ''; const code = await main({ ALCHEMY_API_KEY: KEY }, ['--only', 'sol', '--pools'], fetcher(o), s => (out += s), mkdtempSync(join(tmpdir(), 'sp-')), 0); return { code, out }; };

test('base58 round-trips and decodes known 32-byte keys', () => { assert.equal(base58(unb58(SOL_POOL.usdc.mint)), SOL_POOL.usdc.mint); assert.equal(base58(Buffer.alloc(32)).length, 32); });
test('pool decoder reads fields at the sourced offsets and refuses a wrong size', () => {
  const s = decodePoolState(pool()); assert.equal(s.baseDecimal, 9); assert.equal(s.swapFeeNum, 25n); assert.equal(s.baseMint, SOL_POOL.wsol.mint); assert.equal(s.quoteVault, V_QUOTE);
  assert.throws(() => decodePoolState(pool({ size: 700 })), /layout mismatch/);
});
test('pool reads pass when on-chain data and the benchmark agree', async () => { const r = await run(); assert.equal(r.code, 0, r.out); for (const id of ['pool.account', 'pool.mints', 'pool.vaults', 'pool.reserves', 'pool.price.vs-raydium-api', 'pool.quote.vs-raydium-api']) assert.match(r.out, new RegExp(`PASS \\| ${id.replace(/\./g, '\\.')}`)); assert.match(r.out, /SKIPPED \| pool.swap-instruction/); });
test('wrong owner program fails and stops before decoding', async () => { const r = await run({ owner: SOL.programs[1].address }); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| pool.account/); assert.doesNotMatch(r.out, /pool.mints/); });
test('unexpected account size fails rather than decoding garbage', async () => { const r = await run({ size: 600 }); assert.equal(r.code, 1); assert.match(r.out, /layout mismatch/); });
test('a vault holding the wrong mint fails', async () => { const r = await run({ vaultMint: LP }); assert.equal(r.code, 1); assert.match(r.out, /FAIL \| pool.vaults/); });
test('price more than 1% from the benchmark fails; quote deviation fails', async () => {
  assert.match((await run({ apiPrice: 90 })).out, /FAIL \| pool.price.vs-raydium-api/);
  assert.match((await run({ apiOut: OURS * 105n / 100n })).out, /FAIL \| pool.quote.vs-raydium-api/);
});
