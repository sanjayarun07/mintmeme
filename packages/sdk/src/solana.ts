/** ONE CALL FOR A REAL SOLANA TRADER signed by the user's own Privy wallet: `createSolanaTrader`. It assembles what /solana and the execution server use:
 *  Trader + Engine (write-ahead journal) + PolicySigner (per-trade and daily SOL caps, durable ledger) + SolanaChain (Jupiter and pump.fun) + PrivySolSigner.
 *  The user must first add your server signer with your policy to their Privy wallet (browser: useSigners().addSigners). Before anything is signed, Privy is asked whether
 *  that is still so; if not, the Trader is still returned (reads work) and every trade is refused with the reason (`active: false`, `why`).
 *  State: pass `persistDir` (files) or `state` (any Backend, e.g. Redis). Orders, the trade journal and the spend ledger survive restarts; call `trader.resume()` then `start()`.
 *  Call `prepare(token)` before quoting or trading a token the Trader has not seen (it finds the token's venues). Call `sync()` right before a market trade: deadlines
 *  use the chain's clock and quotes use pool state, both read by it. Restored orders' tokens are prepared on each tick. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Engine, Router, Store, PolicySigner, MemoryLedger, NATIVE, fileBackend } from '../../core/src/index.ts';
import type { Backend, SpentLedger, WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, SolJsonRpc, PrivyApi, PrivySolSigner, JitoSubmitter, TokenSafety, pumpAddresses, PROGRAMS, looksLikeMint } from '../../sol/src/index.ts';
import type { PrivyConfig, PriorityConfig, JitoOptions, SafetyReport, FeeRecipient } from '../../sol/src/index.ts';
import { fetchJupiterQuote } from '../../sol/src/jupiter.ts';
import { Trader } from './trader.ts';
import { SdkError } from './wire.ts';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', BIG = 10n ** 30n;
/** Defaults: at most 0.05 SOL per buy and 0.25 SOL of buys per day. Lower them per user if you like; the Privy policy caps SOL transfers separately. */
export const SOLANA_DEFAULT_CAPS = { maxTradeLamports: 50_000_000n, dailyCapLamports: 250_000_000n };

export interface SolanaTraderOptions {
  userId: string;
  /** The user's Privy Solana wallet address (the walletId used in every call). Undefined: a read-only account that refuses trades until a wallet is linked. */
  address?: string;
  rpcUrl: string; privy: PrivyConfig | PrivyApi;
  persistDir?: string; state?: (name: string) => Backend;
  caps?: { maxTradeLamports: bigint; dailyCapLamports: bigint };
  venues?: string[];
  /** SOL/USD for USD triggers. Default: a read-only Jupiter quote of 1 SOL into USDC, cached 30 s. */
  solUsd?: () => Promise<{ price: number; at: number } | null>;
  /** The Privy wallet id you saved when the user linked (checked against Privy). Optional. */
  walletId?: string;
  /** Priority fees (packages/sol/src/priorityfee.ts). Default on: 75th percentile of recent fees on the trade's accounts, at most 0.0001 SOL per transaction. false: off. */
  priority?: PriorityConfig | false;
  /** Token safety before buys (packages/sol/src/tokensafety.ts): 'block' (default) refuses tokens you might not be able to sell, 'warn' only reports, 'off' skips. */
  tokenSafety?: 'block' | 'warn' | 'off';
  /** Fee sharing: who receives a fee on each trade and how much (bps of the trade, paid in SOL inside the trade's own transaction). Read at every trade. The user's
   *  `maxFeeBps` on a trade (default 2%) still caps the total: a trade whose fees are above it fails before anything is signed. */
  fees?: () => FeeRecipient[];
  /** MEV protection (off by default): send every trade privately through Jito with a tip from the live tip floor (75th percentile, at most `maxTipLamports`, default
   *  0.0001 SOL), revert protection and the jitodontfront sandwich flag (packages/sol/src/submitter.ts). `jito` passes block-engine options (region URL, uuid, tests). */
  mevProtection?: boolean | MevOptions;
  log?: (m: string) => void;
}
export interface SolanaTrader { trader: Trader; chain: SolanaChain; active: boolean; why?: string; prepare: (token: string) => Promise<void>; sync: () => Promise<void>; refuseIfInactive: () => void;
  /** Token safety report (cached 60 s). */ safety: (mint: string) => Promise<SafetyReport>;
  /** Run before a buy: throws `unsafe_token` (409) for a blocked token unless `allowRisky` or tokenSafety is warn/off; returns the report. */ checkBuy: (mint: string, allowRisky?: boolean) => Promise<SafetyReport | undefined>;
  /** Plain units for one API call (see `simpleBody`): returns the body the Trader understands. */
  simple: (path: string, body: any) => Promise<any> }

