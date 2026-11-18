/** ONE CALL FOR A REAL BASE TRADER signed by the user's own Privy Ethereum wallet: `createBaseTrader`. The Base twin of createSolanaTrader:
 *  Trader + Engine (write-ahead journal) + PolicySigner (per-trade and daily ETH caps, durable ledger) + EvmRpcChain (Uniswap V2 on Base) + PrivyEvmSigner.
 *  The user first adds your server signer with your Base policy to their Privy Ethereum wallet (browser: useSigners().addSigners). Before anything is signed, Privy is
 *  asked whether that is still so; if not, the Trader is still returned (reads work) and every trade is refused with the reason (`active: false`, `why`).
 *  Every transaction Privy signs is decoded and compared field by field with what the engine built (destination, value, data, nonce, gas, chain), and its signer is
 *  recovered from the signature: it must be the user's wallet. Anything else is refused and nothing is sent.
 *  Scope, honestly: trades route through Uniswap V2 pools against WETH and, for a token with no V2 WETH pool (Coinbase stocks, V3/V4/Aerodrome-only tokens), through
 *  Relay: gated against Relay's pinned contracts and the reviewed inner swaps, and simulated against the wallet's balances before signing (packages/evm/src/relay.ts).
 *  A thin V2 pool still gives a bad price, so check the quote. No token safety check and no fee sharing on Base yet (the fee needs an on-chain fee router; Relay
 *  routes refuse a platform fee). Base has no public mempool, so there is no MEV setting. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Engine, Router, Store, PolicySigner, MemoryLedger, NATIVE, fileBackend } from '../../core/src/index.ts';
import type { Backend, SpentLedger, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, JsonRpcError, mismatch, signerOf, isAddress, erc20, RelayClient, RELAY_BASE, V2Venue } from '../../evm/src/index.ts';
import type { RawSigner, Eip1559Request, RpcLike } from '../../evm/src/index.ts';
import { PrivyApi, SignRequestError } from '../../sol/src/index.ts';
import type { PrivyConfig } from '../../sol/src/index.ts';
import { Trader } from './trader.ts';
import { SdkError } from './wire.ts';
import { simpleBody } from './solana.ts';

/** Base mainnet, Uniswap V2 (addresses read back from the chain: router.factory(), router.WETH(), factory.getPair(WETH, USDC)). */
export const BASE = {
  chainId: 8453, router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  weth: '0x4200000000000000000000000000000000000006', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', wethUsdcPair: '0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c',
} as const;
/** Defaults: at most 0.01 ETH per buy and 0.05 ETH of buys per day. The Privy policy should cap the value separately. */
export const BASE_DEFAULT_CAPS = { maxTradeWei: 10n ** 16n, dailyCapWei: 5n * 10n ** 16n };
const BIG = 10n ** 40n, lc = (s: string) => s.toLowerCase();
/** Below this much WETH a V2 pool is treated as thin and Relay routes are added next to it (1 WETH). */
export const THIN_V2_WETH = 10n ** 18n;

/** JSON-RPC over HTTPS. A JSON-RPC error object becomes JsonRpcError (the node answered); anything else is a transport failure. */
export class EvmJsonRpc implements RpcLike {
  private n = 0;
  constructor(private url: string, private o: { timeoutMs?: number; fetchFn?: typeof fetch } = {}) { if (!/^https?:\/\//.test(url)) throw new SdkError('config', 'the Base RPC URL must start with http:// or https://'); }
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const r = await (this.o.fetchFn ?? fetch)(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }), signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
    const j: any = await r.json(); if (j.error) throw new JsonRpcError(String(j.error.message ?? JSON.stringify(j.error)).slice(0, 300)); return j.result as T;
  }
}

