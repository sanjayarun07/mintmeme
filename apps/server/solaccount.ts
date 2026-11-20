/** REAL SOLANA ACCOUNTS for the execution server (MODE=solana-mainnet). Each API user links their own Privy wallet; the node that owns the user runs
 *  `createSolanaTrader` (packages/sdk/src/solana.ts) over the user's Redis state, so trades are signed by Privy within the policy the user agreed to and the SOL caps.
 *  No private key is ever held by a node.
 *
 *  Linking (routes added to the API, see linkRoutes):
 *   1. POST /v1/wallet/link/start {address}  -> a one-time message
 *   2. the user's Privy wallet signs it; POST /v1/wallet/link/finish {address, signature}: proves this API user controls the wallet, then the node asks Privy whether the wallet
 *      carries this server's signer with the policy. Only then is {address, walletId} saved under the user in Redis (through the user's lease, fail-closed).
 *   GET /v1/wallet shows the link; DELETE /v1/wallet removes it. Removing the signer in Privy also stops signing at once (Privy refuses; nothing is sent).
 *  Every claim of the user by a node asks Privy again before anything is signed, so a revoked wallet is never traded after a failover or restart. */
import { stocksEnabled, stocksForUser } from './chains.ts';
import { randomBytes } from 'node:crypto';
import type { Backend } from '../../packages/core/src/index.ts';
import { PrivyApi, verifySignature, looksLikeMint, SolJsonRpc, STOCKS_SOLANA, STOCK_LIST_META, stockByMint, findStock, underlying, readStockStates, rawForShares, sharesForRaw, perTokenPrice, checkFillPrice, JupiterStockPrices, fetchRfqQuote } from '../../packages/sol/src/index.ts';
const WSOL = 'So11111111111111111111111111111111111111112';
import { NATIVE } from '../../packages/core/src/index.ts';
import type { PrivyConfig } from '../../packages/sol/src/index.ts';
import { createSolanaTrader, jupiterSolUsd, toUnits, SOLANA_DEFAULT_CAPS } from '../../packages/sdk/src/solana.ts';
import type { JitoOptions, FeeRecipient } from '../../packages/sol/src/index.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { Account } from './node.ts';
import { solCopies } from './solcopy.ts';
import type { Route } from '../api/server.ts';

export interface SolLink { address: string; walletId: string; linkedAt: number }
export const readLink = (b: Backend): SolLink | undefined => { try { const j = JSON.parse(b.read() ?? ''); return j && looksLikeMint(j.address) && typeof j.walletId === 'string' ? j : undefined; } catch { return undefined; } };
type Status = { address?: string; active: boolean; why?: string };
/** Per-user trading settings, in the user's Redis state. MEV protection is off by default: each protected trade pays a Jito tip. */
export interface UserSettings { mevProtection: boolean; maxTipSol: string; tokenSafety: 'block' | 'warn' | 'off' }
export const DEFAULT_SETTINGS: UserSettings = { mevProtection: false, maxTipSol: '0.0001', tokenSafety: 'block' };
/** Routes that BUY a token (checked by token safety before anything is signed). */
const isBuy = (path: string, b: any) => path === '/v1/trades/buy' || path === '/v1/orders/limit-buy' || path === '/v1/bulk/buy' || (path === '/v1/twap' && b?.side === 'buy');
const MAX_TIP_SOL_CEILING = 1_000_000n;   // 0.001 SOL: a tip above this is refused, whatever the user asks
export const readSettings = (b: Backend): UserSettings => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(b.read() ?? '{}') }; } catch { return { ...DEFAULT_SETTINGS }; } };
/** Routes that spend or sell from the wallet (refused while the wallet is not active). */
const TRADE_PATHS = /^\/v1\/(trades\/(buy|sell)$|orders\/[a-z-]+$|twap$|bulk\/(buy|sell)$)/;

/** The share-price check for a JupiterZ (RFQ) fill, on the maker's ACTUAL output: a stock bought or sold through RFQ must fill near the underlying share price,
 *  exactly like a normal route (checkFillPrice). Returns the refusal reason, or undefined to allow. Fails closed: with no SOL price or no share price, RFQ is not
 *  used (the normal route, checked when the request came in, runs instead). A trade that is not a registered stock is not affected. */
