/** REAL BASE ACCOUNTS for the execution server (MODE=base-mainnet). The Base twin of solaccount.ts: each API user links their own Privy Ethereum wallet; the node that
 *  owns the user runs `createBaseTrader` (packages/sdk/src/base.ts) over the user's Redis state. Trades are signed by Privy within the Base policy the user agreed to and
 *  the ETH caps; every signed transaction is checked field by field and by its recovered signer before it is sent. No private key is ever held by a node.
 *
 *  Linking: POST /v1/wallet/link/start {address} -> a one-time message; the wallet signs it with personal_sign; POST /v1/wallet/link/finish {address, signature (0x, 65
 *  bytes)}: the signer is recovered from the signature (proves this API user controls the wallet), then Privy is asked whether the wallet carries this server's signer
 *  with the Base policy. Only then is {address, walletId} saved under the user. GET /v1/wallet shows the link; DELETE /v1/wallet removes it. */
import { stocksEnabled } from './chains.ts';
import { randomBytes } from 'node:crypto';
import type { Backend } from '../../packages/core/src/index.ts';
import { PrivyApi } from '../../packages/sol/src/index.ts';
import type { PrivyConfig } from '../../packages/sol/src/index.ts';
import { isAddress, personalSigner, JsonRpcError } from '../../packages/evm/src/index.ts';
import type { RpcLike } from '../../packages/evm/src/index.ts';
import { createBaseTrader, baseEthUsd, EvmJsonRpc, EVM_NETWORKS, BASE_DEFAULT_CAPS } from '../../packages/sdk/src/base.ts';
import { evmCopies } from './evmcopy.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import type { Account } from './node.ts';
import type { Route } from '../api/server.ts';
import { NATIVE } from '../../packages/core/src/index.ts';
import { STOCKS_SOLANA, underlying, JupiterStockPrices, checkFillPrice } from '../../packages/sol/src/index.ts';
import { BASE_STOCKS } from '../../packages/evm/src/basestocks.ts';
import { ROBINHOOD_STOCKS, UI_MULTIPLIER_SELECTOR } from '../../packages/evm/src/robinhoodstocks.ts';

/* ---------------- Tokenized stocks on EVM chains: ticker lookup, the operator switch, the share-price check (the EVM twin of solaccount.ts) ---------------- */
export type EvmStock = { symbol: string; address: string; ticker: string };
/** A Coinbase stock on Base by address, symbol (NVDAc) or underlying ticker (NVDA), case-insensitive; undefined for anything else. */
export function findBaseStock(t: string): EvmStock | undefined {
  const k = t.trim().toLowerCase(), e = Object.entries(BASE_STOCKS).find(([s, a]) => a.toLowerCase() === k || s.toLowerCase() === k || s.slice(0, -1).toLowerCase() === k);
  return e ? { symbol: e[0], address: e[1].toLowerCase(), ticker: e[0].slice(0, -1) } : undefined;
}
/** A Robinhood stock token on Robinhood Chain by address or ticker (its symbol: TSLA), case-insensitive; undefined for anything else. */
export function findRobinhoodStock(t: string): EvmStock | undefined {
  const k = t.trim().toLowerCase(), e = Object.entries(ROBINHOOD_STOCKS).find(([s, a]) => a.toLowerCase() === k || s.toLowerCase() === k);
  return e ? { symbol: e[0], address: e[1].toLowerCase(), ticker: e[0] } : undefined;
}
/** The stock lookup of an EVM network, or undefined where it lists no stocks (BNB: its xStocks/Ondo tokens are not wired here). */
export const STOCK_FINDERS: Record<string, (t: string) => EvmStock | undefined> = { base: findBaseStock, robinhood: findRobinhoodStock };
const isBuy = (path: string, b: any) => path === '/v1/trades/buy' || path === '/v1/orders/limit-buy' || path === '/v1/bulk/buy' || (path === '/v1/twap' && b?.side === 'buy');
const isSell = (path: string) => path === '/v1/trades/sell' || path === '/v1/bulk/sell';
/** The reference share price: Jupiter's stockData.price for a Solana stock of the same underlying (NVDAc -> NVDA -> NVDAx; Robinhood TSLA -> TSLAx). A token is
 *  uiMultiplier()/1e18 shares, read on chain, on both chains: Coinbase's B20 tokens have it too (NVDAc 1.000537 on 2026-11-19; it was first taken as 1). 198 of the 203 Robinhood tickers have a Solana reference (not ABCL, CLOV, NAVN, RUN, XNDU: those refuse
 *  with no_reference_price unless allowRiskyToken). */
