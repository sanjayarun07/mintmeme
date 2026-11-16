import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRealMarkets } from '../src/realmarkets.ts';
import { Rpc } from '../src/rpc.ts';
import { ETH, BSC, SOL } from '../src/config.ts';

const PAIR = '0x' + 'a1'.repeat(20), FAKE = '0x' + 'b2'.repeat(20), SOLPOOL = 'So1Pool11111111111111111111111111111111111';
const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
const pair = (id: string, addr: string, liq: number, created = Date.now() - 3 * 3600_000) => ({ chainId: 'x', pairAddress: addr, baseToken: { address: id, name: 'Tok' + id.slice(2, 5), symbol: 'T' + id.slice(2, 4) }, quoteToken: { address: '0x' + 'c3'.repeat(20), name: 'Wrapped BNB', symbol: 'WBNB' }, priceUsd: '0.5', priceChange: { h24: 12 }, liquidity: { usd: liq }, volume: { h24: 900 }, txns: { h24: { buys: 4, sells: 2 } }, fdv: 1000, marketCap: 900, pairCreatedAt: created });
const T1 = '0x' + '11'.repeat(20), T2 = '0x' + '22'.repeat(20), S1 = 'SoLTok111111111111111111111111111111111111';
function deps(calls: any[]) {
  const fetchFn = (async (u: string) => {
    const body = (x: any) => ({ ok: true, status: 200, json: async () => x });
    if (u.includes('token-boosts/top')) return body([{ chainId: 'bsc', tokenAddress: T1 }, { chainId: 'bsc', tokenAddress: T2 }, { chainId: 'solana', tokenAddress: S1 }, { chainId: 'base', tokenAddress: '0xzz' }]);
    if (u.includes('/search')) return body({ pairs: [] });
    if (u.includes('token-profiles') || u.includes('boosts/latest')) return body([]);
    if (u.includes('/tokens/v1/bsc/')) return body([pair(T1, PAIR, 5000), pair(T2, FAKE, 90000)]);
    if (u.includes('/tokens/v1/solana/')) return body([pair(S1, SOLPOOL, 7000)]);
    throw new Error('unexpected ' + u);
  }) as any;
  const mk = (handler: (m: string, p: any[]) => any) => new Rpc('http://x', 'KEY', (async (_u: string, init: any) => { const j = JSON.parse(init.body); calls.push(j); const r = handler(j.method, j.params); return { status: 200, ok: true, json: async () => ({ result: r }) }; }) as any, 0);
  return { fetchFn, geckoGapMs: 0, rpc: {
    ethereum: mk(() => { throw new Error('ethereum must not be called'); }),
    bsc: mk((m, p) => { if (m !== 'eth_call' || p[0].to !== BSC.pancakeV2Factory.address) throw new Error('execution reverted (not a factory call)'); assert.ok(p[0].data.startsWith('0xe6a43905')); return p[0].data.includes('11'.repeat(20)) ? pad(PAIR) : pad('0x' + '00'.repeat(20)); }),
    sol: mk((m, p) => { assert.equal(m, 'getAccountInfo'); return { value: { owner: SOL.programs[0].address, space: 752 } }; }) } };
}

test('only a pool the official factory returns is verified; a spoofed pair is shown but flagged', async () => {
  const calls: any[] = []; const r = await loadRealMarkets({ ...deps(calls), now: () => Date.now() });
  const by = (c: string) => r.tokens.filter(t => t.chain === c);
  const t1 = r.tokens.find(t => t.contract === T1)!, t2 = r.tokens.find(t => t.contract === T2)!;
  assert.equal(t1.verified, true); assert.equal(t1.venue, 'PancakeSwap V2'); assert.equal(t2.verified, false); assert.match(t2.findings[0].text, /not an official PancakeSwap V2 pool/);
  assert.equal(by('bnb').length, 2); assert.equal(by('solana').length, 1); assert.equal(by('solana')[0].verified, true); assert.equal(by('solana')[0].venue, 'Raydium AMM v4');
  assert.equal(r.tokens.some(t => (t as any).chain === 'base'), false, 'unsupported chains are dropped');
  assert.ok(t1.real && t1.col === 'new' && t1.tokenAge >= 179 && t1.tokenAge <= 181, 'a 3h-old pool is "new"'); assert.deepEqual(r.tokens.map(t => t.liq), [7000, 5000, 90000], 'verified first, then by liquidity');
  assert.ok(calls.every(c => ['eth_call', 'getAccountInfo', 'eth_blockNumber', 'eth_getLogs'].includes(c.method)), 'only read methods were sent');
});

