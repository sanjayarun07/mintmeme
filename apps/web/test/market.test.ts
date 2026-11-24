/** Market data for /app (apps/web/market.ts): normalizing each source, merging chains, caching through rate limits, and refusing bad input. Network is faked. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { marketList, marketToken, marketCandles, marketSearch, marketMeta, marketRows, marketStocks, txTimes, fromGecko, fromJupiter, clearMarketCache, balancesOf, solActivity, marketHoldings, marketActivity, chainRpc } from '../market.ts';

beforeEach(() => clearMarketCache());
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const gecko = (chain: string, pools: { sym: string; addr: string; liq: number; vol: number }[]) => ({
  data: pools.map((p, i) => ({ attributes: { address: '0xpool' + i, name: p.sym + ' / WETH', base_token_price_usd: '1.5', price_change_percentage: { h1: '1', h24: '-2.5' }, market_cap_usd: '1000000', reserve_in_usd: String(p.liq), volume_usd: { h24: String(p.vol) }, transactions: { h24: { buys: 10, sells: 5 } }, pool_created_at: '2026-11-01T00:00:00Z' }, relationships: { base_token: { data: { id: chain + '_' + p.addr } } } })),
  included: pools.map(p => ({ id: chain + '_' + p.addr, attributes: { address: p.addr, symbol: p.sym, name: p.sym + ' coin', image_url: 'missing.png' } })),
});
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

test('GeckoTerminal pools become one row per token (most liquid pool, volumes added); wrapped native and stablecoins are skipped', () => {
  const rows = fromGecko('base', gecko('base', [{ sym: 'DOG', addr: A, liq: 100, vol: 5 }, { sym: 'DOG', addr: A, liq: 900, vol: 7 }, { sym: 'WETH', addr: B, liq: 5000, vol: 1 }, { sym: 'USDC', addr: B, liq: 5000, vol: 1 }]));
  assert.equal(rows.length, 1); assert.equal(rows[0].liquidity, 900); assert.equal(rows[0].volume24h, 12); assert.equal(rows[0].pool, '0xpool1');
  assert.equal(rows[0].icon, null, '"missing.png" is no icon');
  const zero = gecko('base', [{ sym: 'ARK', addr: A, liq: 5e7, vol: 1 }]); zero.data[0].attributes.market_cap_usd = '0.0'; (zero.data[0].attributes as any).fdv_usd = '0';
  assert.equal(fromGecko('base', zero)[0].mcap, null, 'a "0" market cap is unknown, not $0'); assert.equal(rows[0].change24h, -2.5); assert.equal(rows[0].buys24h, 10);
});

test('Jupiter tokens keep holders, organic score and volume as buy + sell', () => {
  const r = fromJupiter({ id: MINT, symbol: 'Bonk', name: 'Bonk', usdPrice: 0.00002, mcap: 1e9, liquidity: 2e6, holderCount: 900000, organicScoreLabel: 'high', isVerified: true, stats24h: { priceChange: 3, buyVolume: 100, sellVolume: 50, numBuys: 7, numSells: 3 }, stats1h: { priceChange: -1 } });
  assert.equal(r.chain, 'solana'); assert.equal(r.volume24h, 150); assert.equal(r.holders, 900000); assert.equal(r.organic, 'high'); assert.equal(r.change1h, -1); assert.equal(r.verified, true);
});

test('the all-chains list merges by volume, reports a chain that failed, and serves the last good copy on a rate limit', async () => {
  let calls = 0, limit = false;
  const f = (async (url: string) => { calls++;
    if (limit) return json({}, 429);
    if (url.includes('lite-api.jup.ag')) return json([{ id: MINT, symbol: 'BONK', usdPrice: 1, stats24h: { buyVolume: 500, sellVolume: 0 } }]);
    if (url.includes('/networks/bsc/')) return json({}, 500);
    if (url.includes('/networks/base/')) return json(gecko('base', [{ sym: 'BIG', addr: A, liq: 1, vol: 9000 }]));
    if (url.includes('/networks/robinhood/')) return json(gecko('robinhood', [{ sym: 'RH', addr: B, liq: 1, vol: 10 }]));
    throw new Error('unexpected ' + url); }) as any;
  const r = await marketList({ chain: 'all', tab: 'trending' }, { fetch: f, now: () => 0 });
  assert.deepEqual(r.rows.map(x => x.symbol), ['BIG', 'BONK', 'RH']);
  assert.deepEqual(r.unavailable.map(u => u.chain), ['bnb']); assert.match(r.unavailable[0].why, /HTTP 500/);
  const before = calls; await marketList({ chain: 'all', tab: 'trending' }, { fetch: f, now: () => 30_000 }); assert.equal(calls, before + 1, 'cached for 60 s (only the failed chain is asked again)');
  limit = true; const late = await marketList({ chain: 'base' }, { fetch: f, now: () => 120_000 });
  assert.equal(late.stale, true); assert.equal(late.rows[0].symbol, 'BIG', 'a 429 serves the last good copy');
  await assert.rejects(marketList({ chain: 'eth' }), /Unknown chain/);
});

test('one token: the most liquid matching pair, and on Solana the Jupiter audit', async () => {
  const f = (async (url: string) => {
    if (url.includes('dexscreener')) return json([
      { chainId: 'solana', dexId: 'raydium', pairAddress: 'P1', baseToken: { address: MINT, symbol: 'BONK', name: 'Bonk' }, quoteToken: { symbol: 'SOL' }, priceUsd: '0.00002', liquidity: { usd: 10 }, volume: { h24: 1 } },
      { chainId: 'solana', dexId: 'orca', pairAddress: 'P2', baseToken: { address: MINT, symbol: 'BONK', name: 'Bonk' }, quoteToken: { symbol: 'USDC' }, priceUsd: '0.00003', liquidity: { usd: 99 }, volume: { h24: 2 }, info: { imageUrl: 'https://x/i.png', websites: [{ url: 'https://bonk' }] } },
      { chainId: 'solana', dexId: 'other', pairAddress: 'P3', baseToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, liquidity: { usd: 1e9 } }]);
    if (url.includes('lite-api.jup.ag')) return json([{ id: MINT, holderCount: 5, organicScoreLabel: 'low', audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 41.5 } }]);
    throw new Error(url); }) as any;
  const r = await marketToken({ chain: 'solana', address: MINT }, { fetch: f });
  assert.equal(r.token.pool, 'P2'); assert.equal(r.token.price, 0.00003); assert.equal(r.token.holders, 5); assert.equal(r.pools.length, 2, 'pairs of other tokens are dropped');
  assert.deepEqual(r.audit, { mintDisabled: true, freezeDisabled: false, topHoldersPct: 41.5, devPct: null }); assert.equal(r.links.website, 'https://bonk');
  await assert.rejects(marketToken({ chain: 'base', address: MINT }), /0x token address/);
  await assert.rejects(marketToken({ chain: 'base', address: A }, { fetch: (async () => json([])) as any }), /No market found/);
});

test('candles come back oldest first, and a bad pool is refused', async () => {
  const f = (async (url: string) => { assert.match(url, /networks\/bsc\/pools\/0x[0-9a-f]{40}\/ohlcv\/minute\?aggregate=5/); return json({ data: { attributes: { ohlcv_list: [[200, 1, 2, 0.5, 1.5, 10], [100, 1, 1, 1, 1, 1]] } } }); }) as any;
  const r = await marketCandles({ chain: 'bnb', pool: A, tf: '5m' }, { fetch: f });
  assert.deepEqual(r.candles.map(c => c.t), [100, 200]);
  await assert.rejects(marketCandles({ chain: 'bnb', pool: 'nope' }), /pool address/);
});

test('search keeps the four chains only, one row per token, most liquid first', async () => {
  const f = (async () => json({ pairs: [
    { chainId: 'ethereum', baseToken: { address: A, symbol: 'X' }, liquidity: { usd: 1e9 } },
    { chainId: 'base', baseToken: { address: A, symbol: 'X' }, liquidity: { usd: 5 } },
    { chainId: 'base', baseToken: { address: A, symbol: 'X' }, liquidity: { usd: 50 } },
    { chainId: 'bsc', baseToken: { address: B, symbol: 'Y' }, liquidity: { usd: 70 } }] })) as any;
  const r = await marketSearch({ q: 'x' + 'y' }, { fetch: f });
  assert.deepEqual(r.rows.map(x => [x.chain, x.liquidity]), [['bnb', 70], ['base', 50]]);
  assert.deepEqual((await marketSearch({ q: 'a' })).rows, [], 'one letter: no search');
});

test('rows for known tokens: one per token (most liquid pair, volumes added), and a market cap below liquidity is not shown', async () => {
  const f = (async (url: string) => { assert.match(url, /tokens\/v1\/solana\//); return json([
    { chainId: 'solana', pairAddress: 'P1', baseToken: { address: MINT, symbol: 'TTWO' }, priceUsd: '211.7', liquidity: { usd: 650000 }, volume: { h24: 100 }, txns: { h24: { buys: 3, sells: 2 } }, marketCap: 91, fdv: 91 },
    { chainId: 'solana', pairAddress: 'P2', baseToken: { address: MINT, symbol: 'TTWO' }, priceUsd: '211.8', liquidity: { usd: 10 }, volume: { h24: 50 }, txns: { h24: { buys: 1, sells: 1 } }, marketCap: 91 }]); }) as any;
  const r = await marketRows({ chain: 'solana', tokens: [MINT, 'junk'] }, { fetch: f });
  const t = r.rows[MINT.toLowerCase()];
  assert.equal(t.pool, 'P1'); assert.equal(t.volume24h, 150); assert.equal(t.buys24h, 4); assert.equal(t.mcap, null, '$91 against $650k of liquidity is a bad supply figure');
});

test('meta reads decimals from the chain and price from the market, per token', async () => {
  const f = (async (url: string, init?: any) => {
    if (url.includes('dexscreener')) return json([{ baseToken: { address: A, symbol: 'TSLA', name: 'Tesla' }, priceUsd: '390.5', liquidity: { usd: 1 } }]);
    const b = JSON.parse(init.body); assert.equal(b.params[0].data, '0x313ce567'); return json({ result: b.params[0].to === A ? '0x12' : '0x' }); }) as any;
  const r = await marketMeta({ chain: 'robinhood', tokens: [A, B, 'junk'] }, { fetch: f, env: { ALCHEMY_API_KEY: 'k' } as any });
  assert.deepEqual(r.tokens[A], { symbol: 'TSLA', name: 'Tesla', decimals: 18, price: 390.5, icon: null });
  assert.equal(r.tokens[B].decimals, null, 'no decimals() answer stays unknown'); assert.equal(Object.keys(r.tokens).length, 2, 'junk is dropped');
});

test('Solana RPC everywhere: SOLANA_RPC_URL, else Helius, else Alchemy; the key part is known so errors can hide it', async () => {
  const { solanaRpc } = await import('../../../packages/live/src/config.ts');
  assert.equal(solanaRpc({ SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=h1', HELIUS_API_KEY: 'h2', ALCHEMY_API_KEY: 'a' } as any)!.secret, 'h1');
  const h = solanaRpc({ HELIUS_API_KEY: 'h2', ALCHEMY_API_KEY: 'a' } as any)!; assert.equal(h.url, 'https://mainnet.helius-rpc.com/?api-key=h2'); assert.equal(h.name, 'Helius');
  assert.equal(solanaRpc({ ALCHEMY_API_KEY: 'a' } as any)!.name, 'Alchemy'); assert.equal(solanaRpc({} as any), undefined);
});

test('marketStocks lists the Base, Robinhood and BNB Chain stock tokens, and none for Solana (its list comes from the trading server)', async () => {
  const b = await marketStocks({ chain: 'base' }); assert.equal(b.stocks.length, 10);
  const nv = b.stocks.find(x => x.symbol === 'NVDAc')!; assert.equal(nv.ticker, 'NVDA'); assert.equal(nv.issuer, 'Coinbase'); assert.match(nv.address, /^0x[0-9a-fA-F]{40}$/);
  const r = await marketStocks({ chain: 'robinhood' }); assert.ok(r.stocks.length > 200); assert.ok(r.stocks.every(x => /^0x[0-9a-fA-F]{40}$/.test(x.address) && x.ticker === x.symbol));
  const n = await marketStocks({ chain: 'bnb' }); assert.ok(n.stocks.length >= 20); assert.ok(['CRCLB', 'MUB', 'NVDAB', 'SNDKB', 'TSLAB'].every(s => n.stocks.some(x => x.symbol === s))); assert.equal(n.stocks.find(x => x.symbol === 'MUB')!.ticker, 'MU');
  assert.deepEqual((await marketStocks({ chain: 'solana' })).stocks, []);
  await assert.rejects(marketStocks({ chain: 'eth' }), /Unknown chain/);
});

test('txTimes asks the node at most 4 at a time (40 at once went over Helius\'s per-second limit)', async () => {
  let now = 0, peak = 0; const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', sig = (i: number) => '5' + B58[i] + 'a'.repeat(85);
  const fetch = (async (_u: string, init: any) => { now++; peak = Math.max(peak, now); await new Promise(r => setTimeout(r, 5)); now--;
    const id = JSON.parse(init.body).params[0]; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { blockTime: 1_700_000_000 + B58.indexOf(id[1]) } })); }) as any;
  const hashes = Array.from({ length: 20 }, (_, i) => sig(i));
  const r = await txTimes({ chain: 'solana', hashes }, { fetch, env: { HELIUS_API_KEY: 'h' } as any });
  assert.ok(peak <= 4 && peak > 1, `peak in flight ${peak}`); assert.equal(Object.values(r.times).filter(t => t != null).length, 20);
});

// ---- holdings and history from the chain on any node (QuickNode on the public site), 2026-11-24 ----
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
/** aggregate3's answer: (bool success, bytes returnData)[] */
const agg3 = (rs: (bigint | null)[]) => { let head = '', body = '', off = rs.length * 32;
  for (const r of rs) { head += w(off); const el = r == null ? w(0) + w(0x40) + w(0) : w(1) + w(0x40) + w(32) + w(r); body += el; off += el.length / 2; }
  return '0x' + w(32) + w(rs.length) + head + body; };

