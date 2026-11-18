/** TOKENIZED-STOCK HELPERS for Solana: the live state of a stock mint (corporate-action multiplier, issuer pause), per-share amounts and prices, and a check of the price a route
 *  would fill at against the underlying stock price.
 *
 *  Per share vs per token: Solana stock mints (xStocks, Ondo, Backpack) carry Token-2022 `scaledUiAmountConfig`. Raw balances never change on a dividend or split; instead
 *  one token = `multiplier` shares (AAPLx 1.0033 after dividends). The engine trades raw token units, which is correct; a person thinks in shares and per-share prices:
 *    shares = tokens x multiplier,  price per share = price per token / multiplier.
 *  A scheduled change (`newMultiplier` from `newMultiplierEffectiveTimestamp`) applies from that time; issuers set it for 00:30 UTC the day after the ex-date.
 *
 *  Reference price: Jupiter's Price API V3 (`GET https://lite-api.jup.ag/price/v3?ids=...`, keyless) returns, for stock tokens, `stockData.price`: the underlying share price
 *  (seen 2026-11-18 for xStocks, Ondo and Backpack mints). A route that would fill far from it (Ondo on Solana filled at about 3x the share price on that day while Jupiter's
 *  impact figure said 0) is refused by `checkFillPrice`. */
import type { SolRpcLike } from './tokensafety.ts';
import { stockByMint, stockBySymbol } from './xstocks.ts';
import type { IssuedAsset } from './tokensafety.ts';

export interface StockState { mint: string; decimals: number; /** Effective now, as a decimal string ("1" when the mint has no multiplier). */ multiplier: string; paused: boolean;
  /** A scheduled multiplier not yet in force, and when (unix seconds). */ next?: { multiplier: string; at: number } }

