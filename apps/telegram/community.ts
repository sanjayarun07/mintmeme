/** Wiring for the community bots: connects the Buy Bot and Wallet Bot to read-only data and to a message sink. Nothing here signs, sends funds or trades.
 *  - `communityStep` runs one cycle: poll the trade feed for the tokens some group watches, hand fresh trades to the Buy Bot, then check every Wallet Bot price alert.
 *  - `realLookups` are the read-only lookups the Wallet Bot needs: native balance by public JSON-RPC (`eth_getBalance`, on the project's read-only allowlist) and prices from DexScreener (third party).
 *  Every lookup is injected, so tests use fakes. A failing source is counted and skipped; one bad token or chain never stops the cycle. */
import type { FeedTrade, FeedToken } from '../../packages/live/src/tradefeed.ts';
import type { BuyBot } from './buybot.ts';
import type { WalletBot, WalletChain, WalletBotDeps } from './walletbot.ts';

export interface CommunityDeps {
  buyBot: BuyBot; walletBot: WalletBot;
  /** Real tokens the feed can poll (contract, pool, chain). Tokens no group watches are never polled. */
  tokens(): FeedToken[] | Promise<FeedToken[]>;
  /** One feed cycle for these tokens, returning only FRESH trades (the first poll of a pool is a silent baseline). */
  pollCycle(tokens: FeedToken[]): Promise<{ fresh: FeedTrade[]; polled: number; errors: number }>;
  now?: () => number;
}
export interface CommunityResult { watched: number; polled: number; feedErrors: number; posted: number; alerts: number; unknownWatched: string[] }

export async function communityStep(d: CommunityDeps): Promise<CommunityResult> {
  const watched = d.buyBot.watched(), all = await d.tokens(), known = new Set(all.map(t => t.contract.toLowerCase()));
  const pick = all.filter(t => watched.has(t.contract.toLowerCase()));
  const unknownWatched = [...watched].filter(w => !known.has(w));          // a group asked for a token that is not in the real list: it can never be announced, so say so
  let polled = 0, feedErrors = 0, posted = 0;
  if (pick.length) { const r = await d.pollCycle(pick); polled = r.polled; feedErrors = r.errors; for (const t of r.fresh) posted += await d.buyBot.handleTrade(t, (d.now ?? Date.now)()); }
  const alerts = await d.walletBot.check();
  return { watched: watched.size, polled, feedErrors, posted, alerts, unknownWatched };
}

/** Repeat `communityStep` until the returned stop function is called. A thrown cycle is reported through `onError` and the loop carries on. */
export function startCommunity(d: CommunityDeps, o: { everyMs?: number; onResult?: (r: CommunityResult) => void; onError?: (e: Error) => void } = {}): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => { if (stopped) return; try { o.onResult?.(await communityStep(d)); } catch (e) { o.onError?.(e as Error); } if (!stopped) timer = setTimeout(loop, o.everyMs ?? 60_000); };
  void loop(); return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/* ---------- real read-only lookups ---------- */
interface EvmRpc { call<T = unknown>(method: string, params?: unknown[]): Promise<T> }
export interface LookupDeps {
  /** JSON-RPC clients by chain. A chain with no client answers "unavailable" instead of guessing an endpoint. */
  rpc: Partial<Record<WalletChain, EvmRpc>>;
  /** Wrapped-native token contract per price source (read from the official router `WETH()` on-chain, never typed in by hand). */
  wrappedNative: { ethereum?: string; bsc?: string };
  fetchFn?: typeof fetch;
}
const DS_CHAIN: Record<WalletChain, string> = { bsc: 'bsc', ethereum: 'ethereum', arbitrum: 'arbitrum' };
/** Dexscreener returns every pool for a token; take the pool on the right chain with the most liquidity. Returns null when there is none or the price is not a sensible number. */
export function pickPrice(json: any, chain: WalletChain): number | null {
  const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs.filter((p: any) => p?.chainId === DS_CHAIN[chain]) : [];
  pairs.sort((a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0));
  const p = Number(pairs[0]?.priceUsd); return Number.isFinite(p) && p > 0 ? p : null;
}
export function realLookups(d: LookupDeps): Pick<WalletBotDeps, 'balanceOf' | 'priceOf'> {
  const f = d.fetchFn ?? fetch;
  return {
    async balanceOf(chain, address) {
      const c = d.rpc[chain]; if (!c) return null;                                     // e.g. Arbitrum with no node configured: say "unavailable", do not guess a URL
      const hex = await c.call<string>('eth_getBalance', [address, 'latest']); if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
      return Number(BigInt(hex)) / 1e18;
    },
    async priceOf(chain, token) {
      // ETH has one price on Ethereum and Arbitrum, so both use the Ethereum wrapped-native pool; BNB uses the BSC one.
      const addr = token === 'native' ? (chain === 'bsc' ? d.wrappedNative.bsc : d.wrappedNative.ethereum) : token; if (!addr) return null;
      const priceChain: WalletChain = token === 'native' ? (chain === 'bsc' ? 'bsc' : 'ethereum') : chain;
      const res = await f(`https://api.dexscreener.com/latest/dex/tokens/${addr}`); if (!res.ok) return null;
      return pickPrice(await res.json(), priceChain);
    },
  };
}