export function rfqFillCheck(d: { solUsd: () => Promise<{ price: number; at: number } | null>; prices: JupiterStockPrices; stockState: (mint: string) => Promise<{ decimals: number; multiplier: string }>; maxDeviationPct: number; /** Names the route in a refusal (default RFQ). */ label?: string }) {
  const label = d.label ?? 'RFQ';
  return async (tx: { tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint }, outAmount: bigint): Promise<string | undefined> => {
    const buy = stockByMint(tx.tokenOut), sell = buy ? undefined : stockByMint(tx.tokenIn), stock = buy ?? sell; if (!stock) return undefined;
    if ((buy ? tx.tokenIn : tx.tokenOut) !== NATIVE) return `the ${label} share-price check covers SOL trades only`;
    const [st, sol, ref] = await Promise.all([d.stockState(stock.mint), d.solUsd(), d.prices.get([stock.mint]).then(m => m.get(stock.mint)?.stockPrice ?? null)]);
    if (!sol) return `no SOL price right now, so the ${label} fill cannot be checked against the share price`;
    if (!ref) return `no share price for ${underlying(stock)} right now, so the ${label} fill cannot be checked`;
    const r = checkFillPrice({ side: buy ? 'buy' : 'sell', solLamports: buy ? tx.amountIn : outAmount, tokensRaw: buy ? outAmount : tx.amountIn, decimals: st.decimals, multiplier: st.multiplier, solUsd: sol.price, referenceUsd: ref, maxDeviationPct: d.maxDeviationPct });
    return r.ok ? undefined : `${label} ${r.why}`;
  };
}

