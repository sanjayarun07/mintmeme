/** BUILDS THE SOLANA STOCK REGISTRY (packages/sol/src/stocklist.generated.ts) from the issuers' own lists, verified on chain, with a market check. READ-ONLY: GuardedRpc refuses every
 *  state-changing RPC method; nothing is signed or sent.
 *   1. Sources (official): xStocks issuer API https://api.xstocks.fi/api/v2/public/assets (paged, deployments[] network Solana); Ondo's address CSV linked from
 *      https://docs.ondo.finance/addresses.md (column "Solana Deployed Address"); Backpack's exchange API https://api.backpack.exchange/api/v1/assets (tokens[] blockchain Solana;
 *      it also lists crypto, which step 2 drops).
 *   2. Every mint is read on chain: it must be a Token-2022 mint whose freeze authority, pause authority and permanent delegate (or none, for Ondo) equal that issuer's pinned
 *      keys (packages/sol/src/xstocks.ts). Anything else is left out and counted. The symbol is the mint's own tokenMetadata symbol.
 *   3. Market: Jupiter Price API V3 (liquidity, `stockData.price` = the underlying share price). Mints with a share price and at least MIN_LIQ_USD of liquidity get a 0.05 SOL
 *      Jupiter quote; its price per share (with the mint's multiplier) against the share price decides `tradable` (at most 3% worse, as the server's fill-price check).
 *  usage: npm run stocks:registry   (SOL_RPC_URL optional, default the public RPC; ONDO_CSV_URL / ONDO_CSV_FILE override the Ondo source). Takes several minutes (Jupiter's keyless limit). */
import { writeFileSync, readFileSync } from 'node:fs';
import { GuardedRpc } from './solreadonly.ts';
import { XSTOCKS_KEYS, ONDO_KEYS, BACKPACK_KEYS, PROGRAMS, stockStateOf, checkFillPrice, looksLikeMint } from '../../sol/src/index.ts';
import { fetchJupiterQuote } from '../../sol/src/jupiter.ts';

const WSOL = 'So11111111111111111111111111111111111111112', MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD ?? 10_000), REF_LAMPORTS = 50_000_000n;
const ONDO_CSV = process.env.ONDO_CSV_URL ?? 'https://www.dropbox.com/scl/fi/qjfxyg748mx0dwi6up86d/EXTERNAL-Ondo-GM-Tokens-Ondo-GM-Tokens.csv?rlkey=n3no1w78wrah3umsl0nr9s77i&dl=1';
const rpc = new GuardedRpc(process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com'), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'memedesk-stock-registry' };
/** Public endpoints rate-limit (HTTP 429) and drop calls: retry with backoff, then give up on that item (it is counted, never guessed). */
async function retry<T>(f: () => Promise<T>, tries = 5): Promise<T> { let e: unknown; for (let i = 0; i < tries; i++) { try { return await f(); } catch (x) { e = x; await sleep(2000 * 2 ** i); } } throw e; }
const getJson = async (url: string) => { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`); return r.json(); };
type Code = 'x' | 'on' | 'bp';
const KEYS: Record<Code, { freezeAuthority: string; permanentDelegate: string | null; pauseAuthority: string }> = { x: XSTOCKS_KEYS, on: ONDO_KEYS, bp: BACKPACK_KEYS };
interface Cand { code: Code; mint: string; listed: string; underlying?: string }

/** A small RFC 4180 CSV reader (quoted fields with commas, doubled quotes, newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += ch; }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows.filter(r => r.some(x => x.trim())); return rest.map(r => Object.fromEntries(h.map((k, i) => [k.trim(), (r[i] ?? '').trim()])));
}

async function sources(): Promise<{ cands: Cand[]; counts: Record<Code, number> }> {
  const cands: Cand[] = [];
  for (let page = 0; page < 100; page++) {   // xStocks: 100 per page
    const j: any = await (await fetch(`https://api.xstocks.fi/api/v2/public/assets?page=${page}`, { headers: UA })).json();
    for (const a of j.nodes ?? []) for (const d of a.deployments ?? []) if (d.network === 'Solana' && d.address) cands.push({ code: 'x', mint: d.address, listed: a.symbol, underlying: a.underlyingSymbol });
    if (!j.page?.hasNextPage) break;
  }
  const csv = process.env.ONDO_CSV_FILE ? readFileSync(process.env.ONDO_CSV_FILE, 'utf8') : await (await fetch(ONDO_CSV, { headers: UA })).text();
  for (const r of parseCsv(csv)) if (r['Solana Deployed Address']) cands.push({ code: 'on', mint: r['Solana Deployed Address'], listed: r['Symbol'], underlying: r['Stock Ticker'] || undefined });
  const bp: any[] = await (await fetch('https://api.backpack.exchange/api/v1/assets', { headers: UA })).json();
  for (const a of bp) for (const t of a.tokens ?? []) if (t.blockchain === 'Solana' && t.contractAddress) cands.push({ code: 'bp', mint: t.contractAddress, listed: a.symbol });
  const counts = { x: 0, on: 0, bp: 0 }; for (const c of cands) counts[c.code]++;
  return { cands, counts };
}