/** A RawSigner backed by Privy (eth_signTransaction). `wallets` maps each lowercase 0x address it may sign for to its Privy wallet id. */
export class PrivyEvmSigner implements RawSigner {
  constructor(private api: PrivyApi, private wallets: Map<string, string>) { if (api.chainType !== 'ethereum') throw new Error('PrivyEvmSigner needs a PrivyApi with chainType ethereum'); }
  async sign(q: Eip1559Request): Promise<string> {
    const id = this.wallets.get(lc(q.wallet)); if (!id) throw new SignRequestError(`no Privy wallet is set up for ${q.wallet.slice(0, 8)}...: nothing was sent`);
    const h = (n: bigint) => '0x' + n.toString(16);
    let raw: string; try { raw = await this.api.signEthTransaction(id, { type: 2, chain_id: q.chainId, from: lc(q.wallet), to: lc(q.to), data: q.data, value: h(q.value), nonce: q.nonce, gas_limit: h(q.gasLimit), max_fee_per_gas: h(q.maxFeePerGas), max_priority_fee_per_gas: h(q.maxPriorityFeePerGas) }); }
    catch (e) { throw new SignRequestError(`${(e as Error).message}: nothing was sent`); }
    const bad = mismatch(raw, q); if (bad) throw new SignRequestError(`Privy returned a different transaction (${bad}): nothing was sent`);
    let who: string; try { who = signerOf(raw); } catch (e) { throw new SignRequestError(`Privy returned a signature that cannot be read (${(e as Error).message}): nothing was sent`); }
    if (who !== lc(q.wallet)) throw new SignRequestError('Privy signed with a different key than this wallet: nothing was sent');
    return raw;
  }
}

export interface BaseTraderOptions {
  userId: string;
  /** The user's Privy Ethereum wallet address (0x...). Undefined: a read-only account that refuses trades until a wallet is linked. */
  address?: string;
  /** The Privy wallet id saved when the user linked (checked against Privy). Optional. */
  walletId?: string;
  rpcUrl: string;
  /** Privy settings with your BASE policy id (chainType is set to ethereum for you), or a PrivyApi built with chainType 'ethereum'. */
  privy: PrivyConfig | PrivyApi;
  persistDir?: string; state?: (name: string) => Backend;
  caps?: { maxTradeWei: bigint; dailyCapWei: bigint };
  /** ETH/USD for USD triggers. Default: the Uniswap V2 WETH/USDC pool on Base, read on chain, cached 30 s. */
  ethUsd?: () => Promise<{ price: number; at: number } | null>;
  rpc?: RpcLike;
  log?: (m: string) => void;
  /** Relay routes for tokens without a Uniswap V2 WETH pool (Coinbase stocks, V3/V4/Aerodrome-only tokens). Default on; `false` turns it off. Relay's docs require an API
   *  key for /quote/v2 (`apiKey`). Your Privy Base policy must allow Relay's router and approval proxy (RELAY_BASE) or Privy refuses those trades. */
  relay?: false | { apiKey?: string; client?: RelayClient };
}
export interface BaseTrader { trader: Trader; chain: EvmRpcChain; active: boolean; why?: string; prepare: (token: string) => Promise<void>; sync: () => Promise<void>; refuseIfInactive: () => void;
  /** Plain units for one API call: `token` (0x address), `eth` for ETH amounts, `tokens` or `pct` to sell, `price` in ETH per token or `priceUsd`, `slippagePct` ... */
  simple: (path: string, body: any) => Promise<any> }

function backendLedger(b: Backend): SpentLedger {
  let l: MemoryLedger; try { const s = b.read(); l = s ? MemoryLedger.restore(s) : new MemoryLedger(); } catch { l = new MemoryLedger(); }
  return { get: k => l.get(k), set: (k, v) => { l.set(k, v); b.write(l.snapshot()); } };
}
const word = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

