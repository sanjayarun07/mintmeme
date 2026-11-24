/** Market data for the trading app (/app): trending and new tokens on Solana, Base, Robinhood Chain and BNB Chain, one token's detail, price candles and search.
 *  Read-only, keyless public sources, fetched by this server (never the browser) and cached so the app stays inside their free limits:
 *    - Jupiter tokens v2 (Solana): trending and recent tokens with holders, organic score and audit flags;
 *    - GeckoTerminal (every chain): trending and new pools, OHLCV candles. About 30 calls a minute, so lists are cached 60 s and candles 30 s, and a stale copy is served on a 429;
 *    - DexScreener (every chain): one token's pairs (price, liquidity, volume, buys and sells), and search.
 *  Every row is normalized to one shape (MarketRow) so the app never cares where it came from. Nothing here signs, trades or needs a key. */

import { solanaRpc, solanaRpcFallback } from '../../packages/live/src/config.ts';
export type Chain = 'solana' | 'base' | 'robinhood' | 'bnb';
export const CHAINS: Chain[] = ['solana', 'base', 'robinhood', 'bnb'];
const GECKO: Record<Chain, string> = { solana: 'solana', base: 'base', robinhood: 'robinhood', bnb: 'bsc' };
const DEXS: Record<Chain, string> = { solana: 'solana', base: 'base', robinhood: 'robinhood', bnb: 'bsc' };
const FROM_DEXS: Record<string, Chain> = { solana: 'solana', base: 'base', robinhood: 'robinhood', bsc: 'bnb' };

export type MarketRow = {
  chain: Chain; address: string; pool: string | null; symbol: string; name: string; icon: string | null;
  price: number | null; change1h: number | null; change24h: number | null; mcap: number | null; liquidity: number | null; volume24h: number | null;
  buys24h: number | null; sells24h: number | null; createdAt: string | null; holders: number | null; organic: string | null; verified: boolean;
};
export type Deps = { fetch?: typeof fetch; now?: () => number };
class MarketError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const num = (x: unknown) => { const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN; return Number.isFinite(n) ? n : null; };
/** A size that must be above zero: sources send "0" when they do not know it. */
const pos = (x: unknown) => { const n = num(x); return n != null && n > 0 ? n : null; };
const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a), isSol = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const chainOf = (c: unknown, all = false): Chain | 'all' => { if (all && (c === undefined || c === 'all')) return 'all'; if (typeof c === 'string' && (CHAINS as string[]).includes(c)) return c as Chain; throw new MarketError(`Unknown chain "${String(c)}". Use solana, base, robinhood or bnb.`); };