const { cands, counts: listed } = await sources(); console.log('listed by issuers (Solana):', listed);
// 2. on chain, 100 mints per call
type Row = { code: Code; symbol: string; mint: string; decimals: number; underlying: string; multiplier: string };
const rows: Row[] = [], dropped: Record<string, number> = {}, seen = new Set<string>(); const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
const uniq = cands.filter(c => { if (!looksLikeMint(c.mint)) { drop(`${c.code}: not a Solana address`); return false; } return seen.has(c.mint) ? false : (seen.add(c.mint), true); });   // e.g. Backpack lists native SOL as "So1"
/** One RPC call for the batch; if the node rejects it (one malformed address fails the whole call), split it in halves down to single mints, so only the bad one is lost. */
async function readBatch(mints: string[]): Promise<{ value: any[] }> {
  try { return await retry(() => rpc.call('getMultipleAccounts', [mints, { encoding: 'jsonParsed', commitment: 'confirmed' }]), mints.length > 1 ? 2 : 3); }
  catch (e) { if (mints.length === 1) { console.log(`unreadable: ${mints[0]} (${(e as Error).message.slice(0, 80)})`); return { value: [undefined] }; }
    const h = mints.length >> 1; return { value: [...(await readBatch(mints.slice(0, h))).value, ...(await readBatch(mints.slice(h))).value] }; }
}
for (let i = 0; i < uniq.length; i += 100) {
  const batch = uniq.slice(i, i + 100), r = await readBatch(batch.map(c => c.mint));
  batch.forEach((c, k) => {
    const v = r.value[k]; if (v === undefined) return drop('rpc error');
    const info = v?.data?.parsed?.type === 'mint' ? v.data.parsed.info : undefined; if (!v || !info) return drop(`${c.code}: not a mint`);
    if (v.owner !== PROGRAMS.token2022) return drop(`${c.code}: not Token-2022 (crypto or other)`);
    const ext = (n: string) => (info.extensions ?? []).find((e: any) => e.extension === n)?.state, K = KEYS[c.code];
    if (info.freezeAuthority !== K.freezeAuthority || (ext('permanentDelegate')?.delegate ?? null) !== K.permanentDelegate || (ext('pausableConfig') ?? ext('pausable'))?.authority !== K.pauseAuthority) return drop(`${c.code}: keys are not the issuer's`);
    if (ext('transferHook')?.programId) return drop(`${c.code}: transfer hook set`);
    const symbol = String(ext('tokenMetadata')?.symbol ?? c.listed ?? '').trim(); if (!symbol) return drop(`${c.code}: no symbol`);
    if (c.code !== 'bp' && c.listed && symbol.toLowerCase() !== c.listed.toLowerCase()) return drop(`${c.code}: symbol differs from the issuer list`);
    const st = stockStateOf(c.mint, v)!;
    rows.push({ code: c.code, symbol, mint: c.mint, decimals: st.decimals, underlying: c.underlying ?? (c.code === 'x' ? symbol.replace(/x$/, '') : c.code === 'on' ? symbol.replace(/on$/, '') : symbol), multiplier: st.multiplier });
  });
}
console.log(`verified on chain: ${rows.length}; left out:`, dropped);
// 3. market: Jupiter prices (50 ids per call), then a quote for the liquid ones with a share price
const price = new Map<string, { liq: number; stock?: number }>(); let priceFailed = 0, quoteFailed = 0;
const solUsd = Number((await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { headers: UA })).json())[WSOL]?.usdPrice); if (!(solUsd > 0)) throw new Error('no SOL price');
for (let i = 0; i < rows.length; i += 50) {
  const ids = rows.slice(i, i + 50).map(r => r.mint); await sleep(1200);
  try { const j: any = await retry(() => getJson(`https://lite-api.jup.ag/price/v3?ids=${ids.join(',')}`));
    for (const id of ids) { const p = j?.[id]; if (p) price.set(id, { liq: Number(p.liquidity ?? 0), stock: Number(p.stockData?.price) > 0 ? Number(p.stockData.price) : undefined }); } } catch { priceFailed += ids.length; }
}
const market = new Map<string, { liq: number; dev: number | null; ok: boolean }>(); let quoted = 0;
for (const r of rows) {
  const p = price.get(r.mint); if (!p) continue; if (!p.stock || p.liq < MIN_LIQ_USD) { market.set(r.mint, { liq: Math.round(p.liq), dev: null, ok: false }); continue; }
  await sleep(2200); quoted++;
  try { const q = await retry(() => fetchJupiterQuote({ inputMint: WSOL, outputMint: r.mint, amount: REF_LAMPORTS, timeoutMs: 10_000 }).catch(e => { if (/HTTP 400/.test(String(e))) return null; throw e; }), 4);   // 400: no route (final)
    if (!q) { market.set(r.mint, { liq: Math.round(p.liq), dev: null, ok: false }); continue; }
    const c = checkFillPrice({ side: 'buy', solLamports: REF_LAMPORTS, tokensRaw: q.outAmount, decimals: r.decimals, multiplier: r.multiplier, solUsd, referenceUsd: p.stock });
    market.set(r.mint, { liq: Math.round(p.liq), dev: c.deviationPct, ok: c.ok }); }
  catch { quoteFailed++; market.set(r.mint, { liq: Math.round(p.liq), dev: null, ok: false }); }
  if (quoted % 20 === 0) console.log(`quoted ${quoted}...`);
}
// 4. write the registry
const at = new Date().toISOString(), tradable = rows.filter(r => market.get(r.mint)?.ok).length;
const byCode = (k: Code) => rows.filter(r => r.code === k).length, tradableBy = (k: Code) => rows.filter(r => r.code === k && market.get(r.mint)?.ok).length;
if (dropped['rpc error'] || priceFailed || quoteFailed) console.log(`WARNING: incomplete run (rpc ${dropped['rpc error'] ?? 0}, price ${priceFailed}, quote ${quoteFailed}): re-run before relying on it`);
const meta = { generatedAt: at, solUsd: Math.round(solUsd * 100) / 100, minLiquidityUsd: MIN_LIQ_USD, maxDeviationPct: 3, refLamports: Number(REF_LAMPORTS), listed, dropped, unpriced: priceFailed, quoteErrors: quoteFailed,
  verified: { x: byCode('x'), on: byCode('on'), bp: byCode('bp') }, tradable: { x: tradableBy('x'), on: tradableBy('on'), bp: tradableBy('bp') } };
