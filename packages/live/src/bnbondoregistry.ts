/** BUILDS THE BNB CHAIN ONDO REGISTRY (packages/evm/src/bnbondolist.generated.ts). READ-ONLY: only eth_call / eth_getStorageAt and public quote APIs; nothing is signed or sent.
 *  Ondo Global Markets issues tokenized stocks and ETFs on Ethereum, BNB Chain and Solana (docs.ondo.finance: chains ethereum-1, bsc-56, solana-900). Its address API
 *  needs a key, so:
 *   1. Candidates: DexScreener search for every Ondo ticker this repo knows on Solana (packages/sol/src/stocklist.generated.ts, issuer 'on'), BNB Chain pairs whose
 *      token is named "... (Ondo Tokenized ...)" with that exact symbol. Only where candidates come from: a wrong or fake entry is dropped by step 2.
 *   2. On chain, each must be a beacon proxy of the Ondo beacon ONDO_BNB_BEACON (EIP-1967 beacon slot), with 18 decimals and the same symbol. Ondo's EVM tokens have no
 *      uiMultiplier(): one token is one share (TSLAon 381.52 on BNB Chain against Tesla's 384.54 on 2026-11-24).
 *   3. Market: DexScreener's deepest pair (liquidity, USD); the share price from Jupiter for a Solana issuer of the same ticker; a 0.01 BNB KyberSwap buy, priced per
 *      share. Tradable when liquidity is at least MIN_LIQ_USD and the route is at most 3% worse and at most MAX_TOO_GOOD_PCT better than the share price (the server
 *      re-checks every trade the same way: apps/server/baseaccount.ts).
 *  usage: npm run stocks:ondo-bnb   (BNB_RPC_URL optional, default the public RPC; JUPITER_API_KEY optional). Takes a few minutes. */
import { writeFileSync } from 'node:fs';
import { KyberClient } from '../../evm/src/kyber.ts';
import { ONDO_BNB_BEACON } from '../../evm/src/bnbstocks.ts';
import { NATIVE } from '../../core/src/index.ts';
import { STOCKS_SOLANA, underlying, JupiterStockPrices, checkFillPrice } from '../../sol/src/index.ts';
import { STOCK_LIST } from '../../sol/src/stocklist.generated.ts';
import { EvmJsonRpc, baseEthUsd, EVM_NETWORKS } from '../../sdk/src/base.ts';
import { MAX_TOO_GOOD_PCT } from '../../../apps/server/baseaccount.ts';

const RPC = process.env.BNB_RPC_URL?.trim() || 'https://bsc-dataseed.bnbchain.org', MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD ?? 10_000), REF_WEI = 10n ** 16n;
const SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let id = 0;
async function rpc(method: string, params: unknown[]): Promise<string | null> {
  for (let k = 0; k < 5; k++) {
    try { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
      // a rate limit (QuickNode answers -32007 "request limit reached", or HTTP 429) is retried, never read as "no answer": it once dropped 85 real Ondo tokens
      if (j.error) { if (r.status === 429 || /limit|exceed|too many|HTTP 5/i.test(String(j.error.message))) { await sleep(1000 * (k + 1)); continue; } return null; }
      return j.result ?? null; }
    catch { await sleep(1000 * (k + 1)); }
  }
  throw new Error(`${method} did not answer after 5 tries`);
}
const str = (h: string | null) => { if (!h || h === '0x') return null; try { const b = Buffer.from(h.slice(2), 'hex'), n = Number(BigInt('0x' + b.subarray(32, 64).toString('hex'))); return b.subarray(64, 64 + n).toString(); } catch { return null; } };