/** A tiny TTL cache that remembers the last good answer: a failed or rate-limited refresh serves it (marked stale) instead of an error. */
const cache = new Map<string, { at: number; value: unknown }>();
export function clearMarketCache() { cache.clear(); }
async function cached<T>(key: string, ttlMs: number, d: Deps, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const now = (d.now ?? Date.now)(), hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return { value: hit.value as T, stale: false };
  try { const value = await load(); cache.set(key, { at: now, value }); if (cache.size > 500) cache.delete(cache.keys().next().value!); return { value, stale: false }; }
  catch (e) { if (hit) return { value: hit.value as T, stale: true }; throw e; }
}
async function getJson(d: Deps, url: string): Promise<any> {
  const r = await (d.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (r.status === 429) throw new MarketError('The market data source is busy (rate limit). Try again in a minute.', 503);
  if (!r.ok) throw new MarketError(`The market data source answered HTTP ${r.status}.`, 502);
  return r.json();
}

/** Jupiter token (tokens v2) to a row. */
export function fromJupiter(t: any): MarketRow {
  const s = t?.stats24h ?? {};
  return { chain: 'solana', address: String(t.id), pool: t?.firstPool?.id ?? null, symbol: String(t.symbol ?? '?'), name: String(t.name ?? ''), icon: t.icon ?? null,
    price: num(t.usdPrice), change1h: num(t?.stats1h?.priceChange), change24h: num(s.priceChange), mcap: num(t.mcap ?? t.fdv), liquidity: num(t.liquidity),
    volume24h: s.buyVolume != null || s.sellVolume != null ? (num(s.buyVolume) ?? 0) + (num(s.sellVolume) ?? 0) : null, buys24h: num(s.numBuys), sells24h: num(s.numSells),
    createdAt: t.createdAt ?? t?.firstPool?.createdAt ?? null, holders: num(t.holderCount), organic: t.organicScoreLabel ?? null, verified: !!t.isVerified };
}
/** GeckoTerminal pools (with included base tokens) to rows: one row per token, its most liquid pool. Pools whose base token is a stablecoin or the wrapped native coin are skipped. */
export function fromGecko(chain: Chain, j: any): MarketRow[] {
  const inc = new Map<string, any>((j?.included ?? []).map((i: any) => [i.id, i.attributes]));
  const skip = /^(W?ETH|WBNB|BNB|SOL|WSOL|USDC|USDT|USDG|DAI|USD1|FDUSD)$/i, best = new Map<string, MarketRow>();
  for (const p of j?.data ?? []) {
    const a = p?.attributes ?? {}, t = inc.get(p?.relationships?.base_token?.data?.id) ?? {}, address = String(t.address ?? '');
    if (!address || skip.test(String(t.symbol ?? ''))) continue;
    const tx = a?.transactions?.h24 ?? {};
    const row: MarketRow = { chain, address, pool: a.address ?? null, symbol: String(t.symbol ?? '?'), name: String(t.name ?? ''), icon: t.image_url && t.image_url !== 'missing.png' ? t.image_url : null,
      price: num(a.base_token_price_usd), change1h: num(a?.price_change_percentage?.h1), change24h: num(a?.price_change_percentage?.h24), mcap: saneCap(pos(a.market_cap_usd), pos(a.fdv_usd), num(a.reserve_in_usd)),
      liquidity: num(a.reserve_in_usd), volume24h: num(a?.volume_usd?.h24), buys24h: num(tx.buys), sells24h: num(tx.sells), createdAt: a.pool_created_at ?? null, holders: null, organic: null, verified: false };
    const key = address.toLowerCase(), have = best.get(key);
    if (!have) best.set(key, row);
    else { const pick = (row.liquidity ?? 0) > (have.liquidity ?? 0) ? row : have, other = pick === row ? have : row; best.set(key, { ...pick, volume24h: (pick.volume24h ?? 0) + (other.volume24h ?? 0) }); }
  }
  return [...best.values()];
}
/** DexScreener pair to a row. */
/** A market cap below the pool's own liquidity is a bad supply figure (seen on stock tokens, e.g. $91 against $651k of liquidity): FDV if that one is sane, else unknown. */
const saneCap = (mcap: number | null, fdv: number | null, liq: number | null) => liq == null ? mcap ?? fdv : mcap != null && mcap >= liq ? mcap : fdv != null && fdv >= liq ? fdv : null;
export function fromDexscreener(p: any): MarketRow | null {
  const chain = FROM_DEXS[p?.chainId]; if (!chain) return null;
  const row = fromDexscreenerRaw(p, chain); row.mcap = saneCap(pos(p.marketCap), pos(p.fdv), row.liquidity); return row;
}
function fromDexscreenerRaw(p: any, chain: Chain): MarketRow {
  return { chain, address: String(p.baseToken?.address ?? ''), pool: p.pairAddress ?? null, symbol: String(p.baseToken?.symbol ?? '?'), name: String(p.baseToken?.name ?? ''), icon: p.info?.imageUrl ?? null,
    price: num(p.priceUsd), change1h: num(p.priceChange?.h1), change24h: num(p.priceChange?.h24), mcap: num(p.marketCap) ?? num(p.fdv), liquidity: num(p.liquidity?.usd), volume24h: num(p.volume?.h24),
    buys24h: num(p.txns?.h24?.buys), sells24h: num(p.txns?.h24?.sells), createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null, holders: null, organic: null, verified: false };
}

async function chainList(chain: Chain, tab: 'trending' | 'new', d: Deps): Promise<{ rows: MarketRow[]; stale: boolean }> {
  if (chain === 'solana') {
    const url = tab === 'trending' ? 'https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=50' : 'https://lite-api.jup.ag/tokens/v2/recent?limit=50';
    const { value, stale } = await cached(`jup:${tab}`, 60_000, d, () => getJson(d, url));
    return { rows: (Array.isArray(value) ? value : []).map(fromJupiter), stale };
  }
  const url = `https://api.geckoterminal.com/api/v2/networks/${GECKO[chain]}/${tab === 'trending' ? 'trending_pools' : 'new_pools'}?include=base_token&page=1`;
  const { value, stale } = await cached(`gecko:${chain}:${tab}`, 60_000, d, () => getJson(d, url));
  return { rows: fromGecko(chain, value), stale };
}

/** Trending or new tokens on one chain or on all of them (all: merged and ordered by 24h volume). A chain whose source fails is listed in `unavailable` instead of failing the whole list. */
export async function marketList(body: any, d: Deps = {}) {
  const chain = chainOf(body?.chain, true), tab = body?.tab === 'new' ? 'new' : 'trending';
  const chains = chain === 'all' ? CHAINS : [chain];
  const parts = await Promise.all(chains.map(async c => { try { return { c, ...(await chainList(c, tab, d)) }; } catch (e) { return { c, rows: [] as MarketRow[], stale: false, why: (e as Error).message }; } }));
  let rows = parts.flatMap(p => p.rows);
  if (tab === 'new') rows.sort((a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0')); else rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  rows = rows.slice(0, 100);
  return { chain, tab, rows, stale: parts.some(p => p.stale), unavailable: parts.filter(p => 'why' in p).map(p => ({ chain: p.c, why: (p as any).why })) };
}

/** One token: its most liquid pair (DexScreener) plus, on Solana, holders, organic score and audit flags from Jupiter. */
export async function marketToken(body: any, d: Deps = {}) {
  const chain = chainOf(body?.chain) as Chain, address = String(body?.address ?? '').trim();
  if (!(chain === 'solana' ? isSol(address) : isEvm(address))) throw new MarketError(chain === 'solana' ? 'That is not a Solana token address.' : 'That is not a 0x token address.');
  const { value: pairs, stale } = await cached(`dexs:${chain}:${address.toLowerCase()}`, 20_000, d, () => getJson(d, `https://api.dexscreener.com/tokens/v1/${DEXS[chain]}/${address}`));
  const list = (Array.isArray(pairs) ? pairs : []).filter((p: any) => String(p?.baseToken?.address ?? '').toLowerCase() === address.toLowerCase());
  list.sort((a: any, b: any) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
  let row = list.length ? fromDexscreener(list[0]) : null;
  const pools = list.slice(0, 5).map((p: any) => ({ dex: String(p.dexId ?? ''), pool: String(p.pairAddress ?? ''), quote: String(p.quoteToken?.symbol ?? ''), liquidity: num(p.liquidity?.usd), volume24h: num(p.volume?.h24) }));
  let audit: Record<string, unknown> | null = null, links: { website?: string; twitter?: string } = {};
  const info = list[0]?.info; if (info) { links.website = info.websites?.[0]?.url; links.twitter = info.socials?.find((s: any) => s.type === 'twitter')?.url; }
  if (chain === 'solana') {
    try {
      const { value } = await cached(`jupsearch:${address}`, 60_000, d, () => getJson(d, `https://lite-api.jup.ag/tokens/v2/search?query=${address}`));
      const t = (Array.isArray(value) ? value : []).find((x: any) => x?.id === address);
      if (t) { const j = fromJupiter(t); row = row ? { ...row, holders: j.holders, organic: j.organic, verified: j.verified, icon: row.icon ?? j.icon, mcap: row.mcap ?? j.mcap } : j;
        audit = { mintDisabled: t.audit?.mintAuthorityDisabled ?? null, freezeDisabled: t.audit?.freezeAuthorityDisabled ?? null, topHoldersPct: num(t.audit?.topHoldersPercentage), devPct: num(t.audit?.devBalancePercentage) };
        links = { website: links.website ?? t.website, twitter: links.twitter ?? t.twitter }; }
    } catch { /* the pair data alone is still useful */ }
  }
  if (!row) throw new MarketError('No market found for this token on that chain yet.', 404);
  return { token: row, pools, audit, links, stale };
}

const TF: Record<string, { unit: 'minute' | 'hour' | 'day'; aggregate: number }> = { '1m': { unit: 'minute', aggregate: 1 }, '5m': { unit: 'minute', aggregate: 5 }, '15m': { unit: 'minute', aggregate: 15 }, '1h': { unit: 'hour', aggregate: 1 }, '4h': { unit: 'hour', aggregate: 4 }, '1d': { unit: 'day', aggregate: 1 } };
/** OHLCV candles for one pool: [{ t (seconds), o, h, l, c, v }], oldest first. */
export async function marketCandles(body: any, d: Deps = {}) {
  const chain = chainOf(body?.chain) as Chain, pool = String(body?.pool ?? '').trim(), tf = TF[String(body?.tf ?? '15m')] ? String(body?.tf ?? '15m') : '15m';
  if (!(chain === 'solana' ? isSol(pool) : /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(pool))) throw new MarketError('That is not a pool address.');
  const { unit, aggregate } = TF[tf];
  const { value, stale } = await cached(`ohlcv:${chain}:${pool}:${tf}`, 30_000, d, () => getJson(d, `https://api.geckoterminal.com/api/v2/networks/${GECKO[chain]}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=300&currency=usd`));
  const list: any[] = value?.data?.attributes?.ohlcv_list ?? [];
  const candles = list.map(x => ({ t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
  return { chain, pool, tf, candles, stale };
}

const WRAPPED: Record<Chain, string> = { solana: 'So11111111111111111111111111111111111111112', base: '0x4200000000000000000000000000000000000006', robinhood: '0x0000000000000000000000000000000000000000', bnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' };
const NATIVE_SYMBOL: Record<Chain, string> = { solana: 'SOL', base: 'ETH', robinhood: 'ETH', bnb: 'BNB' };
/** USD price of each chain's native coin (Robinhood Chain pays in ETH, so it uses Base's WETH price). */
export async function marketNatives(_body: any = {}, d: Deps = {}) {
  const { value, stale } = await cached('natives', 60_000, d, async () => {
    const [jup, base, bnb] = await Promise.all([
      getJson(d, `https://lite-api.jup.ag/tokens/v2/search?query=${WRAPPED.solana}`).catch(() => []),
      getJson(d, `https://api.dexscreener.com/tokens/v1/base/${WRAPPED.base}`).catch(() => []),
      getJson(d, `https://api.dexscreener.com/tokens/v1/bsc/${WRAPPED.bnb}`).catch(() => []),
    ]);
    const top = (pairs: any, addr: string) => { const l = (Array.isArray(pairs) ? pairs : []).filter((p: any) => String(p?.baseToken?.address).toLowerCase() === addr.toLowerCase()).sort((a: any, b: any) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0)); return num(l[0]?.priceUsd); };
    const sol = num((Array.isArray(jup) ? jup : []).find((x: any) => x?.id === WRAPPED.solana)?.usdPrice), eth = top(base, WRAPPED.base);
    return { solana: sol, base: eth, robinhood: eth, bnb: top(bnb, WRAPPED.bnb) };
  });
  return { prices: value, symbols: NATIVE_SYMBOL, stale };
}

/** Decimals, symbol, icon and USD price for up to 30 tokens on one chain, so the app can show raw balances (positions, quotes) as plain amounts and dollars.
 *  Solana: Jupiter (one batched search). EVM: DexScreener for symbol and price, the chain's RPC for decimals() (ALCHEMY_API_KEY or <CHAIN>_RPC_URL). */
export async function marketMeta(body: any, d: Deps & { env?: NodeJS.ProcessEnv } = {}) {
  const chain = chainOf(body?.chain) as Chain, raw: unknown[] = Array.isArray(body?.tokens) ? body.tokens : [];
  const tokens = [...new Set(raw.map(x => String(x).trim()).filter(a => chain === 'solana' ? isSol(a) : isEvm(a)))].slice(0, 30);
  const out: Record<string, { symbol: string | null; name: string | null; decimals: number | null; price: number | null; icon: string | null }> = {};
  if (!tokens.length) return { chain, tokens: out };
  if (chain === 'solana') {
    const { value } = await cached(`jupmeta:${tokens.slice().sort().join(',')}`, 60_000, d, () => getJson(d, `https://lite-api.jup.ag/tokens/v2/search?query=${tokens.join(',')}`));
    for (const t of Array.isArray(value) ? value : []) if (tokens.includes(t?.id)) out[t.id] = { symbol: t.symbol ?? null, name: t.name ?? null, decimals: num(t.decimals), price: num(t.usdPrice), icon: t.icon ?? null };
    return { chain, tokens: out };
  }
  const env = d.env ?? process.env, rpc = chainRpc(chain, env);
  const [{ value: pairs }, decs] = await Promise.all([
    cached(`dexsmeta:${chain}:${tokens.slice().sort().join(',').toLowerCase()}`, 30_000, d, () => getJson(d, `https://api.dexscreener.com/tokens/v1/${DEXS[chain]}/${tokens.join(',')}`)),
    Promise.all(tokens.map(async a => { if (!rpc) return null;
      try { const { value } = await cached(`dec:${chain}:${a.toLowerCase()}`, 86_400_000, d, async () => {
        const r = await (d.fetch ?? fetch)(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: a, data: '0x313ce567' }, 'latest'] }), signal: AbortSignal.timeout(8_000) });
        const j: any = await r.json(); const n = typeof j?.result === 'string' && j.result.length > 2 ? parseInt(j.result, 16) : NaN; if (!Number.isFinite(n) || n > 36) throw new Error('no decimals'); return n; }); return value; } catch { return null; } })),
  ]);
  tokens.forEach((a, i) => {
    const l = (Array.isArray(pairs) ? pairs : []).filter((p: any) => String(p?.baseToken?.address).toLowerCase() === a.toLowerCase()).sort((x: any, y: any) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0));
    out[a.toLowerCase()] = { symbol: l[0]?.baseToken?.symbol ?? null, name: l[0]?.baseToken?.name ?? null, decimals: decs[i], price: num(l[0]?.priceUsd), icon: l[0]?.info?.imageUrl ?? null };
  });
  return { chain, tokens: out };
}

/** Full market rows (price, 1h/24h change, market cap, liquidity, volume, buys/sells, icon) for up to 90 known tokens on one chain: the most liquid pair of each, from DexScreener
 *  in batches of 30. For lists whose source has no market numbers (the server's stock list, the watchlist). A token with no pair is simply missing from `rows`. */
export async function marketRows(body: any, d: Deps = {}) {
  const chain = chainOf(body?.chain) as Chain, raw: unknown[] = Array.isArray(body?.tokens) ? body.tokens : [];
  const tokens = [...new Set(raw.map(x => String(x).trim()).filter(a => chain === 'solana' ? isSol(a) : isEvm(a)))].slice(0, 90);
  const rows: Record<string, MarketRow> = {};
  for (let i = 0; i < tokens.length; i += 30) {
    const part = tokens.slice(i, i + 30);
    const { value } = await cached(`dexsrows:${chain}:${part.slice().sort().join(',').toLowerCase()}`, 30_000, d, () => getJson(d, `https://api.dexscreener.com/tokens/v1/${DEXS[chain]}/${part.join(',')}`));
    for (const p of Array.isArray(value) ? value : []) {
      const r = fromDexscreener(p); if (!r || !part.some(t => t.toLowerCase() === r.address.toLowerCase())) continue;
      const k = r.address.toLowerCase(), have = rows[k];
      if (!have) rows[k] = r;
      else { const pick = (r.liquidity ?? 0) > (have.liquidity ?? 0) ? r : have, other = pick === r ? have : r;
        rows[k] = { ...pick, volume24h: (pick.volume24h ?? 0) + (other.volume24h ?? 0), buys24h: (pick.buys24h ?? 0) + (other.buys24h ?? 0), sells24h: (pick.sells24h ?? 0) + (other.sells24h ?? 0), icon: pick.icon ?? other.icon }; }
    }
  }
  return { chain, rows };
}

/** The tokenized stocks of an EVM chain, for the Stocks tab: Coinbase stocks on Base and Robinhood stock tokens on Robinhood Chain, from the fixed lists the trading server also
 *  checks trades against (packages/evm/src), and bStocks on BNB Chain. Market numbers come from marketRows. Solana's list comes from the trading server (GET /v1/stocks). */
export async function marketStocks(body: any) {
  const chain = chainOf(body?.chain) as Chain;
  if (chain === 'base') { const { BASE_STOCKS } = await import('../../packages/evm/src/basestocks.ts'); return { chain, stocks: Object.entries(BASE_STOCKS).map(([symbol, address]) => ({ symbol, address, ticker: symbol.slice(0, -1), issuer: 'Coinbase' })) }; }
  if (chain === 'robinhood') { const { ROBINHOOD_STOCKS } = await import('../../packages/evm/src/robinhoodstocks.ts'); return { chain, stocks: Object.entries(ROBINHOOD_STOCKS).map(([symbol, address]) => ({ symbol, address, ticker: symbol, issuer: 'Robinhood' })) }; }
  if (chain === 'bnb') { const { BNB_STOCKS } = await import('../../packages/evm/src/bnbstocks.ts'); return { chain, stocks: Object.entries(BNB_STOCKS).map(([symbol, address]) => ({ symbol, address, ticker: symbol.slice(0, -1), issuer: 'bStocks' })) }; }
  return { chain, stocks: [] };
}

/** When each transaction landed, from the chain itself (the server's trade records carry no time): Solana getTransaction blockTime; EVM the receipt's block, then that block's
 *  timestamp. Unix seconds per hash, or null when the chain does not know it (yet). Up to 40 hashes; a found time is cached for a day (it never changes). */
export async function txTimes(body: any, d: Deps & { env?: NodeJS.ProcessEnv } = {}) {
  const chain = chainOf(body?.chain) as Chain, env = d.env ?? process.env, f = d.fetch ?? fetch;
  const ok = (h: string) => chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h) : /^0x[0-9a-fA-F]{64}$/.test(h);
  const hashes = [...new Set((Array.isArray(body?.hashes) ? body.hashes : []).map((x: unknown) => String(x).trim()).filter(ok))].slice(0, 40) as string[];
  const rpc = chainRpc(chain, env);
  const out: Record<string, number | null> = {};
  if (!rpc) { hashes.forEach(h => out[h] = null); return { chain, times: out }; }
  // through postRpc: a rate limit is retried, and on Solana handed to the fallback node (Alchemy behind Helius)
  const { postRpc } = await import('../../packages/sol/src/solchain.ts'), fb = chain === 'solana' ? solanaRpcFallback(env)?.url : undefined;
  const call = async (method: string, params: unknown[]) => { const r = await postRpc(f, rpc, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), { timeoutMs: 12_000, fallbackUrl: fb }); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); const j = JSON.parse(r.text); if (j.error) throw new Error(String(j.error.message)); return j.result; };
  // at most 4 lookups at once: 40 at once (a full history page) alone went over Helius's per-second limit on the public site (2026-11-20)
  const queue = [...hashes], one = async (h: string) => {
    try {
      const { value } = await cached(`txtime:${chain}:${h}`, 86_400_000, d, async () => {
        let t: number | null = null;
        if (chain === 'solana') { const tx = await call('getTransaction', [h, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); t = typeof tx?.blockTime === 'number' ? tx.blockTime : null; }
        else { const rc = await call('eth_getTransactionReceipt', [h]); if (rc?.blockNumber) { const b = await call('eth_getBlockByNumber', [rc.blockNumber, false]); t = b?.timestamp ? parseInt(b.timestamp, 16) : null; } }
        if (t == null) throw new Error('not known yet');   // not cached: asked again next time
        return t;
      });
      out[h] = value;
    } catch { out[h] = null; }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { for (let h = queue.shift(); h; h = queue.shift()) await one(h); }));
  return { chain, times: out };
}