const refMint = (ticker: string) => STOCKS_SOLANA.find(a => underlying(a) === ticker)?.mint;

/** The state name of a chain's wallet link: Base keeps `basewallet` (what single-chain Base servers wrote); another EVM chain uses `<chain>wallet`. */
export const walletState = (chain: string) => `${chain}wallet`;
export interface BaseLink { address: string; walletId: string; linkedAt: number }
export const readBaseLink = (b: Backend): BaseLink | undefined => { try { const j = JSON.parse(b.read() ?? ''); return j && isAddress(j.address) && typeof j.walletId === 'string' ? j : undefined; } catch { return undefined; } };
type Status = { address?: string; active: boolean; why?: string };
/** Routes that spend or sell from the wallet (refused while the wallet is not active). */
const TRADE_PATHS = /^\/v1\/(trades\/(buy|sell)$|orders\/[a-z-]+$|twap$|bulk\/(buy|sell)$)/;

/** The account factory. A user with no linked (or no longer delegated) wallet still gets an account: reads work, every trade is refused with the reason. */
export function baseAccounts(c: { rpcUrl: string; privy: PrivyConfig; caps?: { maxTradeWei: bigint; dailyCapWei: bigint }; rpc?: RpcLike; log?: (m: string) => void;
  /** Relay routes for tokens with no Uniswap V2 WETH pool (Coinbase stocks, V3/V4/Aerodrome-only tokens), gated and simulated before signing. Default on; false turns it
   *  off. The Privy Base policy must allow Relay's router and approval proxy (README → Base policy rules). */
  relay?: false | { apiKey?: string; client?: import('../../packages/evm/src/index.ts').RelayClient };
  /** 'kyberswap' routes those tokens through KyberSwap instead of Relay (BASE_AGGREGATOR). The Privy Base policy must allow KyberSwap's router (README → Base policy rules). */
  aggregator?: 'relay' | 'kyberswap'; kyber?: { clientId?: string; client?: import('../../packages/evm/src/index.ts').KyberClient };
  /** Which EVM network (packages/sdk/src/base.ts EVM_NETWORKS: base, bnb, robinhood). Default base. */
  network?: string;
  /** Coinbase stocks on Base (packages/evm/src/basestocks.ts). `enabled` (default: env STOCKS_ENABLED=1, else OFF) lets users BUY them: no issuer offers tokenized stocks to
   *  US persons, so turn it on only behind your own eligibility checks. Sells always work. A stock trade must fill within `maxDeviationPct` (default 3) of the share price. */
  stocks?: { enabled?: boolean; maxDeviationPct?: number; prices?: JupiterStockPrices; jupiterApiKey?: string } }) {
  const net = EVM_NETWORKS[c.network ?? 'base']; if (!net) throw new Error(`unknown EVM network ${c.network}: one of ${Object.keys(EVM_NETWORKS).join(', ')}`);
  const privy = new PrivyApi({ ...c.privy, chainType: 'ethereum' }), rpc = c.rpc ?? new EvmJsonRpc(c.rpcUrl), ethUsd = baseEthUsd(rpc, 30_000, net), status = new Map<string, Status>();
  const findStock = STOCK_FINDERS[net.id], stocksHere = !!findStock, stocksOn = c.stocks?.enabled ?? stocksEnabled(net.id), maxDev = c.stocks?.maxDeviationPct ?? 3;
  const prices = c.stocks?.prices ?? new JupiterStockPrices({ apiKey: c.stocks?.jupiterApiKey ?? process.env.JUPITER_API_KEY?.trim() });
  const stocksOff = () => new SdkError('stocks_disabled', 'buying tokenized stocks is not enabled on this server', 'The operator enables it (STOCKS_ENABLED=1) after checking that its users may hold them: no issuer offers them to US persons.', 403);
  /** A stock trade must fill near the share price: the best venue's quote at this size (wei in for a buy, raw tokens in for a sell) against the underlying share price. */
  /** Shares per token as a decimal string: uiMultiplier()/1e18, read on chain and kept a minute. Robinhood's tokens all have it; so do Coinbase's B20 tokens on Base
   *  (NVDAc 1.000537 on 2026-11-19, not 1 as first assumed). A Base token that reverts the call (the node answered: it has no multiplier) counts 1; any other failure,
   *  and any failure on Robinhood Chain, is null (no price check possible). */
  const mults = new Map<string, { v: string; at: number }>();
  const multiplier = async (stock: EvmStock): Promise<string | null> => {
    const hit = mults.get(stock.address); if (hit && Date.now() - hit.at < 60_000) return hit.v;
    try {
      const r = await rpc.call<string>('eth_call', [{ to: stock.address, data: UI_MULTIPLIER_SELECTOR }, 'latest']), m = BigInt(r);
      if (m <= 0n || m > 10n ** 24n) return null;   // zero, or above a million shares per token: not a value to price with
      const v = `${m / 10n ** 18n}.${(m % 10n ** 18n).toString().padStart(18, '0')}`; mults.set(stock.address, { v, at: Date.now() }); return v;
    } catch (e) { return net.id !== 'robinhood' && (e instanceof JsonRpcError || /revert/i.test((e as Error).message)) ? '1' : null; }
  };
  const stockPriceCheck = async (s: Awaited<ReturnType<typeof createBaseTrader>>, stock: EvmStock, side: 'buy' | 'sell', amount: bigint, decimals: number) => {
    const [tin, tout] = side === 'buy' ? [NATIVE, stock.address] : [stock.address, NATIVE];
    const qs = s.chain.venues().filter(v => v.status === 'active' && v.supports(tin, tout)).map(v => { try { return v.quote(tin, tout, amount).amountOut; } catch { return 0n; } });
    const out = qs.length ? qs.reduce((a, b) => (b > a ? b : a)) : 0n; if (out <= 0n) throw new SdkError('no_route', `no route prices ${stock.symbol} right now`, 'Retry shortly.', 503);
    const eth = await ethUsd(), mint = refMint(stock.ticker), ref = mint ? (await prices.get([mint])).get(mint)?.stockPrice ?? null : null;
    if (!eth) throw new SdkError('no_reference_price', 'no ETH price right now, so the fill cannot be checked against the share price', 'Retry shortly, or send allowRiskyToken: true to trade without the check.', 503);
    if (!ref) throw new SdkError('no_reference_price', `the share price of ${stock.ticker} is not available right now, so the fill cannot be checked`, 'Retry shortly, or send allowRiskyToken: true to trade without the check.', 503);
    const mult = await multiplier(stock);
    if (!mult) throw new SdkError('no_reference_price', `the share multiplier of ${stock.symbol} cannot be read right now, so the fill cannot be checked`, 'Retry shortly, or send allowRiskyToken: true to trade without the check.', 503);
    // checkFillPrice works in lamports (1e9) and a SOL price: wei with the ETH price divided by 1e9 is the same dollar amount
    const check = checkFillPrice({ side, solLamports: side === 'buy' ? amount : out, tokensRaw: side === 'buy' ? out : amount, decimals, multiplier: mult, solUsd: eth.price / 1e9, referenceUsd: ref, maxDeviationPct: maxDev });
    if (!check.ok) throw new SdkError('bad_price', check.why!, 'Try a smaller amount, or send allowRiskyToken: true to trade anyway.', 409);
  };
  const make = async (userId: string, state: (name: string) => Backend): Promise<Account> => {
    const link = readBaseLink(state(walletState(net.id)));
    const s = await createBaseTrader({ userId, address: link?.address, walletId: link?.walletId, rpcUrl: c.rpcUrl, rpc, privy, state, caps: c.caps, ethUsd, log: c.log, relay: c.relay, aggregator: c.aggregator, kyber: c.kyber, network: net });
    status.set(userId, { address: link?.address, active: s.active, why: s.active ? undefined : (link ? s.why : 'No wallet is linked. Link your Privy Ethereum wallet: POST /v1/wallet/link/start, then /v1/wallet/link/finish.') });
    // copy trading (evmcopy.ts): a copied buy passes the same checks as a manual one first: for a stock, the operator switch and the share-price check
    const copies = evmCopies({ trader: s.trader, follower: link?.address, chainId: s.chain.id, label: net.label, native: net.native, weth: net.weth, rpc, state, caps: c.caps ?? BASE_DEFAULT_CAPS,
      active: () => s.active, prepare: s.prepare, findStock: stocksHere ? findStock : undefined, log: c.log,
      gate: async (token, wei) => { const st = stocksHere ? findStock(token) : undefined; if (st && !stocksOn) throw stocksOff(); if (st) { await s.sync(); await stockPriceCheck(s, st, 'buy', wei, await s.decimals(st.address)); } } });
    copies.restore();   // before the node calls trader.resume(): restored runners finish their in-flight copies
    return { trader: s.trader, copies, prepare: async (raw: any, path: string) => {
      if (path === '/v1/copies' || path.startsWith('/v1/copies/')) return raw;   // copy bodies are validated by evmcopy.ts (plain units of their own)
      const trades = TRADE_PATHS.test(path); if (trades) s.refuseIfInactive();
      if (raw && typeof raw === 'object' && raw.token === undefined && typeof raw.mint === 'string') { raw = { ...raw, token: raw.mint }; delete raw.mint; }   // 'mint' works too
      // a stock may be named by its symbol (NVDAc on Base) or ticker (NVDA; TSLA on Robinhood Chain), as `token` or `stock`: replaced by its address
      if (stocksHere && raw && typeof raw === 'object') { const t = raw.token ?? raw.stock; if (typeof t === 'string' && !isAddress(t)) { const a = findStock(t); if (a) raw = { ...raw, token: a.address }; } if ('stock' in raw) { raw = { ...raw }; delete raw.stock; } }
      const tok = raw?.token; if (typeof tok === 'string') await s.prepare(tok);   // finds the token's V2 pool, or its aggregator routes, and its decimals (plain units need them)
      const stock = stocksHere && typeof tok === 'string' ? findStock(tok) : undefined;
      const body = await s.simple(path, raw);
      if (trades || typeof tok === 'string') await s.sync();   // chain clock (deadlines) and pool reserves (quotes) as of now
      if (stock && isBuy(path, body) && !stocksOn) throw stocksOff();
      // a stock route must fill near the share price (before anything is signed); a limit order is checked at its size now, its trigger price guards the fill itself
      const side = isBuy(path, body) ? 'buy' : isSell(path) ? 'sell' : undefined, amt = body?.amount ?? body?.total;
      if (stock && side && raw?.allowRiskyToken !== true && typeof amt === 'string' && /^\d+$/.test(amt) && BigInt(amt) > 0n) await stockPriceCheck(s, stock, side, BigInt(amt), await s.decimals(stock.address));
      return body;
    } };
  };
  return { make, status: (u: string) => status.get(u), privy, network: net };
}

