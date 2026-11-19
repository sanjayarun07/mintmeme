/** Coinbase stocks on the server's real Base accounts, offline: the Base node, Relay and Jupiter's price API are stand-ins, Privy is the stand-in from packages/evm/test.
 *  Covers ticker lookup (NVDAc, NVDA, `stock`), the operator switch (buys refused when off, sells always allowed), and the fill-price check against the share price.
 *  `prepare` only builds and checks the request body: nothing is signed or sent here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE } from '../../packages/core/src/index.ts';
import { JupiterStockPrices, STOCKS_SOLANA, underlying } from '../../packages/sol/src/index.ts';
import { BASE } from '../../packages/sdk/src/index.ts';
import { BASE_STOCKS } from '../../packages/evm/src/basestocks.ts';
import { fakePrivyEvm } from '../../packages/evm/test/fakeprivyevm.ts';
import { JsonRpcError } from '../../packages/evm/src/index.ts';
import { UI_MULTIPLIER_SELECTOR as UIM } from '../../packages/evm/src/robinhoodstocks.ts';
import { baseAccounts, findBaseStock } from './baseaccount.ts';

const TSLAC = BASE_STOCKS.TSLAc.toLowerCase(), TSLA_SOL = STOCKS_SOLANA.find(a => underlying(a) === 'TSLA')!.mint;
const mem = () => { const m = new Map<string, string>(); return (n: string) => ({ read: () => m.get(n), write: (d: string) => { m.set(n, d); }, describe: () => n }); };
const w = (n: bigint) => n.toString(16).padStart(64, '0');

/** The world: ETH at $2,000, TSLA at $400 a share. `perEth`: raw TSLAc (8 decimals) per 1 ETH; 500_000_000 is the fair 5 shares. */
function world(o: { perEth?: bigint; stockPrice?: number | null; enabled?: boolean; mult?: bigint | 'down' } = {}) {
  const perEth = o.perEth ?? 500_000_000n, p = fakePrivyEvm();
  const rpc = { call: async (m: string, a: any[] = []): Promise<any> => {
    if (m === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    if (m === 'eth_call' && a[0].to === BASE.factory) return '0x' + '0'.repeat(64);                        // getPair(WETH, token): no V2 pool
    if (m === 'eth_call' && a[0].data === '0x313ce567') return '0x' + w(8n);                                // decimals()
    if (m === 'eth_call' && a[0].data === UIM) { if (o.mult === 'down') throw new Error('fetch failed'); if (o.mult) return '0x' + w(o.mult); throw new JsonRpcError('execution reverted'); }   // uiMultiplier(): none by default
    if (m === 'eth_call' && a[0].to === BASE.wethUsdcPair) return '0x' + w(1000n * 10n ** 18n) + w(2_000_000n * 10n ** 6n) + w(0n);   // getReserves: WETH (token0), USDC
    throw new Error(`unscripted ${m}`); } };
  const relay = { client: { quote: async (_w: string, tin: string, _t: string, amt: bigint) => ({ amountOut: tin === NATIVE ? amt * perEth / 10n ** 18n : amt * 10n ** 18n / perEth, minimumOut: 0n, relayerFeeWei: 0n, requestId: 'r', steps: [] }) } as any };
  const prices = new JupiterStockPrices({ fetchFn: (async () => new Response(JSON.stringify(o.stockPrice === null ? {} : { [TSLA_SOL]: { usdPrice: 400, stockData: { price: o.stockPrice ?? 400 } } }))) as any });
  const acc = baseAccounts({ rpcUrl: 'http://rpc.test', rpc, privy: { ...p.cfg, fetchFn: p.fetchFn } as any, relay, stocks: { enabled: o.enabled ?? true, prices } });
  const state = mem(); state('basewallet').write(JSON.stringify({ address: p.address.toLowerCase(), walletId: 'evm-wallet-1', linkedAt: 1 }));
  return { make: () => acc.make('u1', state) };
}
const code = (c: string) => (e: any) => e?.code === c;

test('findBaseStock: by address, symbol or ticker, any case; anything else is not a stock', () => {
  assert.equal(findBaseStock('TSLAc')?.address, TSLAC); assert.equal(findBaseStock('tsla')?.address, TSLAC); assert.equal(findBaseStock(BASE_STOCKS.TSLAc.toUpperCase().replace('0X', '0x'))?.symbol, 'TSLAc');
  assert.equal(findBaseStock('TSLAx'), undefined, 'the Solana xStock symbol is not a Base stock'); assert.equal(findBaseStock('0x' + '12'.repeat(20)), undefined);
});

test('Base stocks: the ticker becomes the address; a fair buy and a sell pass the share-price check', async () => {
  const a = await world().make();
  const b = await a.prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy'); assert.equal(b.token, TSLAC); assert.equal(b.amount, String(10n ** 17n));
  const b2 = await a.prepare({ stock: 'tsla', eth: '0.1' }, '/v1/trades/buy'); assert.equal(b2.token, TSLAC, 'the underlying ticker, given as `stock`'); assert.equal(b2.stock, undefined);
  const s = await a.prepare({ token: 'TSLA', amount: '50000000' }, '/v1/trades/sell'); assert.equal(s.token, TSLAC);
});

test('Base stocks: with the operator switch off, buys are refused (stocks_disabled) and sells still work', async () => {
  const a = await world({ enabled: false }).make();
  await assert.rejects(a.prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy'), code('stocks_disabled'));
  const s = await a.prepare({ token: 'TSLAc', amount: '50000000' }, '/v1/trades/sell'); assert.equal(s.token, TSLAC);
});

test('Base stocks: a route far from the share price is refused (bad_price) unless allowRiskyToken; no share price refuses too', async () => {
  const bad = await world({ perEth: 400_000_000n }).make();   // 4 shares per ETH: $500 a share against $400, 25% over
  await assert.rejects(bad.prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy'), (e: any) => e?.code === 'bad_price' && /\$500 per share against a share price of \$400/.test(e.message));
  const risky = await bad.prepare({ token: 'TSLAc', eth: '0.1', allowRiskyToken: true }, '/v1/trades/buy'); assert.equal(risky.token, TSLAC);
  const cheapSell = await world({ perEth: 600_000_000n }).make();   // selling: 6 shares per ETH is $333 a share, 17% under
  await assert.rejects(cheapSell.prepare({ token: 'TSLAc', amount: '50000000' }, '/v1/trades/sell'), code('bad_price'));
  const noRef = await world({ stockPrice: null }).make();
  await assert.rejects(noRef.prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy'), code('no_reference_price'));
});

test('Base stocks: a B20 token with uiMultiplier is priced per share; a token without one counts 1; an unreachable node refuses', async () => {
  // 1.25 shares per token: 5 tokens per ETH is $400 per token, $320 a share against $400, so a sell receives far less than the shares are worth
  await assert.rejects((await world({ mult: 125n * 10n ** 16n }).make()).prepare({ token: 'TSLAc', amount: '50000000' }, '/v1/trades/sell'), (e: any) => e?.code === 'bad_price' && /\$320 per share/.test(e.message));
  assert.equal((await (await world({ mult: 125n * 10n ** 16n, perEth: 400_000_000n }).make()).prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy')).token, TSLAC, '4 tokens of 1.25 shares per ETH is fair');
  await assert.rejects((await world({ mult: 'down' }).make()).prepare({ token: 'TSLAc', eth: '0.1' }, '/v1/trades/buy'), code('no_reference_price'));
});

test('Base stocks: an ordinary token is not touched by any of this', async () => {
  const a = await world({ enabled: false, perEth: 1n }).make();
  const t = '0x' + '77'.repeat(20), b = await a.prepare({ token: t, eth: '0.1' }, '/v1/trades/buy'); assert.equal(b.token, t);
});

/* ---------------- Robinhood stock tokens on Robinhood Chain: the same checks, with the share multiplier read on chain (uiMultiplier) ---------------- */
import { EVM_NETWORKS } from '../../packages/sdk/src/base.ts';
import { ROBINHOOD_STOCKS, UI_MULTIPLIER_SELECTOR } from '../../packages/evm/src/robinhoodstocks.ts';
import { findRobinhoodStock } from './baseaccount.ts';
const RH = EVM_NETWORKS.robinhood, RH_TSLA = ROBINHOOD_STOCKS.TSLA.toLowerCase();

/** ETH at $2,000, TSLA at $400 a share, one token worth `mult` shares (1.25 by default, so a fair token is $500: 4 tokens per ETH). Routes come from a KyberSwap stand-in. */
function rhWorld(o: { perEth?: bigint; mult?: bigint | 'revert'; enabled?: boolean } = {}) {
  const perEth = o.perEth ?? 4n * 10n ** 18n, p = fakePrivyEvm(), multAsked: string[] = [];
  const rpc = { call: async (m: string, a: any[] = []): Promise<any> => {
    if (m === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    if (m === 'eth_call' && a[0].to === RH.factory) return '0x' + '0'.repeat(64);                          // no V2 pool
    if (m === 'eth_call' && a[0].data === '0x313ce567') return '0x' + w(18n);                                // decimals()
    if (m === 'eth_call' && a[0].data === UI_MULTIPLIER_SELECTOR) { multAsked.push(a[0].to); if (o.mult === 'revert') throw new Error('execution reverted'); return '0x' + w(o.mult ?? 125n * 10n ** 16n); }
    if (m === 'eth_call' && a[0].to === RH.usd.pair) return '0x' + w(1000n * 10n ** 18n) + w(2_000_000n * 10n ** 6n) + w(0n);   // WETH (token0), USDG
    throw new Error(`unscripted ${m} ${JSON.stringify(a[0])}`); } };
  const kyber = { client: { quote: async (tin: string, _t: string, amt: bigint) => ({ amountOut: tin === NATIVE ? amt * perEth / 10n ** 18n : amt * 10n ** 18n / perEth, routeSummary: {}, path: ['metric'] }) } as any };
  const prices = new JupiterStockPrices({ fetchFn: (async () => new Response(JSON.stringify({ [TSLA_SOL]: { usdPrice: 400, stockData: { price: 400 } } }))) as any });
  const acc = baseAccounts({ rpcUrl: 'http://rpc.test', rpc, network: 'robinhood', privy: { ...p.cfg, fetchFn: p.fetchFn } as any, aggregator: 'kyberswap', kyber, stocks: { enabled: o.enabled ?? true, prices } });
  const state = mem(); state('robinhoodwallet').write(JSON.stringify({ address: p.address.toLowerCase(), walletId: 'evm-wallet-1', linkedAt: 1 }));
  return { make: () => acc.make('u1', state), multAsked };
}

test('findRobinhoodStock: by address or ticker, any case; a Base or Solana symbol is not one', () => {
  assert.equal(Object.keys(ROBINHOOD_STOCKS).length, 203);
  assert.equal(findRobinhoodStock('tsla')?.address, RH_TSLA); assert.equal(findRobinhoodStock(ROBINHOOD_STOCKS.TSLA)?.symbol, 'TSLA');
  assert.equal(findRobinhoodStock('TSLAc'), undefined); assert.equal(findRobinhoodStock('TSLAx'), undefined); assert.equal(findBaseStock('0x322f0929c4625ed5bad873c95208d54e1c003b2d'), undefined);
});

test('Robinhood stocks: the ticker becomes the address, and the price check counts shares with uiMultiplier (a fair 1.25-share token passes)', async () => {
  const wld = rhWorld(), a = await wld.make();
  const b = await a.prepare({ token: 'TSLA', eth: '0.1' }, '/v1/trades/buy'); assert.equal(b.token, RH_TSLA);
  const s = await a.prepare({ stock: 'tsla', amount: String(10n ** 18n) }, '/v1/trades/sell'); assert.equal(s.token, RH_TSLA);
  assert.deepEqual(wld.multAsked, [RH_TSLA], 'read once, then kept');
  // the same route with the multiplier taken as 1 would be $500 a share against $400: refused
  await assert.rejects((await rhWorld({ mult: 10n ** 18n }).make()).prepare({ token: 'TSLA', eth: '0.1' }, '/v1/trades/buy'), (e: any) => e?.code === 'bad_price' && /\$500 per share against a share price of \$400/.test(e.message));
});

test('Robinhood stocks: an unreadable multiplier refuses (no_reference_price) unless allowRiskyToken; buys need the operator switch', async () => {
  const a = await rhWorld({ mult: 'revert' }).make();
  await assert.rejects(a.prepare({ token: 'TSLA', eth: '0.1' }, '/v1/trades/buy'), (e: any) => e?.code === 'no_reference_price' && /multiplier of TSLA/.test(e.message));
  assert.equal((await a.prepare({ token: 'TSLA', eth: '0.1', allowRiskyToken: true }, '/v1/trades/buy')).token, RH_TSLA);
  const off = await rhWorld({ enabled: false }).make();
  await assert.rejects(off.prepare({ token: 'TSLA', eth: '0.1' }, '/v1/trades/buy'), code('stocks_disabled'));
  assert.equal((await off.prepare({ token: 'TSLA', amount: String(10n ** 18n) }, '/v1/trades/sell')).token, RH_TSLA);
});