const RPC_ENV: Record<Chain, string> = { solana: 'SOLANA_RPC_URL', base: 'BASE_RPC_URL', robinhood: 'ROBINHOOD_RPC_URL', bnb: 'BNB_RPC_URL' };
const ALCHEMY_NET: Record<Chain, string> = { solana: 'solana-mainnet', base: 'base-mainnet', robinhood: 'robinhood-mainnet', bnb: 'bnb-mainnet' };
/** The chain's node: <CHAIN>_RPC_URL (QuickNode on the public site) first, Alchemy (ALCHEMY_API_KEY) only when that is unset. Solana: SOLANA_RPC_URL, else Helius, else Alchemy. */
export function chainRpc(chain: Chain, env: NodeJS.ProcessEnv = process.env): string {
  if (chain === 'solana') return solanaRpc(env)?.url ?? '';
  const own = env[RPC_ENV[chain]]?.trim(), k = env.ALCHEMY_API_KEY?.trim();
  return own || (k ? `https://${ALCHEMY_NET[chain]}.g.alchemy.com/v2/${k}` : '');
}
async function stockTokens(chain: Chain): Promise<string[]> {
  if (chain === 'solana') return [];
  return ((await marketStocks({ chain })).stocks as { address: string }[]).map(s => s.address).filter(isEvm);
}
type RpcJson = (url: string, method: string, params: unknown[]) => Promise<any>;
/** QuickNode Token API (qn_getWalletTokenBalance, the endpoint's "Token and NFT API" add-on): every ERC-20 the wallet holds. Throws when the add-on is not enabled. */
async function qnWalletTokens(url: string, wallet: string, rpcJson: RpcJson) {
  const out: { token: string; raw: bigint; decimals: number | null }[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await rpcJson(url, 'qn_getWalletTokenBalance', [{ wallet, page, perPage: 100 }]);
    const list: any[] = Array.isArray(r?.result) ? r.result : Array.isArray(r?.assets) ? r.assets : [];
    for (const t of list) { const a = String(t?.address ?? t?.contractAddress ?? '').toLowerCase(), raw = t?.totalBalance ?? t?.balance ?? t?.amount; if (!isEvm(a) || raw == null) continue;
      try { const v = BigInt(String(raw)); if (v > 0n) out.push({ token: a, raw: v, decimals: num(t?.decimals) }); } catch { /* not a raw integer */ } }
    if (!r?.totalPages || page >= r.totalPages) break;
  }
  return out;
}
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';   // same address on Base, BNB Chain and Robinhood Chain (checked 2026-11-24)
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
/** ERC-20 balanceOf(owner) for many tokens in one eth_call (Multicall3 aggregate3, failures allowed). null where a token's call failed. Batches of 250. */
export async function balancesOf(tokens: string[], owner: string, call: (method: string, params: unknown[]) => Promise<any>): Promise<(bigint | null)[]> {
  const out: (bigint | null)[] = [];
  for (let i = 0; i < tokens.length; i += 250) {
    const part = tokens.slice(i, i + 250), n = part.length;
    // aggregate3((address target, bool allowFailure, bytes callData)[]): each element 6 words (target, allowFailure, offset 0x60, length 36, 2 words of data)
    let data = '0x82ad56cb' + word(32) + word(n);
    for (let j = 0; j < n; j++) data += word(n * 32 + j * 192);
    const callData = '70a08231' + owner.slice(2).toLowerCase().padStart(64, '0');
    for (const t of part) data += t.slice(2).toLowerCase().padStart(64, '0') + word(1) + word(0x60) + word(36) + callData.padEnd(128, '0');
    const hex: string = String(await call('eth_call', [{ to: MULTICALL3, data }, 'latest'])).slice(2);
    const at = (byte: number) => BigInt('0x' + (hex.slice(byte * 2, byte * 2 + 64) || '0'));
    const arr = Number(at(0)), len = Number(at(arr)), base = arr + 32;
    for (let j = 0; j < n; j++) {
      if (j >= len) { out.push(null); continue; }
      const el = base + Number(at(base + j * 32)), ok = at(el) === 1n, bl = Number(at(el + Number(at(el + 32))));
      out.push(ok && bl >= 32 ? at(el + Number(at(el + 32)) + 32) : null);
    }
  }
  return out;
}

