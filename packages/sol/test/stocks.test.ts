import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockStateOf, readStockStates, rawForShares, sharesForRaw, perTokenPrice, checkFillPrice, JupiterStockPrices, findStock, underlying, SolanaChain, DevSolSigner, PROGRAMS, STOCKS_SOLANA } from '../src/index.ts';

const T22 = PROGRAMS.token2022, TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', WSOL = 'So11111111111111111111111111111111111111112';
const mintAcct = (o: { mult?: string; next?: string; at?: number; paused?: boolean; decimals?: number } = {}) => ({ owner: T22, data: { parsed: { type: 'mint', info: { decimals: o.decimals ?? 8, extensions: [
  { extension: 'scaledUiAmountConfig', state: { multiplier: o.mult ?? '1', newMultiplier: o.next ?? o.mult ?? '1', newMultiplierEffectiveTimestamp: o.at ?? 0 } }, { extension: 'pausableConfig', state: { authority: 'A', paused: o.paused ?? false } }] } } } });

test('stock state: the multiplier in force (a scheduled one applies from its time), and the issuer pause', () => {
  assert.deepEqual(stockStateOf('M', mintAcct({ mult: '1.0032690125398187' }), 100), { mint: 'M', decimals: 8, multiplier: '1.0032690125398187', paused: false });
  assert.deepEqual(stockStateOf('M', mintAcct({ mult: '1.0032', next: '1.0038', at: 200 }), 100)?.next, { multiplier: '1.0038', at: 200 });
  assert.equal(stockStateOf('M', mintAcct({ mult: '1.0032', next: '1.0038', at: 200 }), 200)?.multiplier, '1.0038', 'from its effective time the new multiplier is the one in force');
  assert.equal(stockStateOf('M', mintAcct({ paused: true }))?.paused, true);
  assert.equal(stockStateOf('M', { owner: T22, data: { parsed: { type: 'mint', info: { decimals: 6 } } } })?.multiplier, '1', 'no multiplier extension: one token is one share');
  assert.equal(stockStateOf('M', { data: ['', 'base64'] }), undefined, 'not a parsed mint');
  assert.throws(() => stockStateOf('M', mintAcct({ mult: '0' })), /above zero/);
});

test('per-share amounts are exact and round down; per-share prices become per-token prices', () => {
  assert.equal(rawForShares('1', '1', 8), 100_000_000n);
  assert.equal(rawForShares('1', '1.25', 8), 80_000_000n, 'one share is 0.8 tokens when one token is 1.25 shares');
  assert.equal(rawForShares('1', '3', 8), 33_333_333n, 'rounded down: never more tokens than the shares asked for');
  assert.equal(sharesForRaw(80_000_000n, '1.25', 8), '1.000000');
  assert.equal(sharesForRaw(1_000_000_000n, '1.0032690125398187', 9, 4), '1.0032');
  assert.equal(perTokenPrice('400', '1.0032690125398187'), '401.307605015927');
  assert.equal(perTokenPrice('400', '1'), '400');
  assert.throws(() => rawForShares('-1', '1', 8), /decimal/); assert.throws(() => perTokenPrice('1e3', '1'), /decimal/);
});

test('fill price check: a buy that pays well above the share price (the Ondo case) is refused; within the limit, or a sell above it, passes; no reference is reported, not guessed', () => {
  // 0.05 SOL at $74 = $3.70; 0.00313 TSLAon (9 decimals, multiplier 1) is $1,182 per share against $384
  const ondo = checkFillPrice({ side: 'buy', solLamports: 50_000_000n, tokensRaw: 3_131_563n, decimals: 9, multiplier: '1', solUsd: 74, referenceUsd: 384 });
  assert.equal(ondo.ok, false); assert.match(ondo.why!, /per share against a share price of \$384/); assert.ok(ondo.deviationPct! > 200);
  // 0.05 SOL -> 0.00968 TSLAx: $382 per share, 0.5% under the reference
  const x = checkFillPrice({ side: 'buy', solLamports: 50_000_000n, tokensRaw: 968_296n, decimals: 8, multiplier: '1', solUsd: 74.3, referenceUsd: 384 }); assert.equal(x.ok, true); assert.ok(Math.abs(x.deviationPct!) < 2);
  // the multiplier counts: the same tokens are more shares, so a lower price per share
  const m = checkFillPrice({ side: 'buy', solLamports: 1_000_000_000n, tokensRaw: 100_000_000n, decimals: 8, multiplier: '1.05', solUsd: 105, referenceUsd: 100 }); assert.equal(Math.round(m.perShareUsd), 100); assert.equal(m.ok, true);
  assert.equal(checkFillPrice({ side: 'sell', solLamports: 1_000_000_000n, tokensRaw: 100_000_000n, decimals: 8, multiplier: '1', solUsd: 90, referenceUsd: 100 }).ok, false, 'selling 10% under the share price');
  assert.equal(checkFillPrice({ side: 'sell', solLamports: 1_000_000_000n, tokensRaw: 100_000_000n, decimals: 8, multiplier: '1', solUsd: 120, referenceUsd: 100 }).ok, true, 'selling above it is fine');
  const none = checkFillPrice({ side: 'buy', solLamports: 1n, tokensRaw: 1n, decimals: 8, multiplier: '1', solUsd: 1, referenceUsd: null }); assert.equal(none.ok, true); assert.equal(none.referenceUsd, null); assert.match(none.why!, /no reference/);
});