/** Decimal string to integer units ("0.01" SOL, 9 decimals -> 10000000n). Refuses exponents, negatives and more decimals than the unit has. */
export function toUnits(v: unknown, decimals: number, what: string): bigint {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new SdkError('bad_amount', `${what} must be a plain positive decimal such as "0.01"`);
  const [i, f = ''] = s.split('.'); if (f.length > decimals) throw new SdkError('bad_amount', `${what} has more than ${decimals} decimals`);
  const n = BigInt(i + f.padEnd(decimals, '0')); if (n <= 0n) throw new SdkError('bad_amount', `${what} must be above zero`); return n;
}
const BUY_PATHS = new Set(['/v1/trades/buy', '/v1/orders/limit-buy']);
/** PLAIN UNITS, the way Jupiter's API reads: `mint` for the token, `sol` for SOL amounts, `tokens` or `pct` for what to sell, `price` in SOL per token or `priceUsd`,
 *  `slippagePct`, `trailPct`, `tpUsd` / `slUsd`; the wallet defaults to the linked one. Raw fields (`token`, `amount`, `priceE18`, `slippageBps`, ...) still work and win.
 *  `pct` on a sell order is taken from the wallet's balance now. Returns a new body; the input is not changed. */
export async function simpleBody(path: string, b: any, o: { address?: string; decimals: (mint: string) => Promise<number>; balance: (mint: string) => Promise<bigint>; /** The native coin's field and decimals: SOL (default) or { key: 'eth', decimals: 18 } on Base. */ native?: { key: string; decimals: number } }): Promise<any> {
  const nat = o.native ?? { key: 'sol', decimals: 9 };
  if (!b || typeof b !== 'object') return b; const x: any = { ...b };
  if (x.token === undefined && x.mint !== undefined) x.token = x.mint; delete x.mint;
  if (x.walletId === undefined && o.address && path !== '/v1/quote' && !path.startsWith('/v1/wallet') && !path.startsWith('/v1/bulk')) x.walletId = o.address;
  if (x.slippageBps === undefined && x.slippagePct !== undefined) x.slippageBps = Math.round(Number(x.slippagePct) * 100); delete x.slippagePct;
  if (x.trailBps === undefined && x.trailPct !== undefined) x.trailBps = Math.round(Number(x.trailPct) * 100); delete x.trailPct;
  if (x.takeProfitUsd === undefined && x.tpUsd !== undefined) x.takeProfitUsd = String(x.tpUsd); delete x.tpUsd;
  if (x.stopLossUsd === undefined && x.slUsd !== undefined) x.stopLossUsd = String(x.slUsd); delete x.slUsd;
  if (typeof x.priceUsd === 'number') x.priceUsd = x.priceUsd.toFixed(18).replace(/0+$/, '').replace(/\.$/, '');
  const buying = BUY_PATHS.has(path) || ((path === '/v1/twap' || path === '/v1/quote') && x.side === 'buy');
  const dec = async () => o.decimals(String(x.token));
  if (x.amount === undefined && x.total === undefined) {
    if (x[nat.key] !== undefined) { const v = toUnits(x[nat.key], nat.decimals, nat.key); if (path === '/v1/twap') x.total = v; else x.amount = v; }
    else if (x.tokens !== undefined && !buying) { const v = toUnits(x.tokens, await dec(), 'tokens'); if (path === '/v1/twap') x.total = v; else x.amount = v; }
    else if (x.pct !== undefined && !buying) { const bps = Math.round(Number(x.pct) * 100); if (!(bps >= 1 && bps <= 10_000)) throw new SdkError('bad_number', 'pct must be between 0.01 and 100');
      if (path === '/v1/trades/sell') x.pctBps ??= bps; else { const v = (await o.balance(String(x.token))) * BigInt(bps) / 10_000n; if (v <= 0n) throw new SdkError('bad_amount', 'the wallet holds none of this token'); if (path === '/v1/twap') x.total = v; else x.amount = v; } }
  }
  if (x.priceE18 === undefined && x.priceUsd === undefined && x.price !== undefined) x.priceE18 = toUnits(x.price, 18 + nat.decimals - await dec(), 'price');   // native per token -> native raw units per raw token unit x 1e18
  delete x[nat.key]; delete x.tokens; delete x.pct; delete x.price;
  for (const k of ['amount', 'total', 'priceE18'] as const) if (typeof x[k] === 'bigint') x[k] = x[k].toString();
  return x;
}

