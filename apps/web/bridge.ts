/** Bridge-then-buy for the EVM chains: move the user's own ETH from Base to the chain they want to buy on, through Relay, signed by the USER in Privy (never by the server signer).
 *  Why the user signs: a Relay deposit's receiver lives in Relay's request, not in the calldata, so the server's Privy policy cannot check where the money ends up. The page asks the user instead.
 *  What this file checks before the page ever shows the Privy prompt, so a wrong or tampered quote is refused here:
 *    - one step, one transaction, on the origin chain, to Relay's pinned depository contract, calling depositNative(depositor, requestId);
 *    - the depositor in the calldata and the quote's sender and recipient are all the user's own address (the second word is Relay's order id);
 *    - the amount is no more than BRIDGE_MAX_ETH (default 0.01) and the quote delivers at least what was asked.
 *  The Relay key stays on the server. Read-only otherwise: balances come from the chains' RPCs, status from Relay. */

export type EvmChain = 'base' | 'robinhood' | 'bnb';
export const EVM_CHAINS: Record<EvmChain, { chainId: number; native: string; alchemyNet: string; rpcEnv: string; label: string }> = {
  base: { chainId: 8453, native: 'ETH', alchemyNet: 'base-mainnet', rpcEnv: 'BASE_RPC_URL', label: 'Base' },
  robinhood: { chainId: 4663, native: 'ETH', alchemyNet: 'robinhood-mainnet', rpcEnv: 'ROBINHOOD_RPC_URL', label: 'Robinhood Chain' },
  bnb: { chainId: 56, native: 'BNB', alchemyNet: 'bnb-mainnet', rpcEnv: 'BNB_RPC_URL', label: 'BNB Chain' },
};
/** Chains the page can bridge FROM: the user signs there in Privy, and the Privy bundle only knows Base. */
export const BRIDGE_ORIGINS: EvmChain[] = ['base'];
/** Relay's depository contract per origin chain id (seen in live quotes, 2026-11-19). A quote to any other contract is refused. */
export const RELAY_DEPOSITORY: Record<number, string> = { 8453: '0x4cd00e387622c35bddb9b4c962c136462338bc31' };
/** depositNative(address depositor, bytes32 id) */
export const DEPOSIT_NATIVE = '0x49290c1c';
const ZERO = '0x0000000000000000000000000000000000000000';
/** Native coin a buy should leave behind on the destination chain for its own gas (approve + swap), in wei. */
export const GAS_RESERVE_WEI: Record<EvmChain, bigint> = { base: 30_000_000_000_000n, robinhood: 30_000_000_000_000n, bnb: 300_000_000_000_000n };

