/** Real coins for the terminal's Discover page: READ-ONLY. Market data (price, liquidity, volume, age) comes from DexScreener's public API, which is THIRD-PARTY and can list spoofed
 *  tokens (fake "WBNB" etc.), so every pool is then checked ON-CHAIN by us before it is marked verified:
 *   - Ethereum / BNB Smart Chain: the official V2 factory's getPair(token0, token1) must return the listed pool address;
 *   - Solana: the pool account must be owned by the Raydium AMM v4 program and be 752 bytes.
 *  A pool that fails (or is on a venue we do not read, e.g. V3) is still shown but flagged and can never be bought. Nothing is signed or sent. */
import { Rpc } from './rpc.ts';
import { ETH, BSC, SOL, urls, urlsBsc } from './config.ts';
import { readPumpCurve, readFour, discoverFour, PAD } from './launchpads.ts';

export interface RealToken { id: string; name: string; sym: string; chain: 'ethereum' | 'bnb' | 'solana'; contract: string; pool: string; venue: string; verified: boolean; real: true; col: 'new' | 'near' | 'active'; pad: 'pump-fun' | 'four-meme' | null; stage: 'new' | 'almost' | 'migrated' | 'market'; migration?: { pct: number }; tokenAge: number; poolAge: number; price: number; chg: number | null; liq: number; vol: number; mcap: number | null; fdv: number | null; act: number; color: string; owner: null; findings: { lvl: 'ok' | 'warn' | 'info'; text: string; ago: number }[]; tax: null; source: string }
const DS = 'https://api.dexscreener.com'; const PER_CHAIN = 90, PER_SHOWN = 30, PER_CHECKED = 60;
// GeckoTerminal public API (no key, ~30 calls/min): a second, independent list of what is trending and what trades most, per network. Market data only; every pool is still checked on-chain below.
const GECKO = 'https://api.geckoterminal.com/api/v2/networks', GECKO_NET: Record<string, string> = { solana: 'solana', ethereum: 'eth', bsc: 'bsc' };
const word = (h: string) => '0x' + h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const color = (s: string) => `hsl(${[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 55% 68%)`;
const EVM = { ethereum: { ds: 'ethereum', chain: 'ethereum' as const, venue: 'Uniswap V2', factory: ETH.uniswapV2Factory.address, id: ETH.chainIdExpected }, bsc: { ds: 'bsc', chain: 'bnb' as const, venue: 'PancakeSwap V2', factory: BSC.pancakeV2Factory.address, id: BSC.chainIdExpected } };