rows.sort((a, b) => a.code.localeCompare(b.code) || a.symbol.localeCompare(b.symbol));
const line = (r: Row) => { const m = market.get(r.mint); return `  [${JSON.stringify(r.code)},${JSON.stringify(r.symbol)},${JSON.stringify(r.mint)},${r.decimals},${JSON.stringify(r.underlying)},${m ? m.liq : 'null'},${m?.dev ?? 'null'},${m?.ok ? 1 : 0}],`; };
writeFileSync('packages/sol/src/stocklist.generated.ts', `/** GENERATED by packages/live/src/stockregistry.ts (npm run stocks:registry) on ${at}. Do not edit by hand: run it again.
 *  Every row is a mint from the issuer's own list, verified on chain to carry that issuer's pinned keys (xstocks.ts). Market columns are a snapshot from that run:
 *  Jupiter liquidity in USD, the 0.05 SOL buy route's price per share against the share price in percent (null: not quoted), and whether that was tradable (1) then. */
export const STOCK_LIST_META = ${JSON.stringify(meta)} as const;
/** [issuer ('x' xStocks, 'on' Ondo, 'bp' Backpack), symbol, mint, decimals, underlying ticker, liquidity USD | null, route deviation % | null, tradable 0/1] */
export const STOCK_LIST: readonly (readonly ['x' | 'on' | 'bp', string, string, number, string, number | null, number | null, 0 | 1])[] = [
${rows.map(line).join('\n')}
];
`);
console.log(`wrote ${rows.length} stocks (${tradable} tradable now) to packages/sol/src/stocklist.generated.ts`, meta.tradable);
