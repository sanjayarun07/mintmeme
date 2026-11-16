/** Real launch feed for the Sniper page. READ-ONLY: nothing is signed or sent. It merges three real sources and runs our own risk check on what it can:
 *   1. launchpad tokens and brand-new pools already found by the real-markets loader (Pump.fun curves, Four.meme, newest DEX pools),
 *   2. Raydium AMM v4 pool CREATIONS, read from chain by RaydiumLaunchSource (each verified on chain: owner = AMM v4 program, 752 bytes, mints from the pool account),
 *   3. for Solana mints, the mint-account check (freeze / mint authority, Token-2022) from MintInspector.
 *  Then a DRY-RUN of sniper rules says what the sniper WOULD do. It never buys. Names and USD figures for tokens we did not discover ourselves come from DexScreener (third party). */
import { RaydiumLaunchSource, MintInspector } from '../../sol/src/index.ts';
import type { RealToken } from './realmarkets.ts';
import { SOL, RAYDIUM_V4_POOL_CREATION_WATCH } from './config.ts';

export interface LaunchItem {
  id: string; chain: 'ethereum' | 'bnb' | 'solana'; sym: string; name: string; contract: string; pool: string; venue: string; pad: string | null;
  source: 'launchpad' | 'new-pool' | 'raydium-creation'; stage: 'new' | 'almost' | 'migrated' | 'market'; ageMin: number | null; liqUsd: number | null; price: number | null;
  verdict: 'no-flags' | 'warn' | 'quarantined' | 'blocked' | 'unchecked'; flags: string[];
  dryRun: { wouldBuy: boolean; why: string }; executable: boolean;
  /** set on items that came from the live stream */
  live?: boolean; seenAt?: number; sig?: string; slot?: number; creator?: string; via?: 'ws' | 'poll';
}
export interface LaunchRules { minLiqUsd: number; maxAgeMin: number }
export const DEFAULT_RULES: LaunchRules = { minLiqUsd: 5_000, maxAgeMin: 24 * 60 };
export interface LaunchDeps { rpc: { sol: { call<T = any>(m: string, p?: unknown[]): Promise<T> } }; fetchFn?: typeof fetch; now?: () => number; raydiumLimit?: number; watch?: string }
const WSOL = 'So11111111111111111111111111111111111111112';
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Which venues this engine can actually trade today (so the page never implies a snipe that cannot happen). */
const executable = (chain: string, venue: string, pad: string | null) =>
  pad === null && (chain === 'solana' ? /raydium/i.test(venue) : /uniswap v2|pancakeswap v2/i.test(venue));

/** Dry run of the example sniper rules on one item: sets `executable` and `dryRun`. Never buys. */
export function applyDryRun(i: LaunchItem, rules: LaunchRules = DEFAULT_RULES) {
  i.executable = executable(i.chain, i.venue, i.pad);
  const why: string[] = [];
  if (!i.executable) why.push(i.pad === 'pump-fun' ? (i.stage === 'migrated' ? 'this Pump.fun token now trades on PumpSwap, which this engine cannot trade yet' : 'Pump.fun curves cannot be traded by this engine yet') : `${i.venue} is not a venue this engine trades`);
  if (i.verdict === 'blocked' || i.verdict === 'quarantined') why.push(`risk check: ${i.verdict}`);
  if (i.liqUsd === null) why.push('liquidity unknown'); else if (i.liqUsd < rules.minLiqUsd) why.push(`liquidity $${Math.round(i.liqUsd).toLocaleString('en-US')} is under the $${rules.minLiqUsd.toLocaleString('en-US')} minimum`);
  if (i.ageMin !== null && i.ageMin > rules.maxAgeMin) why.push('older than the launch window');
  if (i.chain !== 'solana' && i.verdict === 'unchecked') why.push('EVM pre-trade sell/tax simulation is not available on a read-only node');
  i.dryRun = why.length ? { wouldBuy: false, why: why.join('; ') } : { wouldBuy: true, why: 'meets the example rules (not a recommendation)' };
}

