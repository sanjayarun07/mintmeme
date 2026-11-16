/** Recent trades of a REAL wallet, read-only (the data behind Copy trade in "track only" mode). Returns core `LeaderEvent`s, so the CopyEngine can consume them directly.
 *  Solana: the wallet's own recent transactions, parsed from its balance changes (SolLeaderWatcher.history): sees a swap on any DEX.
 *  EVM: alchemy_getAssetTransfers (external, internal, erc20) grouped by transaction hash; a swap is exactly one non-quote token moving one way and a quote asset
 *  (native coin, wrapped native, USDC where configured) moving the other way. Honest limits: swaps are INFERRED from transfers (aggregator or multi-hop routes can show as a plain transfer),
 *  tokens priced against any other asset (for example USDT, which is not configured here) show as transfers, and nothing about the wallet is verified beyond what the node returns.
 *  Nothing is signed or sent; every method used is on the read-only allowlist (packages/live/src/rpc.ts). */
import type { LeaderEvent } from '../../core/src/index.ts';
import { SolLeaderWatcher } from '../../sol/src/leaderwatch.ts';
import { b58decode } from '../../sol/src/tx.ts';
import { erc20 } from '../../evm/src/calldata.ts';
import { ETH, BSC, SOL_POOL } from './config.ts';

export type TradeChain = 'ethereum' | 'bnb' | 'solana';
export interface RpcCall { call<T = any>(method: string, params?: unknown[]): Promise<T> }
export interface TradesDeps { rpcFor(chain: TradeChain): RpcCall; fetchFn?: typeof fetch; now?: () => number }
export interface TokenMeta { sym?: string; name?: string; decimals?: number }
export interface TradeExtra { ts?: number; quoteSym: string; quoteToken: string }
export interface WalletTrades {
  chain: TradeChain; address: string; events: LeaderEvent[]; tokens: Record<string, TokenMeta>; notes: string[]; at: number;
  /** per transaction hash: block time (unix seconds, when known) and which asset was the money side */
  extras: Record<string, TradeExtra>;
}
export const MAX_TRADES = 50, DEFAULT_TRADES = 20;
const E18 = 10n ** 18n, NATIVE = 'NATIVE', lc = (s: string) => s.toLowerCase(), abs = (x: bigint) => (x < 0n ? -x : x);
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_INFO = {
  ethereum: { nativeSym: 'ETH', router: ETH.uniswapV2Router02.address, stables: [{ sym: 'USDC', address: lc(ETH.usdc.address) }], dsChain: 'ethereum' },
  bnb: { nativeSym: 'BNB', router: BSC.pancakeV2Router.address, stables: [] as { sym: string; address: string }[], dsChain: 'bsc' },
};
const wrapped = new WeakMap<object, Promise<string | undefined>>();
async function wrappedNative(rpc: RpcCall, router: string) {   // router.WETH(), read on-chain (never recalled)
  let p = wrapped.get(rpc); if (!p) { p = rpc.call<string>('eth_call', [{ to: router, data: '0xad5c4648' }, 'latest']).then(r => (/^0x[0-9a-f]{64}$/i.test(r) ? lc('0x' + r.slice(26)) : undefined), () => undefined); wrapped.set(rpc, p); }
  return p;
}
export const validAddress = (chain: TradeChain, a: string) => { if (chain !== 'solana') return EVM_RE.test(a); try { return b58decode(a).length === 32; } catch { return false; } };

export async function loadWalletTrades(deps: TradesDeps, req: { chain: TradeChain; address: string; limit?: number }): Promise<WalletTrades> {
  const { chain } = req, limit = Math.max(1, Math.min(MAX_TRADES, Math.floor(req.limit ?? DEFAULT_TRADES)));
  if (!validAddress(chain, req.address)) throw new Error(`not a valid ${chain} address`);
  const at = (deps.now ?? Date.now)();
  return chain === 'solana' ? solana(deps, req.address, limit, at) : evm(deps, chain, req.address.toLowerCase(), limit, at);
}