/** What a wallet actually holds on one chain, read from the chain: every token with a balance, with symbol, decimals, price and value. Independent of which server or
 *  app bought it (a server's positions only know its own trades). Solana: token accounts of the Token and Token-2022 programs (the repo's Solana RPC, rate limits
 *  retried). EVM, on the chain's node (<CHAIN>_RPC_URL): QuickNode's Token API when the endpoint has it (alchemy_getTokenBalances on an Alchemy URL), plus balanceOf for
 *  the chain's stock tokens and the tokens the app sends in `tokens` (one Multicall3 call), so plain RPC works too. Cached 15 s per wallet. */
export async function marketHoldings(body: any, d: Deps & { env?: NodeJS.ProcessEnv } = {}) {
  const chain = chainOf(body?.chain) as Chain, address = String(body?.address ?? '').trim(), env = d.env ?? process.env, f = d.fetch ?? fetch;
  if (!(chain === 'solana' ? isSol(address) : isEvm(address))) throw new MarketError(chain === 'solana' ? 'That is not a Solana wallet address.' : 'That is not a 0x wallet address.');
  const { value: raw, stale } = await cached(`holdings:${chain}:${address.toLowerCase()}:${(Array.isArray(body?.tokens) ? body.tokens : []).map(String).sort().join(',').toLowerCase()}`, 15_000, d, async () => {
    const { postRpc } = await import('../../packages/sol/src/solchain.ts');
    const rpcJson = async (url: string, method: string, params: unknown[]) => { const r = await postRpc(f, url, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), { timeoutMs: 15_000, fallbackUrl: chain === 'solana' ? solanaRpcFallback(env)?.url : undefined }); if (r.status !== 200) throw new MarketError(`The ${chain} node answered HTTP ${r.status}.`, 502); const j = JSON.parse(r.text); if (j.error) throw new MarketError(String(j.error.message ?? 'RPC error'), 502); return j.result; };
    const out = new Map<string, { raw: bigint; decimals: number | null }>();
    if (chain === 'solana') {
      const url = solanaRpc(env)?.url; if (!url) throw new MarketError('No Solana RPC on this server (SOLANA_RPC_URL or HELIUS_API_KEY).', 503);
      for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
        const res = await rpcJson(url, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }]);
        for (const a of res?.value ?? []) { const i = a?.account?.data?.parsed?.info, amt = BigInt(i?.tokenAmount?.amount ?? '0'); if (!i?.mint || amt <= 0n) continue; const h = out.get(i.mint); out.set(i.mint, { raw: (h?.raw ?? 0n) + amt, decimals: Number(i.tokenAmount.decimals) }); }
      }
    } else {
      const url = chainRpc(chain, env); if (!url) throw new MarketError(`No ${chain} node on this server (${RPC_ENV[chain]}).`, 503);
      let listed = false;
      if (url.includes('alchemy.com')) {
        const res = await rpcJson(url, 'alchemy_getTokenBalances', [address, 'erc20']); listed = true;
        for (const t of res?.tokenBalances ?? []) { const amt = t?.tokenBalance ? BigInt(t.tokenBalance) : 0n; if (amt > 0n && isEvm(t.contractAddress)) out.set(String(t.contractAddress).toLowerCase(), { raw: amt, decimals: null }); }
      } else {
        // QuickNode's Token API (an add-on of the endpoint) lists every token; without it, the plain-RPC read below
        try { for (const t of await qnWalletTokens(url, address, rpcJson)) out.set(t.token, { raw: t.raw, decimals: t.decimals }); listed = true; } catch { /* add-on not enabled */ }
      }
      // Plain RPC (any node): balanceOf, in one Multicall3 call, for the tokens this wallet could hold: the chain's stock tokens and the tokens the app asks about
      // (the server's positions, past trades). Also run next to a listing, so a token the listing missed still shows.
      const ask = new Set<string>([...(Array.isArray(body?.tokens) ? body.tokens : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(isEvm).slice(0, 60), ...(await stockTokens(chain)).map(a => a.toLowerCase())]);
      for (const t of out.keys()) ask.delete(t);
      if (ask.size || !listed) {
        const toks = [...ask], bals = await balancesOf(toks, address, (m, p) => rpcJson(url, m, p));
        toks.forEach((t, i) => { if (bals[i] != null && bals[i]! > 0n) out.set(t, { raw: bals[i]!, decimals: null }); });
      }
    }
    return [...out].slice(0, 90).map(([token, v]) => ({ token, raw: v.raw.toString(), decimals: v.decimals }));
  });
  const meta = raw.length ? (await marketMeta({ chain, tokens: raw.map(x => x.token) }, d).catch(() => ({ tokens: {} as Record<string, any> }))).tokens : {};
  const rows = raw.map(x => { const m = meta[chain === 'solana' ? x.token : x.token.toLowerCase()] ?? {}, dec = x.decimals ?? m.decimals ?? null, amount = dec == null ? null : Number(BigInt(x.raw)) / 10 ** dec;
    return { chain, token: x.token, raw: x.raw, decimals: dec, amount, symbol: m.symbol ?? null, name: m.name ?? null, icon: m.icon ?? null, price: m.price ?? null, value: amount != null && m.price != null ? amount * m.price : null }; });
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return { chain, address, holdings: rows, stale };
}