/** A shared SOL/USD source (one cache for many Traders). */
export function jupiterSolUsd(ttlMs = 30_000) {
  let cache: { price: number; at: number } | undefined, inflight: Promise<void> | undefined;
  return async () => {
    if (!cache || Date.now() - cache.at > ttlMs) inflight ??= fetchJupiterQuote({ inputMint: WSOL_MINT, outputMint: USDC, amount: 1_000_000_000n, slippageBps: 50, timeoutMs: 8000 })
      .then(q => { const v = Number(q.outAmount) / 1e6; if (v > 0) cache = { price: v, at: Date.now() }; }).catch(() => {}).finally(() => { inflight = undefined; });
    if (inflight) await inflight; return cache ?? null;
  };
}
function backendLedger(b: Backend): SpentLedger {
  let l: MemoryLedger; try { const s = b.read(); l = s ? MemoryLedger.restore(s) : new MemoryLedger(); } catch { l = new MemoryLedger(); }
  return { get: k => l.get(k), set: (k, v) => { l.set(k, v); b.write(l.snapshot()); } };
}

export async function createSolanaTrader(o: SolanaTraderOptions): Promise<SolanaTrader> {
  if (!o.state && !o.persistDir) throw new SdkError('config', 'createSolanaTrader needs persistDir or state: a real account must survive restarts');
  if (o.address !== undefined && !looksLikeMint(o.address)) throw new SdkError('bad_address', 'address must be a Solana address');
  if (!o.state) mkdirSync(o.persistDir!, { recursive: true });
  const state = o.state ?? ((n: string) => fileBackend(join(o.persistDir!, `${n}.json`))), log = o.log ?? (() => {});
  const privy = o.privy instanceof PrivyApi ? o.privy : new PrivyApi(o.privy), caps = o.caps ?? SOLANA_DEFAULT_CAPS, venues = o.venues ?? ['jupiter', 'pump'];
  let signable = new Map<string, string>(), why: string | undefined;
  if (!o.address) why = 'No wallet is linked to this account.';
  else { const d = await privy.delegation(o.address);   // throws when Privy is unreachable: nothing can be signed, so the caller should retry rather than run blind
    if (d.ok && (!o.walletId || d.walletId === o.walletId)) signable = new Map([[o.address, d.walletId]]); else why = d.ok ? 'The Privy wallet at this address is not the one that was linked. Link it again.' : d.why; }
  const rpc = new SolJsonRpc(o.rpcUrl), chain = new SolanaChain({ id: 'sol-main', wsol: WSOL_MINT, pools: [], pump: { mints: [] }, jupiter: { pairs: [] }, ...(o.priority === false ? {} : { priority: o.priority ?? {} }), ...(o.fees ? { fees: o.fees } : {}), submitter: mevSubmitter(o.mevProtection ?? false), mevDefault: mevOn(o.mevProtection) }, rpc, new PrivySolSigner(privy, signable));
  const policies = new Map<string, WalletPolicy>(), owners = new Map<string, string>();
  if (o.address) { owners.set(o.address, 'x'); policies.set(o.address, { userId: o.userId, chains: ['sol-main'], allowedVenues: venues, maxPerTx: { [NATIVE]: caps.maxTradeLamports }, dailyLimit: { [NATIVE]: caps.dailyCapLamports }, destinations: [], deviceSecret: randomBytes(16).toString('hex') }); }
  const engine = new Engine({ store: Store.open(state('engine')), chain, signer: new PolicySigner(owners, policies, backendLedger(state('ledger'))), router: new Router(chain), platformFeeBps: 0 });
  /** The engine charges the total of the recipients' bps (the chain splits it among them); refreshed before every trade and order pass. */
  const syncFees = () => { engine.d.platformFeeBps = (o.fees?.() ?? []).reduce((s, r) => s + Math.max(0, r.bps), 0); }; syncFees();
  const decs = new Map<string, number>(), added = new Set<string>();
  const decimals = async (mint: string) => { let d = decs.get(mint); if (d === undefined) { const r: any = await rpc.call('getAccountInfo', [mint, { encoding: 'jsonParsed' }]); d = Number(r?.value?.data?.parsed?.info?.decimals ?? 0); decs.set(mint, d); } return d; };
  // Selling a token the wallet holds spends that token and returns SOL to the same wallet, so it is not capped in SOL; buys are (see SOLANA_DEFAULT_CAPS).
  const prepare = async (mint: string) => { if (added.has(mint) || mint === NATIVE || mint === WSOL_MINT) return; if (!looksLikeMint(mint)) throw new SdkError('bad_token', 'token must be a Solana mint address');
    try { await chain.addToken(mint); } catch (e) { throw new SdkError('no_route', `this token cannot be traded: ${(e as Error).message}`, 'Check the mint address.'); }
    added.add(mint); for (const p of policies.values()) { p.maxPerTx[mint] = BIG; p.dailyLimit[mint] = BIG; } };
  const usd = o.solUsd ?? jupiterSolUsd();
  const trader: Trader = new Trader({ engine, chain, userId: o.userId, venues, state, usd: { quoteUsd: usd, quoteDecimals: 9, tokenDecimals: decimals, maxAgeMs: 120_000 },
    // every tick: fresh pool state for the triggers, and venues for tokens of orders restored from storage (nobody has asked for them since the restart)
    advanceChain: async () => { syncFees(); await chain.refresh('venues'); for (const x of trader.listOrders({ status: 'active' })) if (!added.has(x.token)) await prepare(x.token).catch(e => log(`${o.userId}: ${x.token}: ${(e as Error).message}`)); } });
  const active = signable.size > 0;
  const balance = async (mint: string) => { const r: any = await rpc.call('getTokenAccountsByOwner', [o.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]); return (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n); };
  const simple = (path: string, body: any) => simpleBody(path, body, { address: o.address, decimals, balance });
  // token safety before buys: the pump.fun bonding curve is liquidity, not a holder; a sell route and 1-SOL impact come from this chain's venues
  const best = (mint: string) => chain.venues().filter(v => venues.some(f => v.family === f || v.id === f));
  const safetyCheck = new TokenSafety(rpc, { cacheMs: 60_000,
    liquidityAccounts: m => [PROGRAMS.token, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].map(tp => pumpAddresses(m, m, tp).associatedBondingCurve),
    sellRoute: async m => { await prepare(m); return best(m).some(v => v.supports(m, NATIVE)); },
    buyImpactPct: async m => { await prepare(m); const q = best(m).filter(v => v.supports(NATIVE, m)).map(v => v.quote(NATIVE, m, 1_000_000_000n)); return q.length ? Math.min(...q.map(x => x.priceImpactBps)) / 100 : undefined; } });
  const mode = o.tokenSafety ?? 'block';
  const checkBuy = async (mint: string, allowRisky = false) => {
    if (mode === 'off' || mint === NATIVE || mint === WSOL_MINT) return undefined;
    const r = await safetyCheck.check(mint);
    if (r.verdict === 'block' && mode === 'block' && !allowRisky) throw new SdkError('unsafe_token', `this token was blocked by the safety check: ${r.risks.filter(x => x.level === 'block').map(x => x.message).join(' ')}`, 'Check the token. To buy it anyway, send allowRiskyToken: true with this trade, or set tokenSafety to warn.', 409);
    return r;
  };
  return { trader, chain, active, why, prepare, simple, sync: async () => { syncFees(); await chain.refresh('venues'); }, safety: (mint: string) => safetyCheck.check(mint), checkBuy, refuseIfInactive: () => { if (!active) throw new SdkError('wallet_not_active', why ?? 'no wallet can sign for this account', 'Link a Privy wallet that allows this server (signer + policy).', 409); } };
}

/** MEV protection options. `enabled` (default true when you pass an object) is the account default; a trade's own `mevProtection` wins either way. The block-engine
 *  settings apply whenever a trade goes privately, also when the default is off. */
export interface MevOptions { enabled?: boolean; maxTipLamports?: bigint; tipPercentile?: 25 | 50 | 75 | 95 | 99; jito?: JitoOptions }
export const mevOn = (m: boolean | MevOptions | undefined) => m === true || (typeof m === 'object' && m.enabled !== false);
/** The Jito submitter for a `mevProtection` setting (always built, so a single trade can ask for private sending). */
export function mevSubmitter(m: boolean | MevOptions): JitoSubmitter {
  const o: MevOptions = typeof m === 'object' ? m : {}; return new JitoSubmitter({ ...(o.jito ?? {}), tip: 'auto', ...(o.maxTipLamports !== undefined ? { maxTipLamports: o.maxTipLamports } : {}), ...(o.tipPercentile ? { tipPercentile: o.tipPercentile } : {}) });
}
