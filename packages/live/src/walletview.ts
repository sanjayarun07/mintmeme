/** Read-only view of ANY public wallet address on Ethereum, BNB Chain or Solana: native balance, token balances, and market prices. No keys, nothing is ever sent.
 *  Balances come from the chain (through the read-only Rpc allowlist). Prices come from DexScreener, a third-party service whose prices can be spoofed for illiquid tokens; they are never zero-filled
 *  or guessed: no price means `price`/`usd` are left undefined and the holding is not counted in `totalUsd`. All raw amounts are decimal strings so the result is JSON-safe. */
import { b58decode } from '../../sol/src/tx.ts';
import { ETH, BSC, SOL_POOL } from './config.ts';

export type WalletChain = 'ethereum' | 'bnb' | 'solana';
export interface RpcLike { call<T = any>(method: string, params?: unknown[]): Promise<T> }
export interface WalletViewDeps { rpcFor(chain: WalletChain): RpcLike; fetchFn?: typeof fetch; now?: () => number }
export interface WalletToken { contract: string; sym: string; name: string; decimals: number; amount: string; price?: number; usd?: number; source: 'dexscreener' | 'none' }
export interface WalletView { chain: WalletChain; address: string; native: { sym: string; amount: string; decimals: number; usd?: number }; tokens: WalletToken[]; totalUsd?: number; notes: string[]; at: number }

const DS = 'https://api.dexscreener.com', DS_CHAIN = { ethereum: 'ethereum', bnb: 'bsc', solana: 'solana' } as const;
const MAX_SHOWN = 25, MAX_PRICED = 90, MAX_META = 40, TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const NATIVE = { ethereum: { sym: 'ETH', decimals: 18 }, bnb: { sym: 'BNB', decimals: 18 }, solana: { sym: 'SOL', decimals: 9 } } as const;
const WETH_SELECTOR = '0xad5c4648';           // WETH(): the router tells us the wrapped-native token, so no address is typed in from memory

export function validateAddress(chain: WalletChain, address: string): string {
  if (chain === 'ethereum' || chain === 'bnb') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('not a valid EVM address: expected 0x followed by 40 hex characters');
    return address.toLowerCase();
  }
  if (chain === 'solana') {
    let ok = false; try { ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && b58decode(address).length === 32; } catch { ok = false; }
    if (!ok) throw new Error('not a valid Solana address: expected a base58 public key of 32 bytes');
    return address;
  }
  throw new Error(`unsupported chain ${String(chain)}`);
}

const usdOf = (raw: string, decimals: number, price: number) => Number(BigInt(raw)) / 10 ** decimals * price;
const hexToDec = (h: string) => BigInt(h).toString();