// 1. candidates
const tickers = [...new Set((STOCK_LIST as readonly (readonly unknown[])[]).filter(r => r[0] === 'on').map(r => String(r[1])))];
const cands = new Map<string, { symbol: string; name: string; address: string }>();
for (const t of tickers) {
  try { const j: any = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t)}`, { signal: AbortSignal.timeout(15_000) })).json();
    for (const p of j?.pairs ?? []) { const b = p?.baseToken; if (p?.chainId !== 'bsc' || b?.symbol !== t || !/\(Ondo Tokenized/i.test(b?.name ?? '')) continue;
      const a = String(b.address).toLowerCase(); if (!cands.has(a)) cands.set(a, { symbol: t, name: String(b.name).replace(/\s*\(Ondo Tokenized[^)]*\)/i, '').trim(), address: a }); } }
  catch { /* that ticker skipped: re-run to pick it up */ }
  await sleep(220);   // DexScreener search: 300 a minute
}
console.log(`${cands.size} candidates from DexScreener (${tickers.length} Ondo tickers searched)`);

// 2. on chain
type Row = { symbol: string; name: string; address: string; liq: number | null; dev: number | null; ok: 0 | 1 };
const rows: Row[] = [], dropped: string[] = [];
for (const c of cands.values()) {
  const [b, s, d] = await Promise.all([rpc('eth_getStorageAt', [c.address, SLOT, 'latest']), rpc('eth_call', [{ to: c.address, data: '0x95d89b41' }, 'latest']), rpc('eth_call', [{ to: c.address, data: '0x313ce567' }, 'latest'])]);
  const beaconOk = !!b && ('0x' + b.slice(26)).toLowerCase() === ONDO_BNB_BEACON, sym = str(s), dec = d && d !== '0x' ? Number(BigInt(d)) : null;
  if (!beaconOk || dec !== 18 || sym !== c.symbol) { dropped.push(`${c.symbol}(${!beaconOk ? 'not Ondo' : dec !== 18 ? 'decimals' : 'symbol'})`); continue; }
  rows.push({ symbol: sym!, name: c.name, address: c.address, liq: null, dev: null, ok: 0 });
  await sleep(150);
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
  if ((r.liq ?? 0) < MIN_LIQ_USD) continue;
  const mints = STOCKS_SOLANA.filter(a => underlying(a) === r.symbol.slice(0, -2)).map(a => a.mint);
  let ref: number | null = null; if (mints.length) { const g = await prices.get(mints); for (const m of mints) { const p = g.get(m)?.stockPrice; if (p) { ref = p; break; } } }
  if (ref) {
    try { const q = await kyber.quote(NATIVE, r.address, REF_WEI), c = checkFillPrice({ side: 'buy', solLamports: REF_WEI / 10n ** 9n, tokensRaw: q.amountOut, decimals: 18, multiplier: '1', solUsd: bnb.price, referenceUsd: ref, maxDeviationPct: 3 });
      r.dev = c.deviationPct; r.ok = c.ok && (c.deviationPct ?? 0) >= -MAX_TOO_GOOD_PCT ? 1 : 0; }
    catch { failed++; }
  }
  await sleep(700);
}

// 4. write
const at = new Date().toISOString(), tradable = rows.filter(r => r.ok).length;
if (failed) console.log(`WARNING: ${failed} quotes failed: re-run before relying on it`);
rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
const meta = { generatedAt: at, bnbUsd: Math.round(bnb.price * 100) / 100, minLiquidityUsd: MIN_LIQ_USD, maxDeviationPct: 3, maxTooGoodPct: MAX_TOO_GOOD_PCT, refWei: String(REF_WEI), tickersSearched: tickers.length, candidates: cands.size, verified: rows.length, dropped, tradable, quoteErrors: failed };
writeFileSync('packages/evm/src/bnbondolist.generated.ts', `/** GENERATED by packages/live/src/bnbondoregistry.ts (npm run stocks:ondo-bnb) on ${at}. Do not edit by hand: run it again.
 *  Every row was verified on chain to be a beacon proxy of Ondo's BNB Chain beacon (bnbstocks.ts ONDO_BNB_BEACON) with 18 decimals; candidates came from DexScreener.
 *  One token is one share (no uiMultiplier). Market columns are a snapshot from that run: DexScreener liquidity in USD, a 0.01 BNB KyberSwap buy's price per share
 *  against the share price in percent (null: not quoted), and whether that was tradable (1) then. The server re-checks every trade against the share price. */
export const BNB_ONDO_LIST_META = ${JSON.stringify(meta)} as const;
/** [symbol, address, company, liquidity USD | null, route deviation % | null, tradable 0/1] */
export const BNB_ONDO_LIST: readonly (readonly [string, string, string, number | null, number | null, 0 | 1])[] = [
${rows.map(r => `  [${JSON.stringify(r.symbol)},${JSON.stringify(r.address)},${JSON.stringify(r.name)},${r.liq ?? 'null'},${r.dev ?? 'null'},${r.ok}],`).join('\n')}
];
`);
console.log(`wrote ${rows.length} Ondo tokens (${tradable} tradable now) to packages/evm/src/bnbondolist.generated.ts`);