export type Activity = { txHash: string; when: number | null; side: 'buy' | 'sell' | 'swap' | 'receive' | 'send'; token: string; tokenRaw: string; native: string | null; fromToken?: string; fromRaw?: string; failed: boolean };
const WSOL = 'So11111111111111111111111111111111111111112';
/** One Solana transaction, seen from one wallet: its SOL change (the fee given back when it paid it; wrapped SOL counted as SOL) and each token's change. */
export function solActivity(tx: any, sig: string, wallet: string): Activity | null {
  const m = tx?.meta; if (!m) return null;
  const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => typeof k === 'string' ? k : k?.pubkey);
  const i = keys.indexOf(wallet); let sol = i >= 0 ? BigInt(m.postBalances?.[i] ?? 0) - BigInt(m.preBalances?.[i] ?? 0) : 0n;
  if (i === 0) sol += BigInt(m.fee ?? 0);
  const d = new Map<string, bigint>(), add = (b: any, s: bigint) => { if (b?.owner !== wallet || !b?.mint) return; d.set(b.mint, (d.get(b.mint) ?? 0n) + s * BigInt(b?.uiTokenAmount?.amount ?? '0')); };
  for (const b of m.postTokenBalances ?? []) add(b, 1n); for (const b of m.preTokenBalances ?? []) add(b, -1n);
  if (d.has(WSOL)) { sol += d.get(WSOL)!; d.delete(WSOL); }
  const up = [...d].filter(([, v]) => v > 0n), down = [...d].filter(([, v]) => v < 0n), when = typeof tx.blockTime === 'number' ? tx.blockTime * 1000 : null, failed = m.err != null;
  const base = { txHash: sig, when, failed };
  if (up.length === 1 && !down.length && sol < 0n) return { ...base, side: 'buy', token: up[0][0], tokenRaw: up[0][1].toString(), native: (-sol).toString() };
  if (down.length === 1 && !up.length && sol > 0n) return { ...base, side: 'sell', token: down[0][0], tokenRaw: (-down[0][1]).toString(), native: sol.toString() };
  if (up.length === 1 && down.length === 1) return { ...base, side: 'swap', token: up[0][0], tokenRaw: up[0][1].toString(), native: null, fromToken: down[0][0], fromRaw: (-down[0][1]).toString() };
  if (up.length === 1 && !down.length) return { ...base, side: 'receive', token: up[0][0], tokenRaw: up[0][1].toString(), native: null };
  if (down.length === 1 && !up.length) return { ...base, side: 'send', token: down[0][0], tokenRaw: (-down[0][1]).toString(), native: null };
  return null;   // SOL-only transfers, or several tokens at once: not a trade
}