export async function loadWalletView(d: WalletViewDeps, req: { chain: WalletChain; address: string }): Promise<WalletView> {
  const chain = req.chain, address = validateAddress(chain, req.address), f = d.fetchFn ?? fetch, now = d.now ?? Date.now, rpc = d.rpcFor(chain), notes: string[] = [];
  const json = async (u: string) => { const r = await f(u); if (!r.ok) throw new Error(`HTTP ${r.status} from market data`); return r.json() as Promise<any>; };
  const nat = NATIVE[chain];
  type Cand = { contract: string; decimals?: number; amount: string; sym?: string; name?: string };
  let nativeRaw = '0'; let cands: Cand[] = [];

  // ---- balances (chain)
  if (chain === 'solana') {
    const bal = await rpc.call<any>('getBalance', [address, { commitment: 'confirmed' }]); nativeRaw = String(BigInt(bal.value ?? bal));
    const by = new Map<string, Cand>();
    try {
      const r = await rpc.call<any>('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const a of r.value ?? []) {
        const i = a.account?.data?.parsed?.info; if (!i?.mint) continue; const amt = BigInt(i.tokenAmount?.amount ?? '0'); if (amt === 0n) continue;
        const cur = by.get(i.mint); by.set(i.mint, { contract: i.mint, decimals: Number(i.tokenAmount.decimals), amount: String((cur ? BigInt(cur.amount) : 0n) + amt) });
      }
    } catch (e) { notes.push(`Token accounts could not be read (${(e as Error).message.slice(0, 80)}). Wallets that own a huge number of token accounts (for example a program authority) cannot be listed here, so only the SOL balance is shown.`); }
    cands = [...by.values()];
    notes.push('Token-2022 token accounts are not read: their program id is not in this codebase\'s sourced constants, so those holdings are not shown.');
  } else {
    nativeRaw = hexToDec(await rpc.call<string>('eth_getBalance', [address, 'latest']));
    try {
      const r = await rpc.call<any>('alchemy_getTokenBalances', [address, 'erc20']);
      for (const t of r.tokenBalances ?? []) { if (t.error || !t.tokenBalance) continue; const amt = BigInt(t.tokenBalance); if (amt > 0n) cands.push({ contract: String(t.contractAddress).toLowerCase(), amount: amt.toString() }); }
      if (cands.length >= 100) notes.push('The node returned its first 100 token balances; holdings beyond that are not shown.');
    } catch (e) { notes.push(`Token balances are not available from this node (${(e as Error).message.slice(0, 80)}). They need an Alchemy-enabled node, so only the native balance is shown.`); }
  }

  // ---- prices (DexScreener): one request per 30 addresses, highest-liquidity pair where the token is the BASE token
  const best = new Map<string, any>(); let priceFailed = false;
  const priceBatch = async (addrs: string[]) => {
    for (let i = 0; i < addrs.length; i += 30) {
      try { const pairs = await json(`${DS}/tokens/v1/${DS_CHAIN[chain]}/${addrs.slice(i, i + 30).join(',')}`);
        for (const p of Array.isArray(pairs) ? pairs : []) { const k = String(p.baseToken?.address ?? ''), key = chain === 'solana' ? k : k.toLowerCase(); if (key && Number(p.priceUsd) > 0 && (p.liquidity?.usd ?? 0) > (best.get(key)?.liquidity?.usd ?? -1)) best.set(key, p); } }
      catch { priceFailed = true; }
    }
  };
  let wrapped: string | undefined;
  if (chain !== 'solana') {
    const router = chain === 'ethereum' ? ETH.uniswapV2Router02.address : BSC.pancakeV2Router.address;
    try { const w = await rpc.call<string>('eth_call', [{ to: router, data: WETH_SELECTOR }, 'latest']); if (/^0x[0-9a-f]{64}$/i.test(w)) wrapped = '0x' + w.slice(-40).toLowerCase(); } catch { /* native price unavailable */ }
  } else wrapped = SOL_POOL.wsol.mint;
  // balances first, so the priced set is the largest holdings by raw size only as a tie-break; ranking is by USD after pricing
  const toPrice = [...cands].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)).slice(0, MAX_PRICED).map(c => c.contract);
  if (cands.length > MAX_PRICED) notes.push(`${cands.length} token holdings found; the ${MAX_PRICED} largest by raw balance were priced.`);
  await priceBatch([...(wrapped ? [wrapped] : []), ...toPrice]);
  if (priceFailed) notes.push('Some price lookups failed; those holdings show no value.');
  const keyOf = (a: string) => (chain === 'solana' ? a : a.toLowerCase());
  const priceOf = (a: string) => { const p = best.get(keyOf(a)); return p ? Number(p.priceUsd) : undefined; };

  // ---- decimals / names for EVM (Alchemy metadata), for the candidates most likely to matter: priced ones first, by pool liquidity
  if (chain !== 'solana' && cands.length) {
    const ranked = [...cands].sort((a, b) => (best.get(keyOf(b.contract))?.liquidity?.usd ?? -1) - (best.get(keyOf(a.contract))?.liquidity?.usd ?? -1)).slice(0, MAX_META);
    for (let i = 0; i < ranked.length; i += 8) await Promise.all(ranked.slice(i, i + 8).map(async c => {
      try { const m = await rpc.call<any>('alchemy_getTokenMetadata', [c.contract]); if (typeof m?.decimals === 'number') { c.decimals = m.decimals; c.sym = m.symbol ?? undefined; c.name = m.name ?? undefined; } } catch { /* leave undefined */ }
    }));
  }

  const tokens: WalletToken[] = [];
  for (const c of cands) {
    const p = best.get(keyOf(c.contract)), price = priceOf(c.contract);
    if (c.decimals === undefined && !p && chain !== 'solana') continue;                    // an EVM token we know nothing about (no decimals, no market): not worth a row
    const sym = c.sym ?? p?.baseToken?.symbol ?? (c.contract.slice(0, 4) + '…' + c.contract.slice(-4)), name = c.name ?? p?.baseToken?.name ?? '';
    const decimals = c.decimals ?? -1;
    const priced = price !== undefined && decimals >= 0;
    tokens.push({ contract: c.contract, sym, name, decimals: decimals < 0 ? 0 : decimals, amount: c.amount, ...(priced ? { price, usd: usdOf(c.amount, decimals, price!) } : {}), source: priced ? 'dexscreener' : 'none' });
  }
  const shown = tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).slice(0, MAX_SHOWN);
  if (tokens.length > MAX_SHOWN) notes.push(`${tokens.length - MAX_SHOWN} smaller or unpriced holdings are not shown.`);

  const np = wrapped ? priceOf(wrapped) : undefined, native: WalletView['native'] = { sym: nat.sym, amount: nativeRaw, decimals: nat.decimals, ...(np !== undefined ? { usd: usdOf(nativeRaw, nat.decimals, np) } : {}) };
  if (np === undefined) notes.push(`The ${nat.sym} price is not available, so the native balance has no value.`);
  const pricedAll = tokens.filter(t => t.usd !== undefined), unpriced = tokens.filter(t => t.usd === undefined).length;
  const totalUsd = native.usd !== undefined || pricedAll.length ? (native.usd ?? 0) + pricedAll.reduce((s, t) => s + t.usd!, 0) : undefined;
  if (unpriced) notes.push(`${unpriced} holding${unpriced === 1 ? '' : 's'} ha${unpriced === 1 ? 's' : 've'} no market price and ${unpriced === 1 ? 'is' : 'are'} not counted in the total.`);
  notes.push('Prices come from DexScreener, a third-party service. Prices of illiquid tokens can be spoofed. Balances are read from the chain.');
  return { chain, address, native, tokens: shown, ...(totalUsd !== undefined ? { totalUsd } : {}), notes, at: now() };
}