test('Jupiter stock prices: the underlying share price from stockData, cached; a failed fetch gives no reference rather than a wrong one', async () => {
  const urls: string[] = []; let t = 0;
  const fetchFn = (async (u: string) => { urls.push(u); return { ok: true, json: async () => ({ [TSLAX]: { usdPrice: 383.7, stockData: { price: 384.05 } }, MEME: { usdPrice: 0.01 } }) }; }) as any;
  const p = new JupiterStockPrices({ fetchFn, now: () => t });
  const a = await p.get([TSLAX, 'MEME']); assert.deepEqual(a.get(TSLAX), { usdPrice: 383.7, stockPrice: 384.05 }); assert.equal(a.get('MEME')?.stockPrice, undefined);
  await p.get([TSLAX]); assert.equal(urls.length, 1, 'cached'); t = 31_000; await p.get([TSLAX]); assert.equal(urls.length, 2);
  const down = new JupiterStockPrices({ fetchFn: (async () => { throw new Error('down'); }) as any }); assert.equal((await down.get([TSLAX])).size, 0);
});

test('stock lookup: by mint or symbol across issuers, and the underlying ticker', () => {
  assert.equal(findStock('tslax')?.mint, TSLAX); assert.equal(findStock(TSLAX)?.symbol, 'TSLAx'); assert.equal(findStock('NOPE'), undefined);
  assert.deepEqual(['TSLAx', 'TSLAon', 'TSLA'].map(s => underlying(findStock(s)!)), ['TSLA', 'TSLA', 'TSLA']);
  assert.ok(STOCKS_SOLANA.every(a => underlying(a).length > 0));
});

test('chain: a registered stock whose issuer paused transfers has no Jupiter venue until the pause ends (orders wait instead of failing)', async () => {
  let paused = true; const calls: string[] = [];
  const rpc = { call: async (m: string, p: any[] = []) => { calls.push(m);
    if (m === 'getSlot') return 100; if (m === 'getBlockTime') return 1_800_000_000;
    if (m === 'getMultipleAccounts') return { value: (p[0] as string[]).map(a => (a === TSLAX ? mintAcct({ paused }) : null)) };
    throw new Error(`unscripted ${m}`); } };
  const quote = (u: string) => { const q = new URL(u).searchParams; return { inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: '1000000', otherAmountThreshold: '990000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', contextSlot: 1, routePlan: [] }; };
  const fetchFn = (async (u: string) => ({ ok: true, status: 200, json: async () => quote(String(u)) })) as any;
  const c = new SolanaChain({ id: 's', wsol: WSOL, pools: [], jupiter: { fetchFn, pairs: [{ inMint: WSOL, outMint: TSLAX, refAmount: 50_000_000n }] } }, rpc as any, new DevSolSigner());
  await c.refresh('venues'); assert.equal(c.venues().length, 0); assert.match(c.jupiterError!, /paused by the issuer/);
  (c as any).pauseRead = undefined; paused = false; await c.refresh('venues'); assert.equal(c.venues().length, 1, 'the venue comes back when the pause ends');
  const n = calls.filter(x => x === 'getMultipleAccounts').length; await c.refresh('venues'); assert.equal(calls.filter(x => x === 'getMultipleAccounts').length, n, 'the pause read is cached');
});

test('readStockStates reads many mints in one call and leaves out what is not a mint', async () => {
  const rpc = { call: async (_m: string, p: any[]) => ({ value: (p[0] as string[]).map(a => (a === 'A' ? mintAcct({ mult: '1.5' }) : null)) }) };
  const s = await readStockStates(rpc, ['A', 'B']); assert.deepEqual([...s.keys()], ['A']); assert.equal(s.get('A')!.multiplier, '1.5');
});