test('balancesOf reads many balanceOf answers out of one Multicall3 call, null where a call failed', async () => {
  let sent: any; const out = await balancesOf([A, B, '0x' + '3'.repeat(40)], '0x' + '9'.repeat(40), async (m, p: any) => { sent = { m, p }; return agg3([5n, null, 10n ** 24n]); });
  assert.deepEqual(out, [5n, null, 10n ** 24n]);
  assert.equal(sent.m, 'eth_call'); assert.equal(sent.p[0].to, '0xcA11bde05977b3631167028862bE2a173976CA11'); assert.ok(sent.p[0].data.startsWith('0x82ad56cb'));
  assert.ok(sent.p[0].data.includes('70a08231' + '9'.repeat(40).padStart(64, '0')), 'each call is balanceOf(owner)');
});

test('chainRpc uses <CHAIN>_RPC_URL first and Alchemy only when it is unset', () => {
  assert.equal(chainRpc('base', { BASE_RPC_URL: ' https://x.quiknode.pro/k/ ', ALCHEMY_API_KEY: 'a' } as any), 'https://x.quiknode.pro/k/');
  assert.equal(chainRpc('bnb', { ALCHEMY_API_KEY: 'a' } as any), 'https://bnb-mainnet.g.alchemy.com/v2/a');
  assert.equal(chainRpc('robinhood', {} as any), '');
});