/** ETH/USD from the V2 WETH/USDC pool reserves on Base (one eth_call, cached). */
export function baseEthUsd(rpc: RpcLike, ttlMs = 30_000) {
  let cache: { price: number; at: number } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache;
    try {
      const r = await rpc.call<string>('eth_call', [{ to: BASE.wethUsdcPair, data: '0x0902f1ac' }, 'latest']), r0 = BigInt('0x' + r.slice(2, 66)), r1 = BigInt('0x' + r.slice(66, 130));
      const [usdc, weth] = BASE.usdc < BASE.weth ? [r0, r1] : [r1, r0];   // token0 is the lower address
      const v = (Number(usdc) / 1e6) / (Number(weth) / 1e18); if (v > 0 && Number.isFinite(v)) cache = { price: v, at: Date.now() };
    } catch { /* keep the last price; triggers ignore a stale one */ }
    return cache ?? null;
  };
}

export async function createBaseTrader(o: BaseTraderOptions): Promise<BaseTrader> {
  if (!o.state && !o.persistDir) throw new SdkError('config', 'createBaseTrader needs persistDir or state: a real account must survive restarts');
  if (o.address !== undefined && !isAddress(o.address)) throw new SdkError('bad_address', 'address must be a 0x Ethereum address');
  if (!o.state) mkdirSync(o.persistDir!, { recursive: true });
  const state = o.state ?? ((n: string) => fileBackend(join(o.persistDir!, `${n}.json`))), log = o.log ?? (() => {}), address = o.address ? lc(o.address) : undefined;
  const privy = o.privy instanceof PrivyApi ? o.privy : new PrivyApi({ ...o.privy, chainType: 'ethereum' }), caps = o.caps ?? BASE_DEFAULT_CAPS, relayOn = o.relay !== false, venues = relayOn ? ['uniswap-v2', 'relay'] : ['uniswap-v2'];
  const relayClient = o.relay === false ? undefined : (o.relay?.client ?? new RelayClient({ chainId: BASE.chainId, apiKey: o.relay?.apiKey }));
  if (privy.chainType !== 'ethereum') throw new SdkError('config', 'createBaseTrader needs a PrivyApi with chainType ethereum (and your Base policy id)');
  let signable = new Map<string, string>(), why: string | undefined;
  if (!address) why = 'No wallet is linked to this account.';
  else { const d = await privy.delegation(address);   // throws when Privy is unreachable: the caller retries rather than run blind
    if (d.ok && (!o.walletId || d.walletId === o.walletId)) signable = new Map([[address, d.walletId]]); else why = d.ok ? 'The Privy wallet at this address is not the one that was linked. Link it again.' : d.why; }
  const rpc = o.rpc ?? new EvmJsonRpc(o.rpcUrl);
  const chain = new EvmRpcChain({ id: 'base-main', chainId: BASE.chainId, router: BASE.router, weth: BASE.weth, pools: [], finalityDepth: 3, ...(relayClient ? { relay: { client: relayClient, contracts: RELAY_BASE, refWallet: address } } : {}) }, rpc, new PrivyEvmSigner(privy, signable));
  const policies = new Map<string, WalletPolicy>(), owners = new Map<string, string>();
  if (address) { owners.set(address, 'x'); policies.set(address, { userId: o.userId, chains: ['base-main'], allowedVenues: venues, maxPerTx: { [NATIVE]: caps.maxTradeWei }, dailyLimit: { [NATIVE]: caps.dailyCapWei }, destinations: [], deviceSecret: randomBytes(16).toString('hex') }); }
  const engine = new Engine({ store: Store.open(state('engine')), chain, signer: new PolicySigner(owners, policies, backendLedger(state('ledger'))), router: new Router(chain), platformFeeBps: 0 });
  const decs = new Map<string, number>(), added = new Set<string>();
  const decimals = async (t: string) => { t = lc(t); if (t === NATIVE) return 18; let d = decs.get(t); if (d === undefined) { d = Number(BigInt(await rpc.call<string>('eth_call', [{ to: t, data: '0x313ce567' }, 'latest']))); if (!(d >= 0 && d <= 36)) throw new SdkError('bad_token', 'this token reports no usable decimals'); decs.set(t, d); } return d; };
  // Selling a token the wallet holds returns ETH to the same wallet, so only buys are capped in ETH (see BASE_DEFAULT_CAPS).
  const prepare = async (token: string) => {
    if (token === NATIVE) return; const t = lc(token); if (added.has(t)) return; if (!isAddress(t)) throw new SdkError('bad_token', 'token must be a 0x token address on Base');
    if (t === BASE.weth) throw new SdkError('bad_token', 'WETH is ETH here: trade the token against ETH');
    let pair: string; try { pair = '0x' + (await rpc.call<string>('eth_call', [{ to: BASE.factory, data: '0xe6a43905' + word(BASE.weth) + word(t) }, 'latest'])).slice(26); }
    catch (e) { throw new SdkError('rpc_unavailable', `could not look up the pool: ${(e as Error).message}`, 'Retry shortly.', 503); }
    if (/^0x0{40}$/.test(pair)) {   // no V2 pool (Coinbase stocks, V3/V4/Aerodrome-only tokens): Relay routes, gated and simulated before signing (packages/evm/src/relay.ts)
      if (!relayOn) throw new SdkError('no_route', 'this token has no Uniswap V2 pool against WETH on Base, and Relay routing is off', 'Check the address, or turn Relay on.');
      let ok: boolean; try { ok = await chain.addAggToken(t); } catch (e) { throw new SdkError('rpc_unavailable', `could not ask Relay for a route: ${(e as Error).message}`, 'Retry shortly.', 503); }
      if (!ok) throw new SdkError('no_route', `no Uniswap V2 pool and no Relay route for this token on Base${chain.aggError ? ` (${chain.aggError})` : ''}`, 'Check the address, or trade it elsewhere.');
    } else chain.addPool({ id: `uniswap-v2:${t}`, pair });
    await chain.refresh('venues'); await decimals(t);
    // a V2 pool holding less than THIN_V2_WETH is no market (many tokens keep a dust V2 pair while trading on V3/V4/Aerodrome): add Relay too; the Router takes the better quote
    const v2 = chain.venues().find(v => v.id === `uniswap-v2:${t}`) as V2Venue | undefined, wethRes = v2 ? (v2.token0 === BASE.weth ? v2.reserve0 : v2.reserve1) : 0n;
    if (relayOn && v2 && wethRes < THIN_V2_WETH) await chain.addAggToken(t).catch(e => { log(`${o.userId}: ${t}: thin V2 pool and Relay failed: ${(e as Error).message}`); return false; });
    added.add(t); for (const p of policies.values()) { p.maxPerTx[t] = BIG; p.dailyLimit[t] = BIG; } };
  const usd = o.ethUsd ?? baseEthUsd(rpc);
  const trader: Trader = new Trader({ engine, chain, userId: o.userId, venues, state, usd: { quoteUsd: usd, quoteDecimals: 18, tokenDecimals: decimals, maxAgeMs: 120_000 },
    advanceChain: async () => { for (const x of trader.listOrders({ status: 'active' })) if (!added.has(lc(x.token))) await prepare(x.token).catch(e => log(`${o.userId}: ${x.token}: ${(e as Error).message}`)); await chain.refresh('venues'); } });
  const active = signable.size > 0;
  const balance = async (t: string) => { const q = erc20.balanceOf(lc(t), address!); return erc20.decodeUint(await rpc.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); };
  const simple = async (path: string, body: any) => { const b = body && typeof body === 'object' && typeof body.token === 'string' && body.token !== NATIVE ? { ...body, token: lc(body.token) } : body; return simpleBody(path, b, { address, decimals, balance, native: { key: 'eth', decimals: 18 } }); };
  return { trader, chain, active, why, prepare, simple, sync: async () => { await chain.refresh('venues'); },
    refuseIfInactive: () => { if (!active) throw new SdkError('wallet_not_active', why ?? 'no wallet can sign for this account', 'Link a Privy wallet that allows this server (signer + Base policy).', 409); } };
}
