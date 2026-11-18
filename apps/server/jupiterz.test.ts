/** JupiterZ (RFQ) wiring in the execution server, offline: the env switch (main.ts jupiterzConfig), the share-price check on an RFQ fill (solaccount.ts rfqFillCheck),
 *  and the setting reaching the Solana chain through createSolanaTrader with the Jupiter API key. The RFQ path itself (gate, simulation, /execute) is covered by
 *  packages/sol/test/jupiterz.test.ts. Nothing is signed or sent here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DevSolSigner } from '../../packages/sol/src/signer.ts';
import { JupiterStockPrices } from '../../packages/sol/src/index.ts';
import { NATIVE } from '../../packages/core/src/index.ts';
import { fakePrivy } from '../../packages/sol/test/fakeprivy.ts';
import { createSolanaTrader } from '../../packages/sdk/src/solana.ts';
import { rfqFillCheck } from './solaccount.ts';
import { jupiterzConfig, solanaCaps } from './main.ts';

const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const mem = () => { const m = new Map<string, string>(); return (n: string) => ({ read: () => m.get(n), write: (d: string) => { m.set(n, d); }, describe: () => n }); };

test('JUPITERZ: off unless JUPITERZ=on; defaults 100 SOL and 20 bps; bad values stop the server at start', () => {
  assert.equal(jupiterzConfig({}), undefined);
  assert.equal(jupiterzConfig({ JUPITERZ: 'off' }), undefined);
  assert.deepEqual(jupiterzConfig({ JUPITERZ: 'on' }), { minLamports: 100_000_000_000n, marginBps: 20 });
  assert.deepEqual(jupiterzConfig({ JUPITERZ: 'ON', JUPITERZ_MIN_SOL: '12.5', JUPITERZ_MARGIN_BPS: '0' }), { minLamports: 12_500_000_000n, marginBps: 0 });
  assert.throws(() => jupiterzConfig({ JUPITERZ: 'yes' }), /JUPITERZ must be on or off/);
  assert.throws(() => jupiterzConfig({ JUPITERZ: 'on', JUPITERZ_MIN_SOL: '-1' }), /JUPITERZ_MIN_SOL/);
  assert.throws(() => jupiterzConfig({ JUPITERZ: 'on', JUPITERZ_MARGIN_BPS: '2.5' }), /JUPITERZ_MARGIN_BPS/);
  assert.throws(() => jupiterzConfig({ JUPITERZ: 'on', JUPITERZ_MARGIN_BPS: '5000' }), /JUPITERZ_MARGIN_BPS/);
});

/** SOL at $100, TSLA at $400 a share, TSLAx 8 decimals, multiplier 1: 1 SOL buys 0.25 share = 25_000_000 raw at the fair price. */
const check = (o: { stockPrice?: number | null; sol?: number | null; multiplier?: string } = {}) => rfqFillCheck({
  solUsd: async () => (o.sol === null ? null : { price: o.sol ?? 100, at: Date.now() }),
  prices: new JupiterStockPrices({ fetchFn: (async () => new Response(JSON.stringify(o.stockPrice === null ? {} : { [TSLAX]: { usdPrice: 400, stockData: { price: o.stockPrice ?? 400 } } }))) as any }),
  stockState: async () => ({ decimals: 8, multiplier: o.multiplier ?? '1' }), maxDeviationPct: 3 });
const buy = (lamports: bigint) => ({ tokenIn: NATIVE, tokenOut: TSLAX, amountIn: lamports, minOut: 0n }), sell = (raw: bigint) => ({ tokenIn: TSLAX, tokenOut: NATIVE, amountIn: raw, minOut: 0n });

