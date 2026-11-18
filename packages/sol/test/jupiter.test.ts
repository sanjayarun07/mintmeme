import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJupiterQuote, quoteGapBps, JupiterStockPrices } from '../src/index.ts';

const SOLM = 'So11111111111111111111111111111111111111112', USDCM = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const good = { inputMint: SOLM, inAmount: '1000000000', outputMint: USDCM, outAmount: '73640575', otherAmountThreshold: '73272373', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.00001', contextSlot: 469384777,
  routePlan: [{ swapInfo: { ammKey: 'amm1', label: 'Raydium' }, percent: 100 }] };
const fake = (body: unknown, status = 200) => { const f: any = async (url: any) => { f.last = String(url); return new Response(JSON.stringify(body), { status }); }; return f as typeof fetch & { last?: string }; };
const ask = (f: typeof fetch, o: object = {}) => fetchJupiterQuote({ inputMint: SOLM, outputMint: USDCM, amount: 1_000_000_000n, fetchFn: f, ...o });

test('a well-formed quote is parsed into bigint amounts and the route; the request carries mints, amount and slippage', async () => {
  const f: any = fake(good); const q = await ask(f, { slippageBps: 50 });
  assert.equal(q.outAmount, 73_640_575n); assert.equal(q.minOut, 73_272_373n); assert.equal(q.route[0].label, 'Raydium'); assert.ok(q.priceImpactPct < 0.001);
  assert.match(f.last, /inputMint=So1111/); assert.match(f.last, /amount=1000000000/); assert.match(f.last, /slippageBps=50/);
  assert.equal(quoteGapBps(73_000_000n, q), Number((73_640_575n - 73_000_000n) * 10_000n / 73_640_575n));
});

test('anything off is refused: other pair, other amount, bad numbers, inconsistent threshold, API error, HTTP failure, non-positive amount', async () => {
  await assert.rejects(ask(fake({ ...good, outputMint: 'x' })), /different pair/);
  await assert.rejects(ask(fake({ ...good, inAmount: '5' })), /we asked for/);
  await assert.rejects(ask(fake({ ...good, outAmount: '12.5' })), /not an integer/);
  await assert.rejects(ask(fake({ ...good, otherAmountThreshold: '99999999999' })), /inconsistent/);
  await assert.rejects(ask(fake({ ...good, swapMode: 'ExactOut' })), /swap mode/);
  await assert.rejects(ask(fake({ ...good, priceImpactPct: 'abc' })), /not a number/);
  await assert.rejects(ask(fake({ error: 'Could not find any route' })), /Could not find any route/);
  await assert.rejects(ask(fake({}, 500)), /HTTP 500/);
  await assert.rejects(ask(fake(good), { amount: 0n }), /positive/);
});

test('Jupiter API key: sent as x-api-key to the keyed host (quotes and the Price API); without one, the keyless host and no header', async () => {
  const seen: { url: string; key?: string }[] = [];
  const rec = (body: unknown) => (async (url: any, init: any = {}) => { seen.push({ url: String(url), key: init.headers?.['x-api-key'] }); return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  await fetchJupiterQuote({ inputMint: SOLM, outputMint: USDCM, amount: 1_000_000_000n, fetchFn: rec(good), apiKey: 'k-123' });
  await fetchJupiterQuote({ inputMint: SOLM, outputMint: USDCM, amount: 1_000_000_000n, fetchFn: rec(good) });
  assert.match(seen[0].url, /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/); assert.equal(seen[0].key, 'k-123');
  assert.match(seen[1].url, /^https:\/\/lite-api\.jup\.ag\/swap\/v1\/quote\?/); assert.equal(seen[1].key, undefined);
  const T = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', price = { [T]: { usdPrice: 383.6, stockData: { price: 383.9 } } };
  const keyed = await new JupiterStockPrices({ apiKey: 'k-123', fetchFn: rec(price) }).get([T]), open = await new JupiterStockPrices({ fetchFn: rec(price) }).get([T]);
  assert.match(seen[2].url, /^https:\/\/api\.jup\.ag\/price\/v3\?ids=/); assert.equal(seen[2].key, 'k-123'); assert.equal(keyed.get(T)?.stockPrice, 383.9);
  assert.match(seen[3].url, /^https:\/\/lite-api\.jup\.ag\/price\/v3\?ids=/); assert.equal(seen[3].key, undefined); assert.equal(open.get(T)?.stockPrice, 383.9);
});

test('a rate-limited Jupiter key (HTTP 429) falls back to the keyless host for quotes and share prices, without the key', async () => {
  const T = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', price = { [T]: { usdPrice: 733.9, stockData: { price: 730.66 } } }, seen: { url: string; key?: string }[] = [];
  const limited = (body: unknown) => (async (url: any, init: any = {}) => { const u = String(url); seen.push({ url: u, key: init.headers?.['x-api-key'] });
    return u.startsWith('https://api.jup.ag/') ? new Response('{"code":429,"message":"Too many requests"}', { status: 429 }) : new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  const q = await fetchJupiterQuote({ inputMint: SOLM, outputMint: USDCM, amount: 1_000_000_000n, fetchFn: limited(good), apiKey: 'k-123' });
  assert.equal(q.outAmount, 73640575n); assert.match(seen[0].url, /api\.jup\.ag/); assert.match(seen[1].url, /^https:\/\/lite-api\.jup\.ag\/swap\/v1\/quote\?/); assert.equal(seen[1].key, undefined);
  const p = await new JupiterStockPrices({ apiKey: 'k-123', fetchFn: limited(price) }).get([T]);
  assert.equal(p.get(T)?.stockPrice, 730.66, 'the share price still arrives, so a stock trade is not refused with no_reference_price');
  assert.match(seen[3].url, /^https:\/\/lite-api\.jup\.ag\/price\/v3/); assert.equal(seen[3].key, undefined);
});

test('route-program lookups and builds: a rate-limited key (HTTP 429) is dropped for the next try, which goes keyless', async () => {
  const { fetchRoutableProgramIds } = await import('../src/jupiterswap.ts');
  const seen: (string | undefined)[] = [];
  const fetchFn = (async (_url: any, init: any = {}) => { const key = init.headers?.['x-api-key']; seen.push(key);
    return key ? new Response('{"code":429}', { status: 429 }) : new Response(JSON.stringify(Object.fromEntries(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'].map(k => [k, 'label']))), { status: 200 }); }) as typeof fetch;
  const ids = await fetchRoutableProgramIds({ apiKey: 'k-123', fetchFn });
  assert.ok(ids.has('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')); assert.deepEqual(seen, ['k-123', undefined], 'one keyed try, then keyless');
});
