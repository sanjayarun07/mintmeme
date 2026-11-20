/** BUILDS THE BNB CHAIN bSTOCKS REGISTRY (packages/evm/src/bnbstocklist.generated.ts). READ-ONLY: only eth_call / eth_getStorageAt and public quote APIs; nothing is signed or sent.
 *   1. Candidates: CoinGecko's coin list (keyless), every coin named "(bStocks Tokenized Stock)" with a BNB Smart Chain address. Binance publishes no address list, so this is
 *      only where candidates come from: a wrong or fake entry is dropped by step 2.
 *   2. On chain, each must be a beacon proxy of the bStocks beacon BSTOCKS_BEACON (EIP-1967 beacon slot), with 18 decimals and the same symbol as listed. The share
 *      multiplier (uiMultiplier(), BEP-677 Scaled UI) is read too.
 *   3. Market: DexScreener's deepest pair (liquidity, USD); the share price from Jupiter for any Solana issuer of the same ticker (stockData.price); a 0.01 BNB KyberSwap
 *      buy, priced per share with the multiplier. Tradable when liquidity is at least MIN_LIQ_USD and the route is at most 3% worse and at most MAX_TOO_GOOD_PCT better
 *      than the share price (the server re-checks every trade the same way: apps/server/baseaccount.ts).
 *  usage: npm run stocks:bnb   (BNB_RPC_URL optional, default the public RPC; JUPITER_API_KEY optional). Takes a few minutes. */
import { writeFileSync } from 'node:fs';
import { KyberClient } from '../../evm/src/kyber.ts';
import { BSTOCKS_BEACON } from '../../evm/src/bnbstocks.ts';
import { NATIVE } from '../../core/src/index.ts';
import { STOCKS_SOLANA, underlying, JupiterStockPrices, checkFillPrice } from '../../sol/src/index.ts';
import { EvmJsonRpc, baseEthUsd, EVM_NETWORKS } from '../../sdk/src/base.ts';
import { MAX_TOO_GOOD_PCT } from '../../../apps/server/baseaccount.ts';

const RPC = process.env.BNB_RPC_URL?.trim() || 'https://bsc-dataseed.bnbchain.org', MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD ?? 10_000), REF_WEI = 10n ** 16n;
const SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let id = 0;
async function rpc(method: string, params: unknown[]): Promise<string | null> {
  for (let k = 0; k < 5; k++) {
    try { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json(); if (j.error) return null; return j.result ?? null; }
    catch { await sleep(1000 * (k + 1)); }
  }
  throw new Error(`${method} did not answer after 5 tries`);
}
const str = (h: string | null) => { if (!h || h === '0x') return null; try { const b = Buffer.from(h.slice(2), 'hex'), n = Number(BigInt('0x' + b.subarray(32, 64).toString('hex'))); return b.subarray(64, 64 + n).toString(); } catch { return null; } };