export type Deps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv };
class BridgeError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const chainOf = (c: unknown): EvmChain => { if (typeof c === 'string' && c in EVM_CHAINS) return c as EvmChain; throw new BridgeError(`Unknown chain "${String(c)}". Use base, robinhood or bnb.`); };
/** "0.0012" (decimal coin) to wei, refusing anything that is not a plain positive number. */
export function toWei(x: unknown): bigint {
  const s = String(x ?? '').trim(); if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new BridgeError(`"${s}" is not an amount. Write it like 0.001.`);
  const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export const fromWei = (w: bigint, dp = 6) => { const s = (Number(w) / 1e18).toFixed(dp); return s.replace(/\.?0+$/, '') || '0'; };
function rpcUrl(c: EvmChain, env: NodeJS.ProcessEnv) {
  const v = EVM_CHAINS[c], k = env.ALCHEMY_API_KEY; const u = env[v.rpcEnv] || (k ? `https://${v.alchemyNet}.g.alchemy.com/v2/${k}` : '');
  if (!u) throw new BridgeError(`No RPC for ${v.label} on this server (${v.rpcEnv} or ALCHEMY_API_KEY).`, 503); return u;
}

/** The user's native balance on every EVM chain, so the page can show one total and see a shortfall before buying. A chain whose RPC fails says so instead of showing 0. */
export async function evmBalances(body: any, d: Deps = {}) {
  const f = d.fetch ?? fetch, env = d.env ?? process.env, address = String(body?.address ?? '').toLowerCase();
  if (!isAddr(address)) throw new BridgeError('address must be a 0x address.');
  const chains = await Promise.all((Object.keys(EVM_CHAINS) as EvmChain[]).map(async c => {
    try {
      const r = await f(rpcUrl(c, env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }), signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json(); if (typeof j?.result !== 'string') throw new Error('no result');
      const wei = BigInt(j.result); return { chain: c, label: EVM_CHAINS[c].label, symbol: EVM_CHAINS[c].native, wei: wei.toString(), amount: fromWei(wei), ok: true };
    } catch { return { chain: c, label: EVM_CHAINS[c].label, symbol: EVM_CHAINS[c].native, wei: null, amount: null, ok: false, why: `Could not read your balance on ${EVM_CHAINS[c].label} right now.` }; }
  }));
  // with { to, spend }: how much must arrive on `to` for that buy (spend + gas reserve - balance), so the page knows whether to bridge first
  if (body?.to === undefined) return { address, chains };
  const to = chainOf(body.to), spend = toWei(body.spend), here = chains.find(c => c.chain === to)!;
  if (!here.ok) return { address, chains, need: null, why: here.why };
  const need = shortfall(to, spend, BigInt(here.wei!));
  return { address, chains, to, need: fromWei(need, 8), needWei: need.toString(), reserve: fromWei(GAS_RESERVE_WEI[to], 8) };
}

/** How much must arrive on `to` so a buy of `spend` there still leaves gas: max(0, spend + reserve - balance). */
export function shortfall(to: EvmChain, spendWei: bigint, balanceWei: bigint) { const need = spendWei + GAS_RESERVE_WEI[to] - balanceWei; return need > 0n ? need : 0n; }

/** A Relay quote that delivers `receive` (destination coin) to the user's own address on `to`, paid from `from`, checked as described at the top. Returns the one transaction for Privy to send. */
export async function bridgeQuote(body: any, d: Deps = {}) {
  const f = d.fetch ?? fetch, env = d.env ?? process.env, address = String(body?.address ?? '').toLowerCase();
  if (!isAddr(address)) throw new BridgeError('address must be your 0x wallet address.');
  const from = chainOf(body?.from ?? 'base'), to = chainOf(body?.to);
  if (!BRIDGE_ORIGINS.includes(from)) throw new BridgeError(`Bridging from ${EVM_CHAINS[from].label} is not supported yet. Bridge from Base.`);
  if (from === to) throw new BridgeError('The wallet is already on that chain: nothing to bridge.');
  const receive = /^\d{1,30}$/.test(String(body?.receiveWei ?? '')) ? BigInt(body.receiveWei) : toWei(body?.receive); if (receive <= 0n) throw new BridgeError('Ask for more than 0.');
  const cap = toWei(env.BRIDGE_MAX_ETH || '0.01');
  const o = EVM_CHAINS[from], t = EVM_CHAINS[to], key = env.RELAY_API_KEY?.trim();
  let r: Response; try {
    r = await f('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ user: address, recipient: address, originChainId: o.chainId, destinationChainId: t.chainId, originCurrency: ZERO, destinationCurrency: ZERO, amount: receive.toString(), tradeType: 'EXACT_OUTPUT' }) });
  } catch { throw new BridgeError('Relay did not answer. Try again in a moment.', 503); }
  const q: any = await r.json().catch(() => ({}));
  if (!r.ok) { const m = String(q?.message ?? ''); throw new BridgeError(/insufficient|balance/i.test(m) ? `You do not have enough ${o.native} on ${o.label} for this.` : `Relay could not bridge this: ${m.split(key || '\u0000').join('<key>').slice(0, 160) || 'HTTP ' + r.status}.`, r.status >= 500 ? 503 : 400); }
  const steps = q?.steps ?? [], item = steps[0]?.items?.[0]?.data, requestId = String(steps[0]?.requestId ?? '');
  const bad = (why: string) => { throw new BridgeError(`This bridge quote was refused for your safety: ${why}. Nothing was signed.`, 422); };
  if (steps.length !== 1 || steps[0]?.id !== 'deposit' || steps[0]?.items?.length !== 1 || !item) bad('it is not a single deposit');
  if (Number(item.chainId) !== o.chainId) bad(`it is not on ${o.label}`);
  if (String(item.to).toLowerCase() !== RELAY_DEPOSITORY[o.chainId]) bad("it does not go to Relay's deposit contract");
  if (item.from && String(item.from).toLowerCase() !== address) bad('it is from another wallet');
  if (!/^0x[0-9a-f]{64}$/i.test(requestId)) bad('it has no request id');
  // depositNative(depositor, id): the depositor must be the user; the id is Relay's own order id (not the requestId, seen live 2026-11-19), so only its shape is checked
  const data = String(item.data ?? '').toLowerCase();
  if (!data.startsWith(DEPOSIT_NATIVE) || data.length !== 138) bad('it is not a plain Relay deposit');
  if (data.slice(10, 74) !== address.slice(2).padStart(64, '0')) bad('its deposit is not credited to your wallet');
  if (String(q?.details?.recipient ?? '').toLowerCase() !== address || String(q?.details?.sender ?? '').toLowerCase() !== address) bad('it pays someone other than you');
  const value = BigInt(String(item.value ?? '0')), out = BigInt(String(q?.details?.currencyOut?.amount ?? '0'));
  if (out < receive) bad('it delivers less than asked');
  if (value > cap) throw new BridgeError(`This needs ${fromWei(value)} ${o.native} from ${o.label}, above the bridge limit of ${fromWei(cap)} (BRIDGE_MAX_ETH).`);
  const fees = q?.fees ?? {}, usd = (k: string) => Number(fees[k]?.amountUsd ?? 0);
  return {
    from, to, requestId,
    tx: { to: item.to, value: '0x' + value.toString(16), data: item.data, chainId: o.chainId },
    pay: fromWei(value, 8), paySymbol: o.native, receive: fromWei(out, 8), receiveSymbol: t.native,
    feeUsd: Math.round((usd('relayer') + usd('gas')) * 10000) / 10000, seconds: Number(q?.details?.timeEstimate ?? 0) || null,
  };
}

/** Where a bridge stands: pending, done (money arrived) or failed/refunded, from Relay's status endpoint. */
export async function bridgeStatus(body: any, d: Deps = {}) {
  const f = d.fetch ?? fetch, env = d.env ?? process.env, id = String(body?.requestId ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new BridgeError('requestId must be the 0x id from the quote.');
  const key = env.RELAY_API_KEY?.trim();
  let j: any; try { const r = await f(`https://api.relay.link/intents/status/v3?requestId=${id}`, { headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(10_000) }); j = await r.json(); }
  catch { return { requestId: id, state: 'pending', why: 'Relay did not answer; still checking.' }; }
  const s = String(j?.status ?? 'unknown');
  const state = s === 'success' ? 'done' : ['failure', 'refund', 'refunded'].includes(s) ? 'failed' : 'pending';
  return { requestId: id, state, relayStatus: s, txHashes: (j?.txHashes ?? []).slice(0, 4),
    why: state === 'failed' ? (s.startsWith('refund') ? 'Relay could not finish and sent the money back to your wallet on Base.' : 'Relay reports the bridge failed.') : null };
}