export async function loadLaunches(d: LaunchDeps, tokens: RealToken[], rules: LaunchRules = DEFAULT_RULES): Promise<{ items: LaunchItem[]; notes: string[]; at: number }> {
  const now = d.now ?? Date.now, notes: string[] = [], fetchFn = d.fetchFn ?? fetch, items = new Map<string, LaunchItem>();
  const mintCheck = new MintInspector(d.rpc.sol as any, () => Math.floor(now() / 1000));
  // 1. launchpad / new-pool tokens from the real-markets list
  for (const t of tokens) {
    if (!(t.pad !== null || t.col === 'new' || t.col === 'near')) continue;
    items.set(t.contract.toLowerCase(), { id: t.id, chain: t.chain, sym: t.sym, name: t.name, contract: t.contract, pool: t.pool, venue: t.venue, pad: t.pad, source: t.pad ? 'launchpad' : 'new-pool', stage: t.stage,
      ageMin: Number.isFinite(t.poolAge) ? t.poolAge : null, liqUsd: t.liq ?? null, price: t.price ?? null, verdict: 'unchecked', flags: t.findings.filter(f => f.lvl === 'warn' && !/pool account is not/i.test(f.text)).map(f => f.text), dryRun: { wouldBuy: false, why: '' }, executable: false });
  }
  // 2. Raydium AMM v4 pool creations, straight from chain
  try {
    const src: any = new RaydiumLaunchSource({ chain: 'solana', program: SOL.programs[0].address, wsol: WSOL, quoteMints: [WSOL] }, d.rpc.sol as any);
    const rows: any[] = await d.rpc.sol.call('getSignaturesForAddress', [d.watch ?? RAYDIUM_V4_POOL_CREATION_WATCH, { limit: d.raydiumLimit ?? 6, commitment: 'confirmed' }]);
    const created: { mint: string; pool: string; slot: number; quoteLiq: bigint }[] = [];
    for (const r of rows) { if (r.err) continue; for (const e of await src.parse(r.signature)) created.push({ mint: e.token, pool: e.venueId, slot: e.block, quoteLiq: e.quoteLiquidity ?? 0n }); }
    const fresh = created.filter(c => !items.has(c.mint.toLowerCase()));
    const meta = new Map<string, { sym: string; name: string; price: number | null; liq: number | null }>();
    for (let i = 0; i < fresh.length; i += 30) {
      try { const j: any = await (await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${fresh.slice(i, i + 30).map(f => f.mint).join(',')}`)).json();
        for (const p of j?.pairs ?? []) { const m = p.baseToken?.address; if (!m || meta.has(m)) continue; meta.set(m, { sym: p.baseToken.symbol, name: p.baseToken.name, price: p.priceUsd ? Number(p.priceUsd) : null, liq: p.liquidity?.usd ?? null }); } }
      catch (e) { notes.push(`DexScreener names unavailable for new Raydium pools: ${(e as Error).message}`); }
    }
    let solUsd: number | null = null;     // for pools DexScreener does not list: liquidity from the pool's own quote vault (read on chain), counted both sides like DexScreener does
    if (fresh.some(f => !meta.get(f.mint)?.liq)) { try { const j: any = await (await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${WSOL}`)).json(); const p = (j?.pairs ?? []).sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]; solUsd = p?.priceUsd ? Number(p.priceUsd) : null; } catch { /* leave unknown */ } }
    const nowS = Math.floor(now() / 1000);
    for (const c of fresh) {
      let ageMin: number | null = null; try { const bt = await d.rpc.sol.call<number | null>('getBlockTime', [c.slot]); if (bt) ageMin = Math.max(0, Math.round((nowS - bt) / 60)); } catch { /* old slot: block time may be pruned */ }
      const m = meta.get(c.mint);
      items.set(c.mint.toLowerCase(), { id: `raydium:${c.pool}`, chain: 'solana', sym: m?.sym ?? short(c.mint), name: m?.name ?? 'Unnamed token', contract: c.mint, pool: c.pool, venue: 'Raydium AMM v4', pad: null, source: 'raydium-creation', stage: 'new',
        ageMin, liqUsd: m?.liq ?? (solUsd !== null ? Number(c.quoteLiq) / 1e9 * solUsd * 2 : null), price: m?.price ?? null, verdict: 'unchecked', flags: [], dryRun: { wouldBuy: false, why: '' }, executable: false });
    }
    if (!created.length) notes.push('No Raydium AMM v4 pool creations in the most recent transactions of the creation account (they are rare now: most launches are on other programs).');
  } catch (e) { notes.push(`Raydium pool-creation scan failed: ${(e as Error).message}`); }
  // 3. Solana mint-account risk (cap, to stay inside the node's rate limit)
  const sol = [...items.values()].filter(i => i.chain === 'solana').slice(0, 24);
  for (const i of sol) {
    try { await mintCheck.inspect(i.contract); const r = mintCheck.riskCheck({ token: i.contract }, 0); i.verdict = r.verdict; i.flags = [...i.flags, ...r.flags.filter(f => !/sell was not simulated|not simulated/.test(f))]; }
    catch (e) { i.verdict = 'unchecked'; i.flags.push(`mint account not readable: ${(e as Error).message}`); }
  }
  // 4. dry-run of sniper rules
  for (const i of items.values()) applyDryRun(i, rules);
  const out = [...items.values()].sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)).slice(0, 40);
  return { items: out, notes, at: now() };
}