/** A wallet's trades read from the chain, so trades made anywhere (another server, another app, the wallet itself) show in History. Newest first, up to 40.
 *  Solana: the wallet's signatures (getSignaturesForAddress), each transaction's balance changes. EVM: QuickNode's Token API (qn_getWalletTokenTransactions, the
 *  endpoint's "Token and NFT API" add-on), per token the wallet holds or the app names in `tokens`; without the add-on, `unsupported` says so and the list is empty
 *  (scanning transfer logs is not an option: a node answers 10,000 blocks per call, under an hour on these chains). Transactions are cached a day (they never change). */
export async function marketActivity(body: any, d: Deps & { env?: NodeJS.ProcessEnv } = {}) {
  const chain = chainOf(body?.chain) as Chain, address = String(body?.address ?? '').trim(), env = d.env ?? process.env, f = d.fetch ?? fetch;
  if (!(chain === 'solana' ? isSol(address) : isEvm(address))) throw new MarketError(chain === 'solana' ? 'That is not a Solana wallet address.' : 'That is not a 0x wallet address.');
  const url = chainRpc(chain, env); if (!url) throw new MarketError(`No ${chain} node on this server (${RPC_ENV[chain]}).`, 503);
  const { postRpc } = await import('../../packages/sol/src/solchain.ts'), fb = chain === 'solana' ? solanaRpcFallback(env)?.url : undefined;
  const call = async (method: string, params: unknown[]) => { const r = await postRpc(f, url, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), { timeoutMs: 15_000, fallbackUrl: fb }); if (r.status !== 200) throw new MarketError(`The ${chain} node answered HTTP ${r.status}.`, 502); const j = JSON.parse(r.text); if (j.error) throw new MarketError(String(j.error.message ?? 'RPC error'), 502); return j.result; };
  const pool = async <T,>(items: T[], n: number, fn: (x: T) => Promise<void>) => { const q = [...items]; await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); })); };
  const { value, stale } = await cached(`activity:${chain}:${address.toLowerCase()}`, 20_000, d, async () => {
    const out: Activity[] = [];
    if (chain === 'solana') {
      const sigs: any[] = (await call('getSignaturesForAddress', [address, { limit: 40 }])) ?? [];
      await pool(sigs.map(s => String(s.signature)), 4, async sig => {
        try { const { value: tx } = await cached(`soltx:${sig}`, 86_400_000, d, () => call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]));
          const a = solActivity(tx, sig, address); if (a) out.push(a); } catch { /* skipped: asked again next time */ }
      });
      return { trades: out, unsupported: null as string | null };
    }
    // EVM: per token, the wallet's transfers (QuickNode Token API), grouped by transaction; WETH/WBNB counted as the native coin
    const tokens = new Set<string>((Array.isArray(body?.tokens) ? body.tokens : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(isEvm).slice(0, 30));
    try { for (const t of await qnWalletTokens(url, address, (_u, m, p) => call(m, p))) tokens.add(t.token); }
    catch (e) { return { trades: out, unsupported: `Trades made outside this app on ${chain} need the "Token and NFT API" add-on on the ${RPC_ENV[chain]} QuickNode endpoint (${String((e as Error).message).slice(0, 80)}).` }; }
    const me = address.toLowerCase(), wrapped = WRAPPED[chain].toLowerCase(), byTx = new Map<string, { when: number | null; d: Map<string, bigint> }>();
    await pool([...tokens, wrapped].filter(t => t !== '0x0000000000000000000000000000000000000000'), 3, async token => {
      try {
        const r = await call('qn_getWalletTokenTransactions', [{ address, contract: token, page: 1, perPage: 40 }]);
        for (const x of (r?.transfers ?? r?.result ?? []) as any[]) {
          const h = String(x?.transactionHash ?? x?.txHash ?? ''), from = String(x?.from ?? '').toLowerCase(), to = String(x?.to ?? '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/i.test(h)) continue;
          let v: bigint; try { v = BigInt(String(x?.sentAmount ?? x?.receivedAmount ?? x?.amount ?? x?.value ?? '0')); } catch { continue; }
          const e = byTx.get(h) ?? { when: x?.timestamp ? Date.parse(x.timestamp) || Number(x.timestamp) * 1000 || null : null, d: new Map() };
          const s = to === me ? v : from === me ? -v : 0n; if (s) e.d.set(token, (e.d.get(token) ?? 0n) + s); byTx.set(h, e);
        }
      } catch { /* that token skipped */ }
    });
    const txs = [...byTx].sort((a, b) => (b[1].when ?? 0) - (a[1].when ?? 0)).slice(0, 40);
    await pool(txs, 4, async ([h, e]) => {
      let native = e.d.get(wrapped) ?? 0n, mine = false; e.d.delete(wrapped);
      try { const { value: tx } = await cached(`evmtx:${chain}:${h}`, 86_400_000, d, () => call('eth_getTransactionByHash', [h]));
        mine = String(tx?.from).toLowerCase() === me; if (mine && tx?.value) native -= BigInt(tx.value); } catch { /* value unknown */ }
      const up = [...e.d].filter(([, v]) => v > 0n), down = [...e.d].filter(([, v]) => v < 0n), base = { txHash: h, when: e.when, failed: false };
      if (up.length === 1 && !down.length) out.push(native < 0n ? { ...base, side: 'buy', token: up[0][0], tokenRaw: up[0][1].toString(), native: (-native).toString() } : { ...base, side: 'receive', token: up[0][0], tokenRaw: up[0][1].toString(), native: null });
      else if (down.length === 1 && !up.length) out.push(native > 0n || mine ? { ...base, side: 'sell', token: down[0][0], tokenRaw: (-down[0][1]).toString(), native: native > 0n ? native.toString() : null } :   // a sell's coin often comes back unwrapped by the router (an internal transfer, not seen here): amount unknown
         { ...base, side: 'send', token: down[0][0], tokenRaw: (-down[0][1]).toString(), native: null });
      else if (up.length === 1 && down.length === 1) out.push({ ...base, side: 'swap', token: up[0][0], tokenRaw: up[0][1].toString(), native: null, fromToken: down[0][0], fromRaw: (-down[0][1]).toString() });
    });
    return { trades: out, unsupported: null as string | null };
  });
  const trades = [...value.trades].sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
  return { chain, address, trades, unsupported: value.unsupported, stale };
}

/** Search by name, symbol or address across the four chains (DexScreener), one row per token, most liquid first. */
export async function marketSearch(body: any, d: Deps = {}) {
  const q = String(body?.q ?? '').trim(); if (q.length < 2) return { rows: [] };
  if (q.length > 64) throw new MarketError('Search for a name, symbol or address.');
  const { value } = await cached(`search:${q.toLowerCase()}`, 30_000, d, () => getJson(d, `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`));
  const seen = new Map<string, MarketRow>();
  for (const p of value?.pairs ?? []) { const r = fromDexscreener(p); if (!r || !r.address) continue; const k = r.chain + ':' + r.address.toLowerCase(), h = seen.get(k); if (!h || (r.liquidity ?? 0) > (h.liquidity ?? 0)) seen.set(k, r); }
  return { rows: [...seen.values()].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)).slice(0, 20) };
}