/** The wallet-linking routes for Base. `state(user)` gives the owner node's durable state for that user; `reload(user)` rebuilds its account. */
/** `chain`/`label`: which EVM chain these routes link for (default base). Each chain keeps its own link (walletState), its own Privy policy and its own caps. */
export function baseLinkRoutes(o: { privy: PrivyApi; state: (userId: string) => ((name: string) => Backend) | undefined; reload: (userId: string) => Promise<void>; status: (userId: string) => Status | undefined; now?: () => number; chain?: string; label?: string }): Route[] {
  const now = o.now ?? Date.now, pending = new Map<string, { address: string; message: string; exp: number }>(), chain = o.chain ?? 'base', label = o.label ?? EVM_NETWORKS[chain]?.label ?? chain, ws = walletState(chain);
  const st = (u: string) => { const s = o.state(u); if (!s) throw new SdkError('not_owner', 'this node does not run your account right now', 'Retry in a few seconds.', 503); return s; };
  const view = (u: string) => { const l = readBaseLink(st(u)(ws)), s = o.status(u); return { chain, linked: !!l, address: l?.address ?? null, active: !!s?.active, why: s?.active ? null : s?.why ?? null }; };
  return [
    { method: 'GET', path: '/v1/wallet', scope: 'read', summary: `Your linked Privy wallet on ${label} and whether this server may trade it now`, run: c => view(c.userId) },
    { method: 'POST', path: '/v1/wallet/link/start', scope: 'trade', summary: 'Start linking your Privy Ethereum wallet: returns a one-time message for the wallet to sign with personal_sign (moves no funds)', body: 'address',
      run: c => { const address = String(c.body?.address ?? '').trim().toLowerCase(); if (!isAddress(address)) throw new SdkError('bad_address', 'address must be a 0x Ethereum address');
        const message = `memedesk: link this wallet to account ${c.userId} on ${label}.\n\nAddress: ${address}\nNonce: ${randomBytes(16).toString('hex')}\nIssued: ${new Date(now()).toISOString()}\n\nSigning this moves no funds.`;
        pending.set(c.userId, { address, message, exp: now() + 5 * 60_000 }); return { message }; } },
    { method: 'POST', path: '/v1/wallet/link/finish', scope: 'trade', summary: `Finish linking with the personal_sign signature of that message (0x, 65 bytes). The wallet must already allow this server in Privy (signer + ${label} policy)`, body: 'address, signature (0x hex)',
      run: async c => {
        const address = String(c.body?.address ?? '').trim().toLowerCase(), p = pending.get(c.userId); pending.delete(c.userId);
        if (!p || p.exp < now() || p.address !== address) throw new SdkError('link_expired', 'no link in progress for this address, or it expired', 'Call /v1/wallet/link/start again.', 410);
        let who = ''; try { who = personalSigner(p.message, String(c.body?.signature ?? '')); } catch { /* reported below */ }
        if (who !== address) throw new SdkError('bad_signature', 'the signature does not match this address and message', undefined, 401);
        let d; try { d = await o.privy.delegation(address); } catch (e) { throw new SdkError('privy_unavailable', (e as Error).message, 'Retry shortly.', 503); }
        if (!d.ok) throw new SdkError('not_delegated', d.why, `In your app, call Privy useSigners().addSigners({ address, signers: [{ signerId, policyIds: [${chain}PolicyId] }] }) first.`, 409);
        st(c.userId)(ws).write(JSON.stringify({ address, walletId: d.walletId, linkedAt: now() } satisfies BaseLink));
        await o.reload(c.userId); return view(c.userId);
      } },
    { method: 'DELETE', path: '/v1/wallet', scope: 'trade', summary: 'Unlink the wallet: this server stops trading it (orders stay saved and are refused until a wallet is linked)',
      run: async c => { st(c.userId)(ws).write('{}'); await o.reload(c.userId); return view(c.userId); } },
  ];
}