// 1. candidates
const list: any[] = await (await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true', { signal: AbortSignal.timeout(60_000) })).json();
const cands = list.filter(c => /\(bStocks Tokenized Stock\)/i.test(c.name) && c.platforms?.['binance-smart-chain'])
  .map(c => ({ symbol: String(c.symbol).toUpperCase(), name: String(c.name).replace(/\s*\(bStocks Tokenized Stock\)/i, '').trim(), address: String(c.platforms['binance-smart-chain']).toLowerCase() }));
console.log(`${cands.length} candidates from CoinGecko`);

// 2. on chain
type Row = { symbol: string; name: string; address: string; mult: string; liq: number | null; dev: number | null; ok: 0 | 1 };
const rows: Row[] = [], dropped: string[] = [];
for (const c of cands) {
  const [b, s, d, m] = await Promise.all([rpc('eth_getStorageAt', [c.address, SLOT, 'latest']), rpc('eth_call', [{ to: c.address, data: '0x95d89b41' }, 'latest']), rpc('eth_call', [{ to: c.address, data: '0x313ce567' }, 'latest']), rpc('eth_call', [{ to: c.address, data: '0xa60bf13d' }, 'latest'])]);
  const beaconOk = !!b && ('0x' + b.slice(26)).toLowerCase() === BSTOCKS_BEACON, sym = str(s), dec = d && d !== '0x' ? Number(BigInt(d)) : null, mult = m && m !== '0x' ? BigInt(m) : 0n;
  if (!beaconOk || dec !== 18 || sym?.toUpperCase() !== c.symbol || mult <= 0n) { dropped.push(`${c.symbol}(${!beaconOk ? 'not a bStock' : dec !== 18 ? 'decimals' : mult <= 0n ? 'no multiplier' : 'symbol'})`); continue; }
  rows.push({ symbol: sym!, name: c.name, address: c.address, mult: `${mult / 10n ** 18n}.${(mult % 10n ** 18n).toString().padStart(18, '0')}`.replace(/\.?0+$/, ''), liq: null, dev: null, ok: 0 });
}
console.log(`${rows.length} verified on chain; dropped ${dropped.length}${dropped.length ? ': ' + dropped.join(' ') : ''}`);

// 3. market
for (let i = 0; i < rows.length; i += 30) {
  const part = rows.slice(i, i + 30), j: any = await (await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${part.map(r => r.address).join(',')}`, { signal: AbortSignal.timeout(20_000) })).json();
  for (const p of Array.isArray(j) ? j : []) { const r = part.find(x => x.address === String(p.baseToken?.address).toLowerCase()), u = Math.round(p.liquidity?.usd ?? 0); if (r && u > (r.liq ?? 0)) r.liq = u; }
  await sleep(500);
}
const bnb = await baseEthUsd(new EvmJsonRpc(RPC), 30_000, EVM_NETWORKS.bnb)(); if (!bnb) throw new Error('no BNB price');
const prices = new JupiterStockPrices({ apiKey: process.env.JUPITER_API_KEY?.trim() }), kyber = new KyberClient({ chain: 'bsc', clientId: process.env.KYBER_CLIENT_ID?.trim() || 'memedesk' });
let failed = 0;
for (const r of rows) {
  const mints = STOCKS_SOLANA.filter(a => underlying(a) === r.symbol.slice(0, -1)).map(a => a.mint);
  let ref: number | null = null; if (mints.length) { const g = await prices.get(mints); for (const m of mints) { const p = g.get(m)?.stockPrice; if (p) { ref = p; break; } } }
  if (ref && (r.liq ?? 0) >= MIN_LIQ_USD) {
    try { const q = await kyber.quote(NATIVE, r.address, REF_WEI), c = checkFillPrice({ side: 'buy', solLamports: REF_WEI / 10n ** 9n, tokensRaw: q.amountOut, decimals: 18, multiplier: r.mult, solUsd: bnb.price, referenceUsd: ref, maxDeviationPct: 3 });
      r.dev = c.deviationPct; r.ok = c.ok && (c.deviationPct ?? 0) >= -MAX_TOO_GOOD_PCT ? 1 : 0; }
    catch { failed++; }
  }
  await sleep(700);
}

// 4. write
const at = new Date().toISOString(), tradable = rows.filter(r => r.ok).length;
if (failed) console.log(`WARNING: ${failed} quotes failed: re-run before relying on it`);
rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
const meta = { generatedAt: at, bnbUsd: Math.round(bnb.price * 100) / 100, minLiquidityUsd: MIN_LIQ_USD, maxDeviationPct: 3, maxTooGoodPct: MAX_TOO_GOOD_PCT, refWei: String(REF_WEI), candidates: cands.length, verified: rows.length, dropped, tradable, quoteErrors: failed };
writeFileSync('packages/evm/src/bnbstocklist.generated.ts', `/** GENERATED by packages/live/src/bnbstockregistry.ts (npm run stocks:bnb) on ${at}. Do not edit by hand: run it again.
 *  Every row was verified on chain to be a beacon proxy of the bStocks beacon (bnbstocks.ts BSTOCKS_BEACON) with 18 decimals; candidates came from CoinGecko's coin list.
 *  Market columns are a snapshot from that run: DexScreener liquidity in USD, a 0.01 BNB KyberSwap buy's price per share against the share price in percent (null: not
 *  quoted), and whether that was tradable (1) then. The server re-checks every trade against the share price, whatever this says. */
export const BNB_STOCK_LIST_META = ${JSON.stringify(meta)} as const;
/** [symbol, address, company, shares per token (uiMultiplier), liquidity USD | null, route deviation % | null, tradable 0/1] */
export const BNB_STOCK_LIST: readonly (readonly [string, string, string, string, number | null, number | null, 0 | 1])[] = [
${rows.map(r => `  [${JSON.stringify(r.symbol)},${JSON.stringify(r.address)},${JSON.stringify(r.name)},${JSON.stringify(r.mult)},${r.liq ?? 'null'},${r.dev ?? 'null'},${r.ok}],`).join('\n')}
];
`);
console.log(`wrote ${rows.length} bStocks (${tradable} tradable now) to packages/evm/src/bnbstocklist.generated.ts`);