/** The account factory. A user with no linked (or no longer delegated) wallet still gets an account: reads work, every call that names a wallet is refused with the reason. */
export function solanaAccounts(c: { rpcUrl: string; /** Another Solana node for rate-limited calls (Alchemy behind Helius). */ rpcFallbackUrl?: string; privy: PrivyConfig; venues?: string[]; /** Who gets fees on this user's trades (fee sharing). */ fees?: (userId: string) => FeeRecipient[]; /** Block-engine options for users who turn MEV protection on (region URL, uuid; tests pass a stand-in). */ jito?: JitoOptions; caps?: { maxTradeLamports: bigint; dailyCapLamports: bigint }; solUsd?: () => Promise<{ price: number; at: number } | null>; log?: (m: string) => void;
  /** Tokenized stocks (docs/XSTOCKS.md). `enabled` (default: env STOCKS_ENABLED=1, else OFF) lets users BUY registered stocks; turn it on only behind your own eligibility checks
   *  (no issuer offers them to US persons). Selling what a wallet already holds always works. `maxDeviationPct` (default 3): a buy or sell whose route is that much worse than the
   *  underlying share price is refused. `prices`/`rpc` are for tests. */
  /** Jupiter API key (optional): sent on route building, quotes, SOL/USD and share prices, so users are not held to the keyless rate limit. */
  jupiterApiKey?: string;
  /** JupiterZ RFQ fills for large orders (off when absent; env JUPITERZ=on in main.ts). A stock fill is still held to the share-price check (rfqFillCheck). */
  jupiterz?: { minLamports: bigint; marginBps: number };
  stocks?: { enabled?: boolean; maxDeviationPct?: number; prices?: JupiterStockPrices; rpc?: { call<T = any>(m: string, p?: unknown[]): Promise<T> } } }) {
  const privy = new PrivyApi(c.privy), solUsd = c.solUsd ?? jupiterSolUsd(30_000, c.jupiterApiKey), status = new Map<string, Status>(); const live = new Map<string, Awaited<ReturnType<typeof createSolanaTrader>>>();
  const stocksOn = c.stocks?.enabled ?? stocksEnabled('solana'), stockRpc = c.stocks?.rpc ?? new SolJsonRpc(c.rpcUrl, fetch, c.rpcFallbackUrl), prices = c.stocks?.prices ?? new JupiterStockPrices({ apiKey: c.jupiterApiKey }), maxDev = c.stocks?.maxDeviationPct ?? 3;
  const leaderRpc = new SolJsonRpc(c.rpcUrl);   // copy trading reads leader wallets through the same node
  const stockState = async (mint: string) => { const st = (await readStockStates(stockRpc, [mint])).get(mint); if (!st) throw new SdkError('no_route', `stock mint ${mint} could not be read`, 'Retry shortly.', 503); return st; };
  /** The route's price per share against the underlying share price, at `amount` (lamports for a buy, raw tokens for a sell). */
  const fill = async (s: Awaited<ReturnType<typeof createSolanaTrader>>, mint: string, side: 'buy' | 'sell', amount: bigint) => {
    const st = await stockState(mint), tin = side === 'buy' ? NATIVE : mint, tout = side === 'buy' ? mint : NATIVE;
    const qs = s.chain.venues().filter(v => v.status === 'active' && v.supports(tin, tout)).map(v => { try { return v.quote(tin, tout, amount).amountOut; } catch { return 0n; } });
    const out = qs.length ? qs.reduce((a, b) => (b > a ? b : a)) : 0n; if (out <= 0n) return { st, check: undefined };
    const sol = await solUsd(), ref = (await prices.get([mint])).get(mint)?.stockPrice ?? null; if (!sol) return { st, check: undefined };
    return { st, check: checkFillPrice({ side, solLamports: side === 'buy' ? amount : out, tokensRaw: side === 'buy' ? out : amount, decimals: st.decimals, multiplier: st.multiplier, solUsd: sol.price, referenceUsd: ref, maxDeviationPct: maxDev }) };
  };
  /** A stock trade must fill near the share price: refuses broken or thin routes (Ondo on Solana filled at about 3x the share price) that Jupiter's impact figure does not show. */
  /** A stock whose pools are too thin (Ondo on Solana) may still trade at JupiterZ sizes: what makers quote now, held to the same share-price check. Undefined when
   *  JupiterZ is off, the trade is below its threshold or no maker quotes; else the check. The trade itself re-asks, gates and simulates (solchain.ts tryRfq), and if
   *  RFQ is not used then, the normal route is checked again on its real output (checkFallback below). */
  const rfqCheck = async (mint: string, side: 'buy' | 'sell', amount: bigint) => {
    const z = c.jupiterz; if (!z || (side === 'buy' && amount < z.minLamports)) return undefined;
    const q = await fetchRfqQuote({ inputMint: side === 'buy' ? WSOL : mint, outputMint: side === 'buy' ? mint : WSOL, amount, apiKey: c.jupiterApiKey }).catch(() => ({ none: 'no answer' }));
    if ('none' in q || (side === 'sell' && q.outAmount < z.minLamports)) return undefined;
    const [st, sol, ref] = await Promise.all([stockState(mint), solUsd(), prices.get([mint]).then(m => m.get(mint)?.stockPrice ?? null)]); if (!sol) return undefined;
    return checkFillPrice({ side, solLamports: side === 'buy' ? amount : q.outAmount, tokensRaw: side === 'buy' ? q.outAmount : amount, decimals: st.decimals, multiplier: st.multiplier, solUsd: sol.price, referenceUsd: ref, maxDeviationPct: maxDev });
  };
  const stockPriceCheck = async (s: Awaited<ReturnType<typeof createSolanaTrader>>, stock: NonNullable<ReturnType<typeof stockByMint>>, side: 'buy' | 'sell', amount: bigint) => {
    const { check: pool } = await fill(s, stock.mint, side, amount);
    const rfq = !pool?.ok || !pool.referenceUsd ? await rfqCheck(stock.mint, side, amount) : undefined;
    if (rfq?.ok && rfq.referenceUsd) return;   // makers fill it near the share price
    const check = pool;
    const mm = c.jupiterz && stock.market.rfq ? ` Market makers (JupiterZ) quote ${stock.symbol} from ${Number(c.jupiterz.minLamports) / 1e9} SOL.` : '';
    if (!check) throw new SdkError('no_route', `no route prices ${stock.symbol} right now`, `Retry shortly.${mm}`, 503);
    if (!check.referenceUsd) throw new SdkError('no_reference_price', `the share price of ${underlying(stock)} is not available right now, so the fill cannot be checked`, 'Retry shortly, or send allowRiskyToken: true to trade without the check.', 503);
    if (!check.ok) throw new SdkError('bad_price', check.why!, `Try another issuer of the same stock (GET /v1/stocks), a ${mm ? 'larger or ' : ''}smaller amount, or send allowRiskyToken: true to trade anyway.${mm}`, 409);
  };
  const stocksOff = () => new SdkError('stocks_disabled', 'buying tokenized stocks is not enabled on this server', 'The operator enables it (STOCKS_ENABLED=1) after checking that its users may hold them: no issuer offers them to US persons.', 403);
  const make = async (userId: string, state: (name: string) => Backend): Promise<Account> => {
    const stocksOk = stocksOn && stocksForUser(userId);   // a sign-up account (p-...) buys stocks only with SIGNUP_STOCKS_ENABLED=1
    const link = readLink(state('solwallet'));
    const set = readSettings(state('settings')), mev = { enabled: set.mevProtection, maxTipLamports: toUnits(set.maxTipSol, 9, 'maxTipSol'), jito: c.jito };
    // JupiterZ: a stock sell is sized by the maker's output (thin pools give a far too low minOut); when RFQ is not used, a stock trade's normal route is checked on its
    // simulated output before signing, so a trade let in by a maker's quote never falls back to a thin pool. Mints this user traded with allowRiskyToken skip that check
    // (kept in memory: after a restart the check applies again, the safe side).
    const risky = new Set<string>(), fallbackFill = rfqFillCheck({ solUsd, prices, stockState, maxDeviationPct: maxDev, label: 'the normal route:' });
    const jupiterz = c.jupiterz ? { ...c.jupiterz, checkFill: rfqFillCheck({ solUsd, prices, stockState, maxDeviationPct: maxDev }),
      sizeByQuote: (tx: { tokenIn: string; tokenOut: string }) => tx.tokenOut === NATIVE && !!stockByMint(tx.tokenIn),
      checkFallback: async (tx: { tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint }, out: bigint) => {
        const st = stockByMint(tx.tokenOut) ?? stockByMint(tx.tokenIn); if (!st || risky.has(st.mint) || (tx.tokenIn !== NATIVE && tx.tokenOut !== NATIVE)) return undefined;
        return fallbackFill(tx, out);
      } } : undefined;
    const s = await createSolanaTrader({ userId, jupiterApiKey: c.jupiterApiKey, jupiterz, address: link?.address, walletId: link?.walletId, rpcUrl: c.rpcUrl, rpcFallbackUrl: c.rpcFallbackUrl, privy, state, mevProtection: mev, tokenSafety: set.tokenSafety, fees: c.fees ? () => c.fees!(userId) : undefined, caps: c.caps, venues: c.venues, solUsd, log: c.log });
    live.set(userId, s);
    status.set(userId, { address: link?.address, active: s.active, why: s.active ? undefined : (link ? s.why : 'No wallet is linked. Link your Privy wallet: POST /v1/wallet/link/start, then /v1/wallet/link/finish.') });
    // copy trading: a copied buy passes the same checks as a manual one (token safety, and for a stock the operator switch and the fill price), never with allowRiskyToken
    const copies = solCopies({ trader: s.trader, follower: link?.address, chainId: s.chain.id, rpc: leaderRpc, state, caps: c.caps ?? SOLANA_DEFAULT_CAPS, active: () => s.active, prepare: s.prepare, log: c.log,
      gate: async (mint, lamports) => { const st = stockByMint(mint); if (st && !stocksOk) throw stocksOff(); await s.checkBuy(mint, false); if (st) { await s.sync(); await stockPriceCheck(s, st, 'buy', lamports); } } });
    copies.restore();   // before the node calls trader.resume(): restored runners finish their in-flight copies
    return { trader: s.trader, copies, prepare: async (raw: any, path: string) => {
      if (path === '/v1/copies' || path.startsWith('/v1/copies/')) return raw;   // copy bodies are validated by solcopy.ts (plain units of their own)
      const trades = TRADE_PATHS.test(path); if (trades) s.refuseIfInactive();
      // a stock may be named by its ticker (TSLAx, TSLAon, TSLA): replaced by its mint
      if (raw && typeof raw === 'object') { const t = raw.token ?? raw.mint ?? raw.stock; if (typeof t === 'string' && !looksLikeMint(t)) { const a = findStock(t); if (a) { raw = { ...raw, token: a.mint }; delete raw.mint; } } delete raw?.stock; }
      const tok = raw?.token ?? raw?.mint; if (typeof tok === 'string') await s.prepare(tok);   // learn the token first: plain units need its decimals
      const stock = typeof tok === 'string' ? stockByMint(tok) : undefined;
      if (stock && raw?.allowRiskyToken === true) risky.add(stock.mint);
      if (stock && raw.perShare === true) raw = await perShareBody(raw, await stockState(stock.mint), isBuy(path, raw));
      const body = await s.simple(path, raw);
      if (trades || typeof tok === 'string') await s.sync();   // the chain's clock (deadlines) and pool state (quotes) as of now, not as of the last tick
      if (stock && isBuy(path, body) && !stocksOk) throw stocksOff();
      if (isBuy(path, body) && typeof body?.token === 'string') await s.checkBuy(body.token, raw?.allowRiskyToken === true);   // before anything is signed
      // a stock route must fill near the share price: refuses broken or thin routes (Ondo on Solana filled at about 3x the share price) that Jupiter's impact figure does not show
      const side = isBuy(path, body) ? 'buy' : path === '/v1/trades/sell' || path === '/v1/bulk/sell' ? 'sell' : undefined, amt = body?.amount ?? body?.total;
      if (stock && side && raw?.allowRiskyToken !== true && (typeof amt === 'string' || side === 'buy')) await stockPriceCheck(s, stock, side, typeof amt === 'string' && /^\d+$/.test(amt) && BigInt(amt) > 0n ? BigInt(amt) : 1_000_000_000n);
      return body;
    } };
  };
  /** GET /v1/stocks/:symbol: the stock's live state (multiplier, pause), the share price, what a 1-SOL buy pays per share on the best route now, and the user's holding in shares. */
  const stock = async (u: string, sym: string) => {
    const a = findStock(sym); if (!a) throw new SdkError('not_found', `${sym} is not a registered stock`, 'GET /v1/stocks lists them.', 404);
    const s = live.get(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503);
    await s.prepare(a.mint); await s.sync(); const { st, check } = await fill(s, a.mint, 'buy', 1_000_000_000n), addr = status.get(u)?.address;
    let held: { tokens: string; shares: string } | null = null;
    if (addr) { const r: any = await stockRpc.call('getTokenAccountsByOwner', [addr, { mint: a.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]); const raw = ((r?.value ?? []) as any[]).reduce((x, y) => x + BigInt(y.account.data.parsed.info.tokenAmount.amount), 0n);
      held = { tokens: sharesForRaw(raw, '1', st.decimals, st.decimals), shares: sharesForRaw(raw, st.multiplier, st.decimals) }; }
    return { symbol: a.symbol, underlying: underlying(a), issuer: a.issuer, mint: a.mint, decimals: st.decimals, multiplier: st.multiplier, nextMultiplier: st.next ?? null, paused: st.paused, buyEnabled: stocksOn,
      sharePriceUsd: check?.referenceUsd ?? null, routePerShareUsd: check ? Math.round(check.perShareUsd * 100) / 100 : null, deviationPct: check?.deviationPct ?? null, priceOk: check ? check.ok && check.referenceUsd !== null : false, held };
  };
  return { make, stock, stocksEnabled: () => stocksOn, status: (u: string) => status.get(u), privy, safety: async (u: string, mint: string) => { const s = live.get(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503); await s.prepare(mint); return s.safety(mint); } };
}

/** `perShare: true` on a stock order: `shares` (sells only) becomes raw `amount`, and `priceUsd`, `tpUsd`, `slUsd` (USD per share) become per-token prices (x multiplier),
 *  `price` (SOL per share) too. A buy's `amount` is the SOL to spend, so `shares` on a buy is refused: size buys with `sol`. */
async function perShareBody(raw: any, st: { multiplier: string; decimals: number }, buying: boolean) {
  const b = { ...raw }; delete b.perShare;
  if (b.shares !== undefined && buying) throw new SdkError('bad_request', 'shares sizes a sell; a buy is sized in SOL', 'Send sol (the SOL to spend) for a buy; use shares to sell.');
  if (b.shares !== undefined) { if (b.amount !== undefined || b.tokens !== undefined) throw new SdkError('bad_request', 'send shares, or tokens/amount, not both'); const v = rawForShares(String(b.shares), st.multiplier, st.decimals); if (v <= 0n) throw new SdkError('bad_amount', 'shares is too small'); b.amount = v.toString(); delete b.shares; }
  for (const k of ['priceUsd', 'tpUsd', 'slUsd', 'price']) if (b[k] !== undefined) { try { b[k] = perTokenPrice(String(b[k]), st.multiplier); } catch (e) { throw new SdkError('bad_number', `${k}: ${(e as Error).message}`); } }
  return b;
}

/** The wallet-linking routes. `state(user)` gives the owner node's durable state for that user (writes go through the user's lease); `reload(user)` rebuilds its account. */
export function linkRoutes(o: { privy: PrivyApi; safety?: (userId: string, mint: string) => Promise<unknown>; stock?: (userId: string, symbol: string) => Promise<unknown>; stocksEnabled?: () => boolean; state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void>; status: (userId: string) => Status | undefined; now?: () => number }): Route[] {
  const now = o.now ?? Date.now, pending = new Map<string, { address: string; message: string; exp: number }>();
  const st = (u: string) => { const s = o.state(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503); return s; };
  const view = (u: string) => { const l = readLink(st(u)('solwallet')), s = o.status(u); return { linked: !!l, address: l?.address ?? null, active: !!s?.active, why: s?.active ? null : s?.why ?? null }; };
  return [
    { method: 'GET', path: '/v1/wallet', scope: 'read', summary: 'Your linked Privy wallet and whether this server may trade it now', run: c => view(c.userId) },
    { method: 'POST', path: '/v1/wallet/link/start', scope: 'trade', summary: 'Start linking your Privy Solana wallet: returns a one-time message for the wallet to sign (moves no funds)', body: 'address',
      run: c => { const address = String(c.body?.address ?? '').trim(); if (!looksLikeMint(address)) throw new SdkError('bad_address', 'address must be a Solana address');
        const message = `memedesk: link this wallet to account ${c.userId}.\n\nAddress: ${address}\nNonce: ${randomBytes(16).toString('hex')}\nIssued: ${new Date(now()).toISOString()}\n\nSigning this moves no funds.`;
        pending.set(c.userId, { address, message, exp: now() + 5 * 60_000 }); return { message }; } },
    { method: 'POST', path: '/v1/wallet/link/finish', scope: 'trade', summary: 'Finish linking with the wallet\'s signature of that message (base64). The wallet must already allow this server in Privy (signer + policy)', body: 'address, signature (base64)',
      run: async c => {
        const address = String(c.body?.address ?? '').trim(), p = pending.get(c.userId); pending.delete(c.userId);
        if (!p || p.exp < now() || p.address !== address) throw new SdkError('link_expired', 'no link in progress for this address, or it expired', 'Call /v1/wallet/link/start again.', 410);
        const sig = Buffer.from(String(c.body?.signature ?? ''), 'base64');
        if (sig.length !== 64 || !verifySignature(address, new TextEncoder().encode(p.message), new Uint8Array(sig))) throw new SdkError('bad_signature', 'the signature does not match this address and message', undefined, 401);
        let d; try { d = await o.privy.delegation(address); } catch (e) { throw new SdkError('privy_unavailable', (e as Error).message, 'Retry shortly.', 503); }
        if (!d.ok) throw new SdkError('not_delegated', d.why, 'In your app, call Privy useSigners().addSigners({ address, signers: [{ signerId, policyIds: [policyId] }] }) first.', 409);
        st(c.userId)('solwallet').write(JSON.stringify({ address, walletId: d.walletId, linkedAt: now() } satisfies SolLink));
        await o.reload(c.userId); return view(c.userId);
      } },
    { method: 'GET', path: '/v1/tokens/:mint/safety', scope: 'read', summary: 'Token safety report: freeze or mint authority, Token-2022 extensions that can stop a sell or take tokens, holder concentration, a sell route, 1-SOL impact',
      run: c => { if (!o.safety) throw new SdkError('not_configured', 'no safety check on this server', undefined, 501); return o.safety(c.userId, c.params.mint); } },
    { method: 'GET', path: '/v1/stocks', scope: 'read', summary: 'Tokenized stocks on Solana (xStocks, Ondo, Backpack), from the issuers\' lists verified on chain. Default: the ones that traded near the share price at the last registry run, most liquid first (query: all=true for every registered mint, q= ticker or underlying, issuer=, limit, offset). Trade by ticker (token: "TSLAx"); perShare: true takes shares and USD per share',
      run: c => {
        const all = c.query?.get('all') === 'true', q = c.query?.get('q')?.toLowerCase(), iss = c.query?.get('issuer')?.toLowerCase();
        const limit = Math.min(Math.max(Number(c.query?.get('limit') ?? 200) || 200, 1), 1000), offset = Math.max(Number(c.query?.get('offset') ?? 0) || 0, 0);
        const hit = STOCKS_SOLANA.filter(a => (all || a.market.tradable) && (!q || a.symbol.toLowerCase() === q || a.underlying.toLowerCase() === q || a.symbol.toLowerCase().startsWith(q)) && (!iss || a.issuer.toLowerCase().includes(iss)))
          .sort((x, y) => Number(y.market.tradable) - Number(x.market.tradable) || (y.market.liquidityUsd ?? -1) - (x.market.liquidityUsd ?? -1) || x.symbol.localeCompare(y.symbol));
        return { buyEnabled: o.stocksEnabled?.() ?? false, total: hit.length, offset, registry: { generatedAt: STOCK_LIST_META.generatedAt, verified: STOCK_LIST_META.verified, tradable: STOCK_LIST_META.tradable },
          stocks: hit.slice(offset, offset + limit).map(a => ({ symbol: a.symbol, underlying: underlying(a), issuer: a.issuer, mint: a.mint, decimals: a.decimals, liquidityUsd: a.market.liquidityUsd, routeDeviationPct: a.market.deviationPct, tradable: a.market.tradable, rfqOnly: a.market.rfq && !a.market.pool })),
          note: 'Not for US persons or other restricted jurisdictions (issuer terms). "tradable" is the last registry run; every trade is re-checked against the share price. One token can be more than one share after dividends: GET /v1/stocks/:symbol shows the multiplier.' };
      } },
    { method: 'GET', path: '/v1/stocks/:symbol', scope: 'read', summary: 'One stock: multiplier (shares per token), issuer pause, the share price, what the best route pays per share now, and your holding in shares',
      run: c => { if (!o.stock) throw new SdkError('not_configured', 'no stock lookup on this server', undefined, 501); return o.stock(c.userId, c.params.symbol); } },
    { method: 'GET', path: '/v1/settings', scope: 'read', summary: 'Your trading settings (MEV protection)', run: c => readSettings(st(c.userId)('settings')) },
    { method: 'PATCH', path: '/v1/settings', scope: 'trade', summary: 'Change trading settings. mevProtection: send trades privately through Jito with a tip (off by default). maxTipSol: the most one tip may cost (default 0.0001, at most 0.001). tokenSafety: block (default), warn or off for buys', body: 'mevProtection? (boolean), maxTipSol? (decimal string), tokenSafety? (block|warn|off)',
      run: async c => {
        const cur = readSettings(st(c.userId)('settings')), b = c.body ?? {}, next: UserSettings = { ...cur };
        if (b.mevProtection !== undefined) { if (typeof b.mevProtection !== 'boolean') throw new SdkError('bad_request', 'mevProtection must be true or false'); next.mevProtection = b.mevProtection; }
        if (b.tokenSafety !== undefined) { if (!['block', 'warn', 'off'].includes(b.tokenSafety)) throw new SdkError('bad_request', 'tokenSafety must be block, warn or off'); next.tokenSafety = b.tokenSafety; }
        if (b.maxTipSol !== undefined) { const v = toUnits(b.maxTipSol, 9, 'maxTipSol'); if (v > MAX_TIP_SOL_CEILING || v < 1_000n) throw new SdkError('bad_amount', 'maxTipSol must be between 0.000001 and 0.001'); next.maxTipSol = String(b.maxTipSol); }
        st(c.userId)('settings').write(JSON.stringify(next)); await o.reload(c.userId); return next;   // the account is rebuilt with the new sender: the next trade uses it
      } },
    { method: 'DELETE', path: '/v1/wallet', scope: 'trade', summary: 'Unlink the wallet: this server stops trading it (orders stay saved and are refused until a wallet is linked)',
      run: async c => { st(c.userId)('solwallet').write('{}'); await o.reload(c.userId); return view(c.userId); } },
  ];
}