async function solana(deps: TradesDeps, address: string, limit: number, at: number): Promise<WalletTrades> {
  const rpc = deps.rpcFor('solana'), notes: string[] = [];
  const w = new SolLeaderWatcher({ chain: 'solana', wsol: SOL_POOL.wsol.mint, leaders: [address], quoteMints: [SOL_POOL.usdc.mint], minConfirmations: 0 }, rpc);
  const events = await w.history(address, limit), extras: WalletTrades['extras'] = {}, tokens: WalletTrades['tokens'] = {};
  for (const e of events) { const q = w.quotes.get(e.txHash); extras[e.txHash] = { quoteSym: q === undefined ? '' : q === NATIVE ? 'SOL' : q === SOL_POOL.usdc.mint ? 'USDC' : 'token', quoteToken: q ?? '' }; tokens[e.token] = tokens[e.token] ?? {}; }
  const h = w.lastHistory;
  notes.push(`looked at the latest ${h.signatures} transactions of this wallet: ${h.failed} failed on chain (skipped), ${h.read} succeeded, ${h.listed} moved a token and are listed`);
  if (h.signatures > 0 && h.listed === 0) notes.push(h.failed === h.signatures ? 'Every recent transaction of this wallet failed on chain, which is typical of a trading bot. There is nothing to copy right now.' : 'None of its recent successful transactions moved a token (for example plain SOL transfers).');
  notes.push('swaps are read from the wallet\'s own balance changes, so they are visible on any DEX; the quote side is SOL or USDC');
  if (w.skipped.length) notes.push(`${w.skipped.length} transaction(s) could not be read and were skipped`);
  const slots = [...new Set(events.map(e => w.slots.get(e.txHash)).filter((x): x is number => x !== undefined))], times = new Map<number, number>();
  for (const s of slots) { try { const t = await rpc.call<number | null>('getBlockTime', [s]); if (t) times.set(s, t); } catch { /* time is optional */ } }
  for (const e of events) { const t = times.get(w.slots.get(e.txHash) ?? -1); if (t) extras[e.txHash].ts = t; }
  await dexMeta(deps, 'solana', Object.keys(tokens), tokens, notes);
  return { chain: 'solana', address, events, tokens, notes, at, extras };
}