test('an RPC failure on one pool flags it instead of failing the whole list', async () => {
  const d = deps([]); d.rpc.bsc = new Rpc('http://x', 'KEY', (async () => ({ status: 500, ok: false })) as any, 0);
  const r = await loadRealMarkets(d); const t = r.tokens.find(t => t.contract === T1)!;
  assert.equal(t.verified, false); assert.match(t.findings[0].text, /Could not check this pool on-chain/); assert.equal(r.tokens.find(t => t.chain === 'solana')!.verified, true);
});

test('a dead market-data feed yields an empty list with a note, never an exception', async () => {
  const d = deps([]); const r = await loadRealMarkets({ ...d, fetchFn: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any });
  assert.equal(r.tokens.length, 0); assert.ok(r.notes.length >= 1);
});
test('config: BSC values carry their official source', () => { assert.equal(BSC.chainIdExpected, 56n); assert.match(BSC.pancakeV2Factory.source, /developer\.pancakeswap\.finance/); assert.equal(ETH.chainIdExpected, 1n); });

import { decodeCurve, pumpDiscriminator, bondingCurveAddress, readFour, discoverFour, PAD } from '../src/launchpads.ts';
import { spawnSync } from 'node:child_process';
import { keccakHex } from '../../evm/src/keccak.ts';