/** Reads the mints (one getMultipleAccounts, jsonParsed). A mint that does not exist or is not a token mint is left out. `nowSec` decides which multiplier is in force. */
export async function readStockStates(rpc: SolRpcLike, mints: string[], nowSec = Math.floor(Date.now() / 1000)): Promise<Map<string, StockState>> {
  const out = new Map<string, StockState>(); if (!mints.length) return out;
  const r: any = await rpc.call('getMultipleAccounts', [mints, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  (r?.value ?? []).forEach((v: any, i: number) => { const s = stockStateOf(mints[i], v, nowSec); if (s) out.set(mints[i], s); });
  return out;
}
/** The state of one mint from its jsonParsed account (as getAccountInfo / getMultipleAccounts return it), or undefined if it is not a token mint. */
export function stockStateOf(mint: string, acct: any, nowSec = Math.floor(Date.now() / 1000)): StockState | undefined {
  const info = acct?.data?.parsed?.type === 'mint' ? acct.data.parsed.info : undefined; if (!info) return undefined;
  const ext = (n: string) => (info.extensions ?? []).find((e: any) => e.extension === n)?.state;
  const sc = ext('scaledUiAmountConfig'), pause = ext('pausableConfig') ?? ext('pausable');
  let multiplier = sc ? decimalString(String(sc.multiplier)) : '1', next: StockState['next'];
  if (sc && sc.newMultiplier !== undefined && Number(sc.newMultiplierEffectiveTimestamp ?? 0) > 0) {
    const at = Number(sc.newMultiplierEffectiveTimestamp), nm = decimalString(String(sc.newMultiplier));
    if (at <= nowSec) multiplier = nm; else if (nm !== multiplier) next = { multiplier: nm, at };
  }
  return { mint, decimals: Number(info.decimals), multiplier, paused: pause?.paused === true, ...(next ? { next } : {}) };
}

/* ---------------- exact decimal arithmetic (no floats for amounts) ---------------- */
const DEC = /^\d+(\.\d+)?$/;
function decimalString(s: string): string { const t = s.trim(); if (!DEC.test(t)) throw new Error(`not a decimal multiplier: ${s}`); if (/^0+(\.0+)?$/.test(t)) throw new Error('multiplier must be above zero'); return t; }
const frac = (s: string) => { const [i, f = ''] = s.split('.'); return { n: BigInt(i + f), d: 10n ** BigInt(f.length) }; };
/** Raw token units for `shares` (a decimal string) of a stock: tokens = shares / multiplier, rounded DOWN (never sells or asks for more than the person said). */
export function rawForShares(shares: string, multiplier: string, decimals: number): bigint {
  if (!DEC.test(shares.trim())) throw new Error('shares must be a decimal number'); const s = frac(shares.trim()), m = frac(multiplier);
  return s.n * m.d * 10n ** BigInt(decimals) / (s.d * m.n);
}
/** Shares for raw token units, as a decimal string with `places` decimals (rounded down). */
export function sharesForRaw(raw: bigint, multiplier: string, decimals: number, places = 6): string {
  const m = frac(multiplier), q = raw * m.n * 10n ** BigInt(places) / (m.d * 10n ** BigInt(decimals)), s = q.toString().padStart(places + 1, '0');
  return places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
}
/** A per-share USD price as the per-token price the engine uses: per token = per share x multiplier. Returns a decimal string. */
export function perTokenPrice(perShareUsd: string, multiplier: string): string {
  if (!DEC.test(perShareUsd.trim())) throw new Error('price must be a decimal number'); const p = frac(perShareUsd.trim()), m = frac(multiplier), places = 12n;
  const q = p.n * m.n * 10n ** places / (p.d * m.d), s = q.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`.replace(/\.?0+$/, '') || '0';
}

/* ---------------- reference price ---------------- */
export interface StockPrice { usdPrice?: number; /** The underlying share price, when Jupiter knows the token is a stock. */ stockPrice?: number }
/** Jupiter Price API V3, cached per mint (default 30 s). Failures return an empty map: callers treat "no reference" explicitly. */
export class JupiterStockPrices {
  private cache = new Map<string, { at: number; p: StockPrice }>();
  constructor(private o: { url?: string; fetchFn?: typeof fetch; ttlMs?: number; timeoutMs?: number; now?: () => number; /** Jupiter API key: x-api-key on the keyed host (api.jup.ag) unless `url` is given. */ apiKey?: string } = {}) {}
  async get(mints: string[]): Promise<Map<string, StockPrice>> {
    const now = (this.o.now ?? Date.now)(), ttl = this.o.ttlMs ?? 30_000, out = new Map<string, StockPrice>(), need: string[] = [];
    for (const m of mints) { const c = this.cache.get(m); if (c && now - c.at < ttl) out.set(m, c.p); else need.push(m); }
    if (need.length) try {
      const res = await (this.o.fetchFn ?? fetch)(`${this.o.url ?? (this.o.apiKey ? 'https://api.jup.ag/price/v3' : 'https://lite-api.jup.ag/price/v3')}?ids=${need.join(',')}`, { headers: this.o.apiKey ? { 'x-api-key': this.o.apiKey } : {}, signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000) });
      if (res.ok) { const j: any = await res.json();
        for (const m of need) { const r = j?.[m]; if (!r) continue; const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
          const p: StockPrice = { usdPrice: n(r.usdPrice), stockPrice: n(r.stockData?.price) }; this.cache.set(m, { at: now, p }); out.set(m, p); } }
    } catch { /* no reference this time */ }
    return out;
  }
}
export interface FillCheck { ok: boolean; perShareUsd: number; referenceUsd: number | null; deviationPct: number | null; why?: string }
/** The per-share USD price a route gives, against the underlying share price. Buying: paying more than `maxDeviationPct` above it is refused; selling: receiving more than that
 *  below it. Without a reference (`referenceUsd` null) the result is ok with `why` saying so: the caller decides whether that is acceptable. */
export function checkFillPrice(o: { side: 'buy' | 'sell'; solLamports: bigint; tokensRaw: bigint; decimals: number; multiplier: string; solUsd: number; referenceUsd: number | null | undefined; maxDeviationPct?: number }): FillCheck {
  const tokens = Number(o.tokensRaw) / 10 ** o.decimals, shares = tokens * Number(o.multiplier), usd = Number(o.solLamports) / 1e9 * o.solUsd;
  const perShareUsd = shares > 0 ? usd / shares : Infinity, ref = o.referenceUsd ?? null, max = o.maxDeviationPct ?? 3;
  if (!ref) return { ok: true, perShareUsd, referenceUsd: null, deviationPct: null, why: 'no reference share price is available' };
  const dev = (perShareUsd - ref) / ref * 100, worse = o.side === 'buy' ? dev : -dev;
  const r = (x: number) => Math.round(x * 100) / 100;
  return worse > max ? { ok: false, perShareUsd, referenceUsd: ref, deviationPct: r(dev), why: `this route ${o.side === 'buy' ? 'pays' : 'receives'} $${r(perShareUsd)} per share against a share price of $${r(ref)} (${r(worse)}% worse, the limit is ${max}%)` }
    : { ok: true, perShareUsd, referenceUsd: ref, deviationPct: r(dev) };
}

/** The registered stock for a mint, or a symbol (TSLAx, TSLAon, TSLA), or undefined. */
export function findStock(mintOrSymbol: string, list?: readonly IssuedAsset[]): IssuedAsset | undefined {
  if (!list) return stockByMint(mintOrSymbol) ?? stockBySymbol(mintOrSymbol);
  return list.find(a => a.mint === mintOrSymbol) ?? list.find(a => a.symbol.toLowerCase() === mintOrSymbol.toLowerCase());
}
/** The underlying ticker of a registered stock: TSLAx, TSLAon and TSLA are all TSLA. */
export const underlying = (a: IssuedAsset) => (a as { underlying?: string }).underlying ?? (a.issuer.startsWith('Backed') ? a.symbol.replace(/x$/, '') : a.issuer.startsWith('Ondo') ? a.symbol.replace(/on$/, '') : a.symbol);