async function dexMeta(deps: TradesDeps, dsChain: string, contracts: string[], into: Record<string, TokenMeta>, notes: string[]) {
  if (!deps.fetchFn || !contracts.length) return;
  try {
    const r = await deps.fetchFn(`https://api.dexscreener.com/tokens/v1/${dsChain}/${contracts.slice(0, 30).join(',')}`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json(); for (const p of Array.isArray(j) ? j : []) { const a = p?.baseToken?.address; const key = contracts.find(c => lc(c) === lc(a ?? '')); if (key && !into[key].sym) into[key] = { ...into[key], sym: p.baseToken.symbol, name: p.baseToken.name }; }
  } catch (e) { notes.push(`token names unavailable (${(e as Error).message}); contracts are shown instead`); }
}

type Transfer = { blockNum: string; hash: string; from: string; to: string | null; asset: string | null; category: string; rawContract: { value: string | null; address: string | null; decimal: string | null }; metadata?: { blockTimestamp?: string }; uniqueId?: string };
async function transfers(rpc: RpcCall, who: string, dir: 'fromAddress' | 'toAddress', cats: string[]) {
  const r: any = await rpc.call('alchemy_getAssetTransfers', [{ fromBlock: '0x0', toBlock: 'latest', [dir]: who, category: cats, withMetadata: true, excludeZeroValue: true, maxCount: '0x64', order: 'desc' }]);
  return (r?.transfers ?? []) as Transfer[];
}

async function evm(deps: TradesDeps, chain: 'ethereum' | 'bnb', who: string, limit: number, at: number): Promise<WalletTrades> {
  const rpc = deps.rpcFor(chain), info = CHAIN_INFO[chain], notes: string[] = [], tokens: WalletTrades['tokens'] = {}, extras: WalletTrades['extras'] = {};
  const empty = (why: string): WalletTrades => ({ chain, address: who, events: [], tokens, notes: [...notes, why], at, extras });
  let cats = ['external', 'internal', 'erc20'], out: Transfer[][];
  const fetchBoth = () => Promise.all([transfers(rpc, who, 'fromAddress', cats), transfers(rpc, who, 'toAddress', cats)]);
  try { out = await fetchBoth(); }
  catch (e) {
    if (/categor|internal/i.test((e as Error).message)) { cats = ['external', 'erc20']; notes.push('this node does not list internal transfers: a sale paid out in the native coin by a router may show as a plain transfer');
      try { out = await fetchBoth(); } catch (e2) { return empty(`trade history is not available from this node (${(e2 as Error).message})`); } }
    else return empty(`trade history is not available from this node (${(e as Error).message}); it needs a provider that supports alchemy_getAssetTransfers`);
  }
  const [wrappedAddr] = await Promise.all([wrappedNative(rpc, info.router)]); if (!wrappedAddr) notes.push('wrapped native coin could not be read from the router: trades paid in it may show as transfers');
  const quotes = new Map<string, string>([[NATIVE, info.nativeSym], ...info.stables.map(s => [s.address, s.sym] as [string, string])]);
  const head = Number(BigInt(await rpc.call<string>('eth_blockNumber')));
  // a direction that returned its full page may be missing the older legs of its oldest transactions: drop everything at or before that block
  let boundary = -1; for (const d of out) if (d.length >= 100) boundary = Math.max(boundary, Number(BigInt(d[d.length - 1].blockNum)));
  if (boundary >= 0) notes.push(`this wallet has more than 100 transfers per direction in the window read; trades at or before block ${boundary} are left out so none is shown half-read`);
  const seen = new Set<string>(), groups = new Map<string, { block: number; ts?: number; d: Map<string, bigint> }>(), order: string[] = [];
  const add = (g: { d: Map<string, bigint> }, k: string, v: bigint) => g.d.set(k, (g.d.get(k) ?? 0n) + v);
  for (const t of out.flat()) {
    const id = t.uniqueId ?? `${t.hash}:${t.category}:${t.from}:${t.to}:${t.rawContract?.value}:${t.rawContract?.address}`; if (seen.has(id)) continue; seen.add(id);
    const block = Number(BigInt(t.blockNum)); if (block <= boundary) continue;
    let raw: bigint; try { raw = BigInt(t.rawContract?.value ?? '0x0'); } catch { continue; } if (raw === 0n) continue;
    const hash = lc(t.hash); let g = groups.get(hash); if (!g) { g = { block, ts: t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : undefined, d: new Map() }; groups.set(hash, g); order.push(hash); }
    let key = t.category === 'erc20' ? lc(t.rawContract.address ?? '') : NATIVE; if (key === wrappedAddr) key = NATIVE;       // WETH/WBNB and the native coin are one quote asset
    if (key !== NATIVE && !tokens[key]) tokens[key] = { sym: t.asset ?? undefined, decimals: t.rawContract.decimal ? Number(BigInt(t.rawContract.decimal)) : undefined };
    if (t.from && lc(t.from) === who) add(g, key, -raw); if (t.to && lc(t.to) === who) add(g, key, raw);
  }
  order.sort((a, b) => groups.get(b)!.block - groups.get(a)!.block);
  const perBlock = new Map<number, number>(); for (const h of order) perBlock.set(groups.get(h)!.block, (perBlock.get(groups.get(h)!.block) ?? 0) + 1);
  const events: LeaderEvent[] = []; let balanceIssue = false, shared = false;
  for (const hash of order) {
    if (events.length >= limit) break; const g = groups.get(hash)!, nz = [...g.d].filter(([, v]) => v !== 0n); if (!nz.length) continue;
    const toks = nz.filter(([k]) => !quotes.has(k)), qs = nz.filter(([k]) => quotes.has(k)); if (!toks.length) continue;     // only the money asset moved: not a token trade
    const base = { provider: 'rpc', chain, txHash: hash, logIndex: 0, leader: who, confirmations: head - g.block + 1 };
    const none = { quoteAmount: 0n, tokenAmount: 0n, leaderBalanceBefore: 0n, leaderBalanceAfter: 0n, leaderPriceE18: 0n };
    const [token, td] = toks[0], q = toks.length === 1 ? qs.filter(([, v]) => (v > 0n) !== (td > 0n)).sort((a, b) => (abs(b[1]) > abs(a[1]) ? 1 : -1))[0] : undefined;
    if (toks.length !== 1 || !q) { events.push({ ...base, kind: 'transfer', side: td > 0n ? 'buy' : 'sell', token, ...none }); extras[hash] = { ts: g.ts, quoteSym: '', quoteToken: '' }; continue; }
    const tokenAmount = abs(td), quoteAmount = abs(q[1]); let before = 0n, after = 0n;
    if (perBlock.get(g.block) === 1 && !balanceIssue) {      // exact only when this is the wallet's only transaction in the block
      try { const bal = async (blk: number) => { const c = erc20.balanceOf(token, who); return erc20.decodeUint(await rpc.call<string>('eth_call', [{ to: c.to, data: c.data }, '0x' + blk.toString(16)])); };
        before = await bal(g.block - 1); after = await bal(g.block); } catch { balanceIssue = true; before = 0n; after = 0n; }
    } else if (perBlock.get(g.block)! > 1) shared = true;
    events.push({ ...base, kind: 'swap', side: td > 0n ? 'buy' : 'sell', token, quoteAmount, tokenAmount, leaderBalanceBefore: before, leaderBalanceAfter: after, leaderPriceE18: quoteAmount * E18 / tokenAmount });
    extras[hash] = { ts: g.ts, quoteSym: quotes.get(q[0])!, quoteToken: q[0] };
  }
  if (balanceIssue) notes.push('the node could not serve balances at older blocks: the wallet\'s balance before/after a trade is unknown (shown as 0), so a sell cannot be sized as a share of the position');
  if (shared) notes.push('some trades share a block with another transaction of this wallet: their balance before/after is unknown (shown as 0)');
  notes.push('swaps are inferred from token and coin transfers: aggregator or multi-hop routes can appear as transfers, and a trade against an asset other than ' + [info.nativeSym, ...info.stables.map(s => s.sym)].join('/') + ' is shown as a transfer');
  await dexMeta(deps, info.dsChain, Object.keys(tokens).filter(k => !tokens[k].sym), tokens, notes);
  return { chain, address: who, events, tokens, notes, at, extras };
}
