import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSolTokens, looksLikeMint, mintFacts } from '../src/search.ts';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', WSOL = 'So11111111111111111111111111111111111111112', FAKE = '9NfAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEfa';
const fakeFetch = (routes: Record<string, unknown>) => (async (url: string) => { const k = Object.keys(routes).find(x => String(url).startsWith(x)); if (!k) return { ok: false, status: 404, json: async () => ({}) }; const v = routes[k]; if (v instanceof Error) throw v; return { ok: true, status: 200, json: async () => v }; }) as unknown as typeof fetch;

test('mint detection accepts real addresses and rejects text', () => { assert.ok(looksLikeMint(BONK)); assert.equal(looksLikeMint('bonk'), false); assert.equal(looksLikeMint('0x' + 'a'.repeat(40)), false); });

test('search merges Jupiter and DexScreener by mint, keeps the larger liquidity, and drops non-Solana pairs', async () => {
  const f = fakeFetch({
    'https://lite-api.jup.ag/tokens/v2/search': [{ id: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', usdPrice: 0.0000023, liquidity: 5_000_000, holderCount: 1000 }],
    'https://api.dexscreener.com/latest/dex/search': { pairs: [{ chainId: 'solana', dexId: 'orca', pairAddress: 'P1', baseToken: { address: BONK, name: 'Bonk', symbol: 'Bonk' }, quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' }, priceUsd: '0.0000023', liquidity: { usd: 226_000 }, volume: { h24: 157_000 } }, { chainId: 'ethereum', dexId: 'uniswap', pairAddress: 'E', baseToken: { address: '0xabc', symbol: 'BONK', name: 'x' }, quoteToken: { address: '0xdef', symbol: 'WETH', name: 'y' } }, { chainId: 'solana', dexId: 'raydium', pairAddress: 'P2', baseToken: { address: FAKE, name: 'Bonk', symbol: 'BONK' }, quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' }, liquidity: { usd: 90 } }] },
  });
  const { hits, errors } = await searchSolTokens('bonk', { fetchFn: f }); assert.deepEqual(errors, []);
  assert.equal(hits.length, 1 + (looksLikeMint(FAKE) ? 1 : 0)); assert.equal(hits[0].mint, BONK); assert.equal(hits[0].liquidityUsd, 5_000_000); assert.deepEqual(hits[0].sources.sort(), ['dexscreener', 'jupiter']); assert.equal(hits[0].pairs[0].dex, 'orca'); assert.equal(hits[0].decimals, 5);
});

test('a failing source is skipped and named, and the other still answers; HTML-ish text is stripped', async () => {
  const f = fakeFetch({ 'https://lite-api.jup.ag/tokens/v2/search': new Error('boom'), 'https://api.dexscreener.com/latest/dex/search': { pairs: [{ chainId: 'solana', dexId: 'orca', pairAddress: 'P1', baseToken: { address: BONK, name: '<b>Bonk</b>\n', symbol: 'BO<NK' }, quoteToken: { address: WSOL, symbol: 'SOL', name: 'W' }, liquidity: { usd: 5 } }] } });
  const { hits, errors } = await searchSolTokens('bonk', { fetchFn: f }); assert.equal(errors.length, 1); assert.match(errors[0], /jupiter/); assert.equal(hits[0].name, 'bBonk/b'); assert.equal(hits[0].symbol, 'BONK');
});

test('mint facts decode supply, decimals and authorities, and warn about them', async () => {
  const d = Buffer.alloc(82); d.writeUInt32LE(1, 0); Buffer.alloc(32, 7).copy(d, 4); d.writeBigUInt64LE(1_000_000n, 36); d[44] = 6; d[45] = 1; d.writeUInt32LE(0, 46);
  const rpc = { call: async () => ({ value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [d.toString('base64'), 'base64'] } }) } as any;
  const f = await mintFacts(rpc, BONK); assert.equal(f.decimals, 6); assert.equal(f.supply, 1_000_000n); assert.ok(f.mintAuthority); assert.equal(f.freezeAuthority, null); assert.ok(f.warnings.some(w => /mint authority/.test(w)));
  const none = await mintFacts({ call: async () => ({ value: null }) } as any, BONK); assert.equal(none.exists, false);
  const notMint = await mintFacts({ call: async () => ({ value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } }) } as any, BONK); assert.ok(notMint.warnings[0].includes('not a token mint'));
});