test('RFQ share-price check: a fair maker fill passes, an overpriced buy or an underpriced sell is refused, and no share or SOL price fails closed', async () => {
  const c = check();
  assert.equal(await c(buy(10_000_000_000n), 250_000_000n), undefined, '10 SOL for 2.5 shares: $400 a share');
  assert.equal(await c(buy(10_000_000_000n), 243_000_000n), undefined, 'about 2.9% worse: inside the 3% limit');
  assert.match((await c(buy(10_000_000_000n), 200_000_000n))!, /^RFQ this route pays \$500 per share against a share price of \$400/);
  assert.equal(await c(sell(250_000_000n), 10_000_000_000n), undefined, '2.5 shares for 10 SOL: $400 a share');
  assert.match((await c(sell(250_000_000n), 8_000_000_000n))!, /receives \$320 per share/);
  assert.match((await check({ stockPrice: null })(buy(10_000_000_000n), 250_000_000n))!, /no share price for TSLA/);
  assert.match((await check({ sol: null })(buy(10_000_000_000n), 250_000_000n))!, /no SOL price/);
  // the multiplier counts: 1 token = 1.25 shares, so 2 tokens for 10 SOL is $400 a share
  assert.equal(await check({ multiplier: '1.25' })(buy(10_000_000_000n), 200_000_000n), undefined);
  // not a registered stock: the check does not apply
  assert.equal(await c({ tokenIn: NATIVE, tokenOut: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountIn: 1n, minOut: 0n }, 1n), undefined);
  // a stock against a token other than SOL is refused rather than priced wrong
  assert.match((await c({ tokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenOut: TSLAX, amountIn: 1n, minOut: 0n }, 1n))!, /SOL trades only/);
});

test('createSolanaTrader passes jupiterz to the Solana chain with the Jupiter API key; without it the chain has no RFQ path', async () => {
  const seed = randomBytes(32), addr = new DevSolSigner().add(seed), fp = fakePrivy({ seed });
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init?: any) => { const b = JSON.parse(init?.body ?? '{}'); const result = b.method === 'getSlot' ? 100 : b.method === 'getBlockTime' ? Math.floor(Date.now() / 1000) : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result })); }) as typeof fetch;
  try {
    const checkFill = async () => undefined;
    const on = await createSolanaTrader({ userId: 'u', address: addr, walletId: 'wallet-1', rpcUrl: 'http://rpc.test', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, state: mem(), jupiterApiKey: 'jup-key', jupiterz: { minLamports: 7n, marginBps: 15, checkFill } });
    const z = (on.chain as any).cfg.jupiterz;
    assert.equal(z.minLamports, 7n); assert.equal(z.marginBps, 15); assert.equal(z.apiKey, 'jup-key'); assert.equal(z.checkFill, checkFill); assert.equal(typeof z.log, 'function');
    const off = await createSolanaTrader({ userId: 'u', address: addr, walletId: 'wallet-1', rpcUrl: 'http://rpc.test', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, state: mem() });
    assert.equal((off.chain as any).cfg.jupiterz, undefined);
  } finally { globalThis.fetch = real; }
});

test('SOLANA_MAX_TRADE_SOL / SOLANA_DAILY_CAP_SOL: 0.05 and 0.25 SOL by default, raised by env, checked against each other and against JUPITERZ_MIN_SOL', () => {
  assert.deepEqual(solanaCaps({}), { maxTradeLamports: 50_000_000n, dailyCapLamports: 250_000_000n });
  assert.deepEqual(solanaCaps({ SOLANA_MAX_TRADE_SOL: '15', SOLANA_DAILY_CAP_SOL: '50' }), { maxTradeLamports: 15_000_000_000n, dailyCapLamports: 50_000_000_000n });
  assert.throws(() => solanaCaps({ SOLANA_MAX_TRADE_SOL: '15' }), /SOLANA_DAILY_CAP_SOL must be at least SOLANA_MAX_TRADE_SOL/);
  assert.throws(() => solanaCaps({ SOLANA_MAX_TRADE_SOL: '1e3' }), /SOLANA_MAX_TRADE_SOL/);
  // JupiterZ on with its 100 SOL default and the default caps: no trade could ever reach it, so the server refuses to start
  assert.throws(() => solanaCaps({}, jupiterzConfig({ JUPITERZ: 'on' })), /JUPITERZ_MIN_SOL is above SOLANA_MAX_TRADE_SOL/);
  assert.equal(solanaCaps({ SOLANA_MAX_TRADE_SOL: '15', SOLANA_DAILY_CAP_SOL: '50' }, jupiterzConfig({ JUPITERZ: 'on', JUPITERZ_MIN_SOL: '13' })).maxTradeLamports, 15_000_000_000n);
});