test('EVM holdings work on a plain node: balanceOf for stock tokens and the tokens the app names, when the Token API add-on is off', async () => {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: any) => {
    if (String(url).includes('dexscreener')) return json([]);
    const b = JSON.parse(init.body); calls.push(b.method);
    if (b.method === 'qn_getWalletTokenBalance') return json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'token api is not enabled' } });
    if (b.method === 'eth_call' && b.params[0].to === '0xcA11bde05977b3631167028862bE2a173976CA11') { const n = Number(BigInt('0x' + b.params[0].data.slice(2 + 8 + 64, 2 + 8 + 128))); return json({ jsonrpc: '2.0', id: 1, result: agg3(Array.from({ length: n }, (_, i) => i === 0 ? 7n : 0n)) }); }
    return json({ jsonrpc: '2.0', id: 1, result: '0x12' });   // decimals() = 18
  }) as any;
  const r = await marketHoldings({ chain: 'base', address: '0x' + '9'.repeat(40), tokens: [A] }, { fetch, env: { BASE_RPC_URL: 'https://x.quiknode.pro/k/' } as any });
  assert.deepEqual(r.holdings.map((h: any) => [h.token, h.raw]), [[A, '7']], 'the named token first in the batch, held 7');
  assert.ok(calls.includes('qn_getWalletTokenBalance') && !calls.some(m => m.startsWith('alchemy_')), 'QuickNode tried, Alchemy never');
});