export interface Deps { fetchFn?: typeof fetch; rpc: { ethereum: Rpc; bsc: Rpc; sol: Rpc }; now?: () => number; geckoGapMs?: number; geckoMemo?: Map<string, { at: number; addrs: string[] }> }
export async function loadRealMarkets(d: Deps): Promise<{ tokens: RealToken[]; notes: string[]; at: number }> {
  const f = d.fetchFn ?? fetch, now = d.now ?? Date.now, notes: string[] = [];
  const json = async (u: string) => { const r = await f(u); if (!r.ok) throw new Error(`HTTP ${r.status} from market data`); return r.json() as Promise<any>; };
  // 1. candidate tokens: what is boosted and newly profiled right now, per chain (market data only; nothing here is trusted yet)
  const seeds = new Map<string, Set<string>>(); const add = (c: string, a: string) => { if (c in EVM || c === 'solana') (seeds.get(c) ?? seeds.set(c, new Set()).get(c)!).add(a); };
  for (const u of ['/token-boosts/top/v1', '/token-profiles/latest/v1', '/token-boosts/latest/v1']) { try { for (const x of await json(DS + u)) if (x.chainId && x.tokenAddress) add(x.chainId, x.tokenAddress); } catch (e) { notes.push(`${u}: ${(e as Error).message}`); } }
  // GeckoTerminal: trending pools and most-traded pools on each network. Spaced out to stay inside its free rate limit; a 429 is reported, never retried in a loop.
  let gecko = 0, geckoFailed = 0;
  for (const [c, net] of Object.entries(GECKO_NET)) for (const kind of ['trending_pools', 'pools']) {
    const memoKey = `${c}:${kind}`;
    if (geckoFailed >= 2) { const m = d.geckoMemo?.get(memoKey); if (m && now() - m.at < 30 * 60_000) for (const a of m.addrs) add(c, a); continue; }   // the service is refusing us: no more requests this round, but a recent good list is still used
    try { if (gecko++ && (d.geckoGapMs ?? 2300)) await new Promise(r => setTimeout(r, d.geckoGapMs ?? 2300));
      const r = await json(`${GECKO}/${net}/${kind}`); const got: string[] = [];
      for (const p of r.data ?? []) { const id: string | undefined = p.relationships?.base_token?.data?.id; if (id?.startsWith(net + '_')) got.push(id.slice(net.length + 1)); }
      for (const a of got) add(c, a); d.geckoMemo?.set(memoKey, { at: now(), addrs: got }); }
    catch (e) { geckoFailed++; const m = d.geckoMemo?.get(memoKey);
      if (m && now() - m.at < 30 * 60_000) { for (const a of m.addrs) add(c, a); notes.push(`GeckoTerminal ${net} ${kind}: ${(e as Error).message}; using the list from ${Math.round((now() - m.at) / 60000)} min ago`); }
      else notes.push(`GeckoTerminal ${net} ${kind}: ${(e as Error).message}`); }
  }
  // also pairs from name searches, so every chain is represented, not only whatever is boosted (still market data only, verified below)
  const found = new Map<string, any[]>();
  for (const q of ['WETH', 'WBNB', 'SOL', 'pepe', 'doge', 'uniswap', 'pancakeswap', 'USDT', 'shib', 'floki']) { try { const r = await json(`${DS}/latest/dex/search?q=${q}`); for (const p of r.pairs ?? []) if (p.chainId in EVM || p.chainId === 'solana') (found.get(p.chainId) ?? found.set(p.chainId, []).get(p.chainId)!).push(p); } catch (e) { notes.push(`search ${q}: ${(e as Error).message}`); } }
  for (const c of found.keys()) if (!seeds.has(c)) seeds.set(c, new Set());
  const out: RealToken[] = [];
  for (const [c, set] of seeds) {
    const addrs = [...set].slice(0, PER_CHAIN); let pairs: any[] = [];
    for (let i = 0; i < addrs.length; i += 30) { try { pairs.push(...await json(`${DS}/tokens/v1/${c}/${addrs.slice(i, i + 30).join(',')}`)); } catch (e) { notes.push(`${c}: ${(e as Error).message}`); } }   // the market API takes at most 30 tokens per call
    const seeded = new Set(addrs.map(a => a.toLowerCase()));
    for (const p of found.get(c) ?? []) { pairs.push(p); if (p.baseToken?.address) addrs.push(p.baseToken.address); }
    const best = new Map<string, any>(); for (const p of pairs) { const k = p.baseToken?.address; if (k && addrs.some(a => same(a, k)) && (p.liquidity?.usd ?? 0) > (best.get(k)?.liquidity?.usd ?? -1)) best.set(k, p); }
    for (const p of [...best.values()].sort((a, b) => Number(seeded.has(b.baseToken.address.toLowerCase())) - Number(seeded.has(a.baseToken.address.toLowerCase())) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, PER_CHECKED)) {
      let verified = false, venue = 'unverified venue', why = '';
      try {
        if (c === 'solana') { const a: any = await d.rpc.sol.call('getAccountInfo', [p.pairAddress, { encoding: 'base64' }]); verified = a?.value?.owner === SOL.programs[0].address && a.value.space === 752; venue = 'Raydium AMM v4'; why = verified ? '' : 'The pool account is not a Raydium AMM v4 pool, so it cannot be traded here.'; }
        else { const e = EVM[c as 'ethereum' | 'bsc']; const rpc = d.rpc[c as 'ethereum' | 'bsc']; const r: string = await rpc.call('eth_call', [{ to: e.factory, data: '0xe6a43905' + word(p.baseToken.address).slice(2) + word(p.quoteToken.address).slice(2) }, 'latest']);
          verified = same('0x' + r.slice(-40), p.pairAddress); venue = e.venue; why = verified ? '' : `This pool is not an official ${e.venue} pool (it may be another venue, a V3 pool or a spoofed pair).`; }
      } catch (e) { why = `Could not check this pool on-chain: ${(e as Error).message}`; }
      const created = p.pairCreatedAt ? Math.max(0, Math.round((now() - p.pairCreatedAt) / 60000)) : 0, chain = c === 'solana' ? 'solana' : EVM[c as 'ethereum' | 'bsc'].chain;
      out.push({ id: `${chain}:${p.baseToken.address}`, name: p.baseToken.name, sym: p.baseToken.symbol, chain, contract: p.baseToken.address, pool: p.pairAddress, venue, verified, real: true, col: created < 1440 ? 'new' : 'active', pad: null, stage: 'market',
        tokenAge: created, poolAge: created, price: Number(p.priceUsd) || 0, chg: p.priceChange?.h24 ?? null, liq: p.liquidity?.usd ?? 0, vol: p.volume?.h24 ?? 0, mcap: p.marketCap ?? null, fdv: p.fdv ?? null,
        act: (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), color: color(p.baseToken.address), owner: null, tax: null, source: 'DexScreener (third-party) + our on-chain pool check',
        findings: [verified ? { lvl: 'ok', text: `Pool confirmed on-chain on ${venue}.`, ago: 0 } : { lvl: 'warn', text: why, ago: 0 }, { lvl: 'info', text: 'Real market data, read-only. Token contract safety (tax, honeypot, owner powers) is not checked here.', ago: 0 }] });
    }
  }
  // Launchpad pass: is this token on a Pump.fun curve or a Four.meme curve? Read on-chain; a launchpad token also gets a finding with its state.
  const mark = (t: RealToken, pad: 'pump-fun' | 'four-meme', venue: string, lvl: 'ok' | 'warn' | 'info', text: string, verified?: boolean) => { t.pad = pad; if (verified) { t.verified = true; t.venue = venue; t.findings = t.findings.filter(f => !/^(The pool account is not|This pool is not an official|Could not check this pool)/.test(f.text)); } t.findings.unshift({ lvl, text, ago: 0 }); };
  for (const t of out) {
    try {
      if (t.chain === 'solana') { const c = await readPumpCurve(d.rpc.sol, t.contract); if (c) {
        const left = c.totalSupply > 0n ? Number(c.realToken * 1000n / c.totalSupply) / 10 : 0;
        t.stage = c.complete ? 'migrated' : 'new';
        if (c.complete) mark(t, 'pump-fun', 'Pump.fun', 'info', 'Launched on Pump.fun. The curve is complete, so liquidity moves to PumpSwap (not read here).');
        else mark(t, 'pump-fun', 'Pump.fun bonding curve', 'ok', `Pump.fun bonding curve confirmed on-chain. ${left}% of the supply is still on the curve. The graduation threshold is not published, so no progress bar is shown.`, true); } }
      else if (t.chain === 'bnb') { const i = await readFour(d.rpc.bsc, t.contract); if (i) applyFour(t, i, mark); }
    } catch (e) { notes.push(`launchpad check ${t.sym}: ${(e as Error).message}`); }
  }
  try {   // newest Four.meme launches that no market feed lists yet
    const have = new Set(out.map(t => t.contract.toLowerCase())); const fresh = (await discoverFour(d.rpc.bsc)).filter(c => !have.has(c.token.toLowerCase()));
    let mk: any[] = []; if (fresh.length) { try { mk = await json(`${DS}/tokens/v1/bsc/${fresh.map(c => c.token).join(',')}`); } catch { /* no market data for brand-new tokens is normal */ } }
    for (const c of fresh) { const i = await readFour(d.rpc.bsc, c.token); if (!i) continue; const p = mk.filter(x => same(x.baseToken?.address ?? '', c.token)).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const age = i.launchTime ? Math.max(0, Math.round((now() / 1000 - i.launchTime) / 60)) : 0;
      const t: RealToken = { id: `bnb:${c.token}`, name: c.name, sym: c.symbol, chain: 'bnb', contract: c.token, pool: PAD.fourMeme.tokenManager2, venue: 'Four.meme bonding curve', verified: false, real: true, col: age < 1440 ? 'new' : 'active', pad: null, stage: 'market', tokenAge: age, poolAge: age,
        price: Number(p?.priceUsd) || 0, chg: p?.priceChange?.h24 ?? null, liq: p?.liquidity?.usd ?? 0, vol: p?.volume?.h24 ?? 0, mcap: p?.marketCap ?? null, fdv: p?.fdv ?? null, act: 0, color: color(c.token), owner: null, tax: null, source: 'Four.meme TokenCreate event + official Helper3 contract (no third-party market data unless listed)',
        findings: [{ lvl: 'info', text: 'Real launch read from the chain. Token contract safety (tax, honeypot, owner powers) is not checked here.', ago: 0 }] };
      applyFour(t, i, mark); out.push(t); }
  } catch (e) { notes.push(`four.meme discovery: ${(e as Error).message}`); }
  // No chain may crowd out the others: keep the best PER_SHOWN of each chain (confirmed first, then liquidity), launchpad tokens always kept.
  const rank = (a: RealToken, b: RealToken) => Number(b.verified) - Number(a.verified) || Number(!!b.pad) - Number(!!a.pad) || b.liq - a.liq;
  // Spoofs copy popular names (a dozen fake "SOL" tokens): per chain keep only the best-ranked token for each symbol.
  const kept: RealToken[] = []; for (const c of ['ethereum', 'bnb', 'solana']) { const seen = new Set<string>(); for (const t of out.filter(t => t.chain === c).sort(rank)) { const k = t.sym.toUpperCase(); if (seen.has(k)) continue; seen.add(k); kept.push(t); if (seen.size >= PER_SHOWN) break; } }
  out.length = 0; out.push(...kept);
  out.sort(rank);
  return { tokens: out, notes, at: now() };
}
function applyFour(t: RealToken, i: NonNullable<Awaited<ReturnType<typeof readFour>>>, mark: (t: RealToken, pad: 'pump-fun' | 'four-meme', venue: string, lvl: 'ok' | 'warn' | 'info', text: string, verified?: boolean) => void) {
  t.stage = i.liquidityAdded ? 'migrated' : i.pct != null && i.pct >= 70 ? 'almost' : 'new';
  if (i.liquidityAdded) { mark(t, 'four-meme', 'Four.meme', 'info', 'Launched on Four.meme. The curve is complete and liquidity was added to a DEX pool.'); return; }
  const official = same(i.tokenManager, PAD.fourMeme.tokenManager2) || same(i.tokenManager, PAD.fourMeme.tokenManager1);
  if (i.pct != null) { t.migration = { pct: i.pct }; if (i.pct >= 70) t.col = 'near'; }
  mark(t, 'four-meme', 'Four.meme bonding curve', official ? 'ok' : 'warn', official ? `Four.meme bonding curve confirmed on-chain: ${i.pct ?? '?'}% of the raise target reached. It graduates at 100% (liquidity goes to PancakeSwap).` : 'The token manager for this token is not an official Four.meme address.', official);
}
/** BSC node preference: BSC_RPC_URL if set, else the Alchemy BNB endpoint when this key can use it (checked with one eth_chainId call), else the official public endpoint. */
export async function makeRpc(key: string, fetchFn: typeof fetch = fetch) {
  let bsc = new Rpc(urlsBsc(), process.env.BSC_RPC_URL ? key : '', fetchFn, 40);
  if (!process.env.BSC_RPC_URL) { const a = new Rpc(`https://bnb-mainnet.g.alchemy.com/v2/${key}`, key, fetchFn, 40); try { await a.call('eth_chainId'); bsc = a; } catch { /* key not enabled for BNB: stay on the public endpoint */ } }
  return { ethereum: new Rpc(urls(key).eth, key, fetchFn, 40), bsc, sol: new Rpc(urls(key).sol, key, fetchFn, 40) };
}
export async function checkChainIds(rpc: Deps['rpc']) { // refuse to run if a node is not the chain we think it is
  for (const [k, want] of [['ethereum', ETH.chainIdExpected], ['bsc', BSC.chainIdExpected]] as const) { const got = BigInt(await rpc[k].call<string>('eth_chainId')); if (got !== want) throw new Error(`${k} node reports chain id ${got}, expected ${want}`); }
}
