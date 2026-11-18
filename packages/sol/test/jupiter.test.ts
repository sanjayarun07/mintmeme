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