test('pump.fun: discriminator is the sha256 of the account name and matches the official IDL value; the curve layout decodes', () => {
  assert.deepEqual([...pumpDiscriminator()], [23, 183, 248, 55, 96, 216, 172, 96]);
  const b = Buffer.alloc(80); pumpDiscriminator().copy(b, 0); b.writeBigUInt64LE(1000n, 8); b.writeBigUInt64LE(2000n, 16); b.writeBigUInt64LE(300n, 24); b.writeBigUInt64LE(400n, 32); b.writeBigUInt64LE(1000n, 40); b[48] = 1;
  assert.deepEqual(decodeCurve(b), { virtualToken: 1000n, virtualQuote: 2000n, realToken: 300n, realQuote: 400n, totalSupply: 1000n, complete: true });
  b[0] ^= 1; assert.equal(decodeCurve(b), null, 'a wrong discriminator is not a bonding curve'); assert.equal(decodeCurve(Buffer.alloc(10)), null);
  assert.match(bondingCurveAddress('So11111111111111111111111111111111111111112'), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test('four.meme: getTokenInfo selector matches Foundry; progress is funds/maxFunds; a revert means "not a Four.meme token"', async () => {
  const cast = spawnSync('cast', ['sig', 'getTokenInfo(address)'], { encoding: 'utf8' }); if (cast.status === 0) assert.equal(cast.stdout.trim(), keccakHex('getTokenInfo(address)').slice(0, 10));
  const w = (n: bigint | string) => (typeof n === 'string' ? n.replace('0x', '').padStart(64, '0') : n.toString(16).padStart(64, '0'));
  const ok = '0x' + [2n, PAD.fourMeme.tokenManager2, '0x' + '00'.repeat(20), 5n, 1n, 1n, 1_700_000_000n, 600n, 1000n, 250n, 1000n, 0n].map(x => w(x as any)).join('');
  const mk = (h: (p: any) => any) => new Rpc('http://x', 'K', (async (_u: string, init: any) => { const j = JSON.parse(init.body); const r = h(j); if (r instanceof Error) return { status: 200, ok: true, json: async () => ({ error: { message: 'execution reverted' } }) }; return { status: 200, ok: true, json: async () => ({ result: r }) }; }) as any, 0);
  const i = await readFour(mk(j => { assert.equal(j.params[0].to, PAD.fourMeme.helper3); return ok; }), '0x' + '77'.repeat(20));
  assert.equal(i!.pct, 25); assert.equal(i!.liquidityAdded, false); assert.equal(i!.version, 2);
  assert.equal(await readFour(mk(() => new Error('revert')), '0x' + '88'.repeat(20)), null);
  assert.equal(await readFour(mk(() => '0x' + '00'.repeat(64 * 12 / 2 * 2).slice(0, 64 * 12)), '0x' + '99'.repeat(20)), null, 'all-zero info = unknown token');
});

test('four.meme: TokenCreate events are decoded (token, name, symbol) newest first', async () => {
  const enc = (s: string) => w(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
  function w(n: bigint | string) { return (typeof n === 'string' ? n.replace('0x', '') : n.toString(16)).padStart(64, '0'); }
  const mkLog = (token: string, name: string, sym: string, blk: number) => ({ blockNumber: '0x' + blk.toString(16), data: '0x' + [w('0x' + 'aa'.repeat(20)), w(token), w(1n), w(256n), w(320n), w(1000n), w(5n), w(0n)].join('') + enc(name) + enc(sym) });
  const logs = [mkLog('0x' + '01'.repeat(20), 'First', 'ONE', 100), mkLog('0x' + '02'.repeat(20), 'Second Coin', 'TWO', 101)];
  const rpc = new Rpc('http://x', 'K', (async (_u: string, init: any) => { const j = JSON.parse(init.body); const r = j.method === 'eth_blockNumber' ? '0x2710' : j.method === 'eth_getLogs' ? logs : null; if (j.method === 'eth_getLogs') { assert.equal(j.params[0].address, PAD.fourMeme.tokenManager2); } return { status: 200, ok: true, json: async () => ({ result: r }) }; }) as any, 0);
  const got = await discoverFour(rpc, 5, 100, 100);
  assert.deepEqual(got.map(g => [g.symbol, g.name, g.token, g.block]), [['TWO', 'Second Coin', '0x' + '02'.repeat(20), 101], ['ONE', 'First', '0x' + '01'.repeat(20), 100]]);
});

// ---- GeckoTerminal as a second candidate source ----
const T3 = '0x' + '33'.repeat(20);
function withGecko(gecko: (u: string) => any, seen: string[]) {
  const d = deps([]); const base = d.fetchFn as any;
  const fetchFn = (async (u: string, ...r: any[]) => {
    seen.push(u);
    if (u.includes('geckoterminal')) return gecko(u);
    if (u.includes('/tokens/v1/bsc/') && u.includes(T3)) return { ok: true, status: 200, json: async () => [pair(T3, '0x' + 'd4'.repeat(20), 8000)] };
    return base(u, ...r);
  }) as any;
  return { ...d, fetchFn };
}
const geckoBody = (ids: string[]) => ({ ok: true, status: 200, json: async () => ({ data: ids.map(id => ({ relationships: { base_token: { data: { id } } } })) }) });

test('GeckoTerminal tokens are added as candidates and still pass the on-chain pool check', async () => {
  const seen: string[] = []; const r = await loadRealMarkets(withGecko(u => geckoBody(u.includes('/bsc/') && u.includes('trending') ? ['bsc_' + T3] : []), seen));
  const t3 = r.tokens.find(t => t.contract === T3)!; assert.ok(t3, 'a token only GeckoTerminal listed shows up');
  assert.equal(t3.verified, false, 'not trusted just because a market list has it: the factory did not return its pool'); assert.match(t3.findings[0].text, /not an official PancakeSwap V2 pool/);
  assert.ok(seen.some(u => u.includes('geckoterminal.com/api/v2/networks/solana/trending_pools')) && seen.some(u => u.includes('/networks/eth/pools')), 'asks for trending and top pools on all three networks');
});
test('candidates are looked up in batches of at most 30 addresses', async () => {
  const seen: string[] = []; const many = Array.from({ length: 70 }, (_, i) => 'bsc_0x' + (i + 16).toString(16).padStart(2, '0').repeat(20));
  await loadRealMarkets(withGecko(u => geckoBody(u.includes('/bsc/') && u.includes('trending') ? many : []), seen));
  const calls = seen.filter(u => u.includes('/tokens/v1/bsc/')); assert.ok(calls.length >= 3);
  for (const u of calls) assert.ok(u.split('/tokens/v1/bsc/')[1].split(',').length <= 30, 'never more than 30 per call');
});
test('GeckoTerminal rate limiting is reported, stops after two failures, and the rest of the list still loads', async () => {
  const seen: string[] = []; const r = await loadRealMarkets(withGecko(() => ({ ok: false, status: 429, json: async () => ({}) }), seen));
  assert.equal(seen.filter(u => u.includes('geckoterminal')).length, 2, 'does not hammer a service that is refusing us');
  assert.ok(r.notes.some(n => /GeckoTerminal.*429/.test(n))); assert.ok(r.tokens.length >= 3, 'DexScreener results are unaffected');
});
test('a recent good GeckoTerminal list is reused when the service rate-limits us later', async () => {
  const memo = new Map<string, { at: number; addrs: string[] }>(); let limited = false;
  const g = (u: string) => limited ? { ok: false, status: 429, json: async () => ({}) } : geckoBody(u.includes('/bsc/') && u.includes('trending') ? ['bsc_' + T3] : []);
  await loadRealMarkets({ ...withGecko(g, []), geckoMemo: memo }); assert.ok(memo.get('bsc:trending_pools')?.addrs.includes(T3));
  limited = true; const r = await loadRealMarkets({ ...withGecko(g, []), geckoMemo: memo });
  assert.ok(r.tokens.some(t => t.contract === T3), 'still listed from the saved list'); assert.ok(r.notes.some(n => /429.*using the list from/.test(n)));
});