test('solActivity reads a buy, a sell and a received token from the wallet\'s balance changes (fee given back, wrapped SOL counted as SOL)', () => {
  const me = 'Me11111111111111111111111111111111111111111', tok = (owner: string, mint: string, amount: string) => ({ owner, mint, uiTokenAmount: { amount } });
  const tx = (pre: number, post: number, preT: any[], postT: any[], fee = 5000, err: any = null) => ({ blockTime: 1_700_000_000, transaction: { message: { accountKeys: [{ pubkey: me }, { pubkey: 'Other' }] } }, meta: { err, fee, preBalances: [pre, 0], postBalances: [post, 0], preTokenBalances: preT, postTokenBalances: postT } });
  const buy = solActivity(tx(1_000_000_000, 499_995_000, [], [tok(me, MINT, '123')]), 'sig1', me)!;
  assert.deepEqual([buy.side, buy.token, buy.tokenRaw, buy.native, buy.when], ['buy', MINT, '123', '500000000', 1_700_000_000_000]);
  const sell = solActivity(tx(0, 0, [tok(me, MINT, '123'), tok(me, 'So11111111111111111111111111111111111111112', '0')], [tok(me, MINT, '0'), tok(me, 'So11111111111111111111111111111111111111112', '200000000')], 0), 'sig2', me)!;
  assert.deepEqual([sell.side, sell.tokenRaw, sell.native], ['sell', '123', '200000000'], 'wrapped SOL received counts as SOL');
  assert.equal(solActivity(tx(10, 10, [], [tok(me, MINT, '5')], 0), 's', 'Someone1111111111111111111111111111111111111')?.side, undefined, 'another wallet\'s change is not this wallet\'s');
  assert.equal(solActivity(tx(10, 10, [], [tok(me, MINT, '5')], 0), 's', me)?.side, 'receive');
});

test('EVM history says plainly that it needs QuickNode\'s Token API add-on when the endpoint lacks it', async () => {
  const fetch = (async () => json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'token api is not enabled' } })) as any;
  const r = await marketActivity({ chain: 'bnb', address: '0x' + '9'.repeat(40) }, { fetch, env: { BNB_RPC_URL: 'https://x.quiknode.pro/k/' } as any });
  assert.equal(r.trades.length, 0); assert.match(r.unsupported!, /Token and NFT API.*BNB_RPC_URL/);
});
