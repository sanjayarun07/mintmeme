/** RFQ Desk: a standalone desk for JupiterZ market-maker quotes on Solana. Read-only until a wallet connects (docs/JUPITERZ.md).
 *  It asks Jupiter for a firm RFQ quote, the best other route and our own /build route; decodes the RFQ transaction; runs the same gate the engine runs before a wallet
 *  signs (packages/sol/src/jupiterz.ts gateRfq); simulates it against mainnet without signatures; and shows the engine's decision. The desk itself never signs.
 *  TRADING (optional): a browser wallet the user connects signs its own slot of a quote built for it; POST /api/execute forwards it to Jupiter /execute ONLY if the
 *  signed message is byte-for-byte the one this server gated and simulated for that wallet, the wallet's signature verifies, the maker slot is empty, the quote is
 *  live, and the trade is under RFQ_DESK_MAX_USD (default $1,500). Each gated order is executed at most once.
 *  Run: npm run rfq  (PORT, default 3700; SOL_RPC_URL or HELIUS_API_KEY for the node, else the public mainnet RPC; JUPITER_API_KEY optional, keyless is rate limited). */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { SolJsonRpc, STOCKS_SOLANA, stockByMint, readStockStates, checkFillPrice, JupiterStockPrices, ataAddress, PROGRAMS, findProgramAddress, pubkeyBytes } from '../../packages/sol/src/index.ts';
import { fetchBuild, parseMessage, resolveMessage, JupiterRefused } from '../../packages/sol/src/jupiterswap.ts';
import { fetchRfqOrder, gateRfq, decodeFill, splitWire, executeRfq, JUPITERZ } from '../../packages/sol/src/jupiterz.ts';
import { verifySignature } from '../../packages/sol/src/signer.ts';
import { base58 } from '../../packages/sol/src/tx.ts';
import { fetchJupiterQuote } from '../../packages/sol/src/jupiter.ts';
import { RelayClient } from '../../packages/evm/src/relay.ts';
import { BASE_STOCKS } from '../../packages/evm/src/basestocks.ts';
import { BNB_STOCKS } from '../../packages/evm/src/bnbstocks.ts';
import { ROBINHOOD_STOCKS } from '../../packages/evm/src/robinhoodstocks.ts';
import { EvmJsonRpc, baseEthUsd, EVM_NETWORKS } from '../../packages/sdk/src/base.ts';
import { NATIVE } from '../../packages/core/src/index.ts';

const WSOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Quotes are asked for a wallet that holds enough SOL for the size (a public exchange wallet). Nothing is signed for it. */
const DEFAULT_TAKER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
/** Public exchange hot wallets used as quote wallets when none is given. Their balances move all day, so each quote reads them and takes the first plain
 *  (System-owned, no data) wallet that holds the trade plus 1 SOL; nothing is ever signed for them. An address that is not a funded wallet is simply skipped. */
const QUOTE_WALLETS = [DEFAULT_TAKER, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD'];
/** The first plain wallet on the list that holds the trade's input: SOL (the trade plus 1 SOL) or USDC (the trade, plus 0.02 SOL for the new stock account's rent). */
async function pickQuoteWallet(payMint: string, amount: bigint): Promise<{ taker: string; lamports: bigint; held: bigint; enough: boolean }> {
  const usdc = payMint !== WSOL, keys = usdc ? [...QUOTE_WALLETS, ...QUOTE_WALLETS.map(w => ataAddress(w, payMint))] : QUOTE_WALLETS;
  const r: any = await rpc.call('getMultipleAccounts', [keys, { encoding: 'base64' }]), v = r?.value ?? [];
  const rows = QUOTE_WALLETS.map((k, i) => {
    const a = v[i]; if (!a || a.owner !== PROGRAMS.system || (a.space ?? 0) !== 0) return undefined;
    const lamports = BigInt(a.lamports), t = usdc ? v[QUOTE_WALLETS.length + i] : undefined, tb = t?.data?.[0] ? Buffer.from(t.data[0], 'base64') : undefined;
    // a token account the issuer froze (state byte 108 = 2: USDC can be frozen by its issuer) cannot pay, whatever it holds
    const held = usdc ? (tb && tb.length >= 109 && tb[108] === 1 ? tb.readBigUInt64LE(64) : 0n) : lamports;
    return { taker: k, lamports, held, enough: usdc ? held >= amount && lamports >= 20_000_000n : lamports >= amount + 1_000_000_000n };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const hit = rows.find(x => x.enough); if (hit) return hit;
  const best = rows.sort((a, b) => (b.held > a.held ? 1 : -1))[0];
  return best ?? { taker: DEFAULT_TAKER, lamports: 0n, held: 0n, enough: false };
}
const PORT = Number(process.env.PORT ?? 3700), API_KEY = process.env.JUPITER_API_KEY || undefined;
/** Node candidates, in order; the first that answers getSlot is used. Keys stay in the URLs and are never printed. */
const NODES: [string, string | undefined][] = [
  ['your node (SOL_RPC_URL)', process.env.SOL_RPC_URL || undefined],
  ['Helius', process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : undefined],
  ['Alchemy', process.env.ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : undefined],
  ['public mainnet RPC', 'https://api.mainnet-beta.solana.com'],
];
let rpcKind = 'public mainnet RPC', rpcUrl = 'https://api.mainnet-beta.solana.com';
const skipped: string[] = [];
for (const [kind, url] of NODES) { if (!url) continue; try { await new SolJsonRpc(url).call('getSlot'); rpcKind = kind; rpcUrl = url; break; } catch (e) { skipped.push(`${kind}: ${String((e as Error).message).replace(/api-key=[^&\s]+|v2\/[A-Za-z0-9_-]+/g, '***').slice(0, 60)}`); } }
const rpc: SolJsonRpc = new SolJsonRpc(rpcUrl), prices = new JupiterStockPrices();
const FIXTURE = JSON.parse(readFileSync(new URL('../../packages/sol/test/jupiterzfixture.json', import.meta.url), 'utf8'));
const html = () => readFileSync(new URL('./index.html', import.meta.url), 'utf8');
/** Privy sign-in (embedded and external wallets): the bundle built for the Solana test UI (npm run build:privy writes apps/web/privy.bundle.js). Only the PUBLIC app id is sent to the page. */
const PRIVY_BUNDLE = new URL('../web/privy.bundle.js', import.meta.url), PRIVY_APP_ID = process.env.PRIVY_APP_ID || null;
/** Read-only methods Privy's approval screen may ask the node for (the same list as apps/web/server.ts). Nothing that sends. */
const RPC_OK = new Set(['getLatestBlockhash', 'getBalance', 'getFeeForMessage', 'simulateTransaction', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getTokenAccountBalance', 'getSlot',
  'getBlockHeight', 'isBlockhashValid', 'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'getVersion', 'getEpochInfo']);

/* Jupiter keyless access is rate limited: every Jupiter call goes through this queue. */
let nextAt = 0; const GAP = API_KEY ? 150 : 2100;
async function jup<T>(f: () => Promise<T>): Promise<T> { const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(nextAt, Date.now()) + GAP; if (wait) await new Promise(r => setTimeout(r, wait)); return f(); }
const cfg = { apiKey: API_KEY, timeoutMs: 15_000 };
/** Orders gated and simulated for a CONNECTED wallet, by requestId: only these exact messages can be executed, once. Kept until a minute after expiry. */
const MAX_USD = Number(process.env.RFQ_DESK_MAX_USD ?? 1500);
const PENDING = new Map<string, { message: Uint8Array; wallet: string; expireAt: number; usd: number; summary: string; executed?: { at: number; result: unknown } }>();
const prune = () => { const now = Date.now() / 1000; for (const [k, v] of PENDING) if (v.expireAt + 60 < now) PENDING.delete(k); };

let solUsd: { price: number; at: number } | undefined;
async function solPrice() { if (!solUsd || Date.now() - solUsd.at > 30_000) { const q = await jup(() => fetchJupiterQuote({ inputMint: WSOL, outputMint: USDC, amount: 1_000_000_000n, slippageBps: 50, timeoutMs: 8000 })); solUsd = { price: Number(q.outAmount) / 1e6, at: Date.now() }; } return solUsd.price; }
const programs = new Map<string, string>([[WSOL, PROGRAMS.token]]);
async function tokenProgram(mints: string[]) { const need = mints.filter(m => !programs.has(m)); if (need.length) { const r: any = await rpc.call('getMultipleAccounts', [need, { encoding: 'base64' }]); need.forEach((m, i) => { const o = r.value[i]?.owner; if (o) programs.set(m, o); }); } return (m: string) => programs.get(m) ?? PROGRAMS.token; }

/** What a route costs besides the pools' own fees (those are already inside its output): the router's fee, the expected price impact (as a fraction, negative is worse),
 *  the slippage tolerance it would sign with, and the network fees /order reports (lamports). Fields a venue does not report are left out. */
const costs = (j: any) => { const num = (x: any) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));
  const net = ['signatureFeeLamports', 'prioritizationFeeLamports', 'rentFeeLamports'].map(k => num(j?.[k])).filter((x): x is number => x !== undefined);
  return { feeBps: num(j?.feeBps ?? j?.platformFee?.feeBps), impactPct: num(j?.priceImpactPct), slippageBps: num(j?.slippageBps), networkLamports: net.length ? net.reduce((a, b) => a + b, 0) : undefined }; };
async function bestOther(inputMint: string, outputMint: string, amount: bigint) {
  const u = `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&excludeRouters=jupiterz`;
  const j: any = await jup(async () => (await fetch(u, { headers: API_KEY ? { 'x-api-key': API_KEY } : {}, signal: AbortSignal.timeout(15_000) })).json());
  if (!j?.outAmount) throw new Error(j?.error ?? 'no route');
  return { out: BigInt(j.outAmount), router: String(j.router ?? '?'), feeBps: Number(j.feeBps ?? 0), labels: (j.routePlan ?? []).map((r: any) => String(r?.swapInfo?.label ?? '?')), ...costs(j) };
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const KNOWN: Record<string, string> = { [PROGRAMS.system]: 'System', [PROGRAMS.token]: 'Token', [PROGRAMS.token2022]: 'Token-2022', [PROGRAMS.ata]: 'Associated Token', ComputeBudget111111111111111111111111111111: 'Compute Budget', [JUPITERZ.orderEngine]: 'JupiterZ Order Engine', [WSOL]: 'wSOL mint' };
const sym = (m: string) => (m === WSOL ? 'SOL' : m === USDC ? 'USDC' : stockByMint(m)?.symbol ?? short(m));
const decOf = (m: string) => (m === WSOL ? 9 : m === USDC ? 6 : stockByMint(m)?.decimals ?? 0);
/** A raw amount in whole units with its symbol, e.g. "1,343.8 SOL". */
const amt = (raw: bigint, m: string) => { const d = decOf(m), v = Number(raw) / 10 ** d; return `${v.toLocaleString('en-US', { maximumFractionDigits: d ? 4 : 0 })} ${sym(m)}`; };
const FILL_ROLES = ['Taker (you)', 'Maker', 'Your input account', 'Maker input account', 'Your output account', 'Maker output account', 'Input mint', 'Input token program', 'Output mint', 'Output token program', 'System program', 'Maker temporary wSOL'];

/** Decodes an RFQ wire transaction for display, and runs the engine's gate on it. `c` is what the trade is supposed to be. */
async function xray(wire: Uint8Array, c: { wallet?: string; maker?: string; inMint?: string; outMint?: string; amountIn?: bigint; minOut?: bigint; nowSec?: number }) {
  const { message } = splitWire(wire), pm = parseMessage(message), ixs = resolveMessage(pm, []);
  const fillIx = ixs.find(i => i.programId === JUPITERZ.orderEngine); let fill: ReturnType<typeof decodeFill> | undefined; try { fill = fillIx ? decodeFill(fillIx.data) : undefined; } catch { fill = undefined; }
  const wallet = c.wallet ?? pm.staticKeys[1], maker = c.maker ?? pm.staticKeys[0];
  const inMint = c.inMint ?? fillIx?.accounts[6]?.pubkey ?? WSOL, outMint = c.outMint ?? fillIx?.accounts[8]?.pubkey ?? WSOL;
  const tp = await tokenProgram([inMint, outMint]);
  const label = (k: string) => KNOWN[k] ?? (k === wallet ? 'Your wallet' : k === maker ? 'Maker' : k === ataAddress(wallet, outMint, tp(outMint)) ? 'Your output account' : stockByMint(k)?.symbol ? `${stockByMint(k)!.symbol} mint` : undefined);
  const instructions = ixs.map(ix => {
    const name = KNOWN[ix.programId] ?? 'Unknown program', d = ix.data;
    let what = `${d.length} bytes of data`;
    if (ix.programId === 'ComputeBudget111111111111111111111111111111') what = d[0] === 2 ? `Compute limit ${new DataView(d.buffer, d.byteOffset).getUint32(1, true).toLocaleString('en-US')} units` : d[0] === 3 ? `Priority price ${new DataView(d.buffer, d.byteOffset).getBigUint64(1, true)} µlamports per unit, paid by the fee payer` : what;
    if (ix.programId === PROGRAMS.ata) what = `Create your ${sym(ix.accounts[3]?.pubkey ?? '')} account if missing, funded by ${ix.accounts[0]?.pubkey === wallet ? 'your wallet' : short(ix.accounts[0]?.pubkey ?? '')}`;
    if (ix === fillIx && fill) what = `Fill: ${amt(fill.inputAmount, inMint)} in, ${amt(fill.outputAmount, outMint)} out, valid until ${new Date(fill.expireAt * 1000).toISOString().slice(11, 19)} UTC${fill.feeBps !== undefined ? `, Jupiter fee ${fill.feeBps} bps` : ''}`;
    return { program: ix.programId, name, what, accounts: ix.accounts.map((a, i) => ({ key: a.pubkey, signer: a.isSigner, writable: a.isWritable, role: ix === fillIx ? (a.pubkey === JUPITERZ.orderEngine && i >= 2 && i <= 5 ? `${FILL_ROLES[i]}: none` : FILL_ROLES[i]) : label(a.pubkey) })) };
  });
  let verdict: { ok: boolean; reason?: string } = { ok: true };
  const nowSec = c.nowSec ?? Math.floor(Date.now() / 1000);
  try { gateRfq(wire, { wallet, maker, wsol: WSOL, inMint, outMint, amountIn: c.amountIn ?? fill?.inputAmount ?? 0n, minOut: c.minOut ?? fill?.outputAmount ?? 0n, tokenProgram: tp, nowSec }); }
  catch (e) { verdict = { ok: false, reason: (e as Error).message }; if (!(e instanceof JupiterRefused)) verdict.reason = `could not check: ${verdict.reason}`; }
  // the individual checks, for reading; the verdict above is the gate's own and is what the engine acts on
  const k = fillIx?.accounts.map(a => a.pubkey) ?? [];
  const none = (a?: string) => a === JUPITERZ.orderEngine;
  const checks = [
    { name: 'Exactly two signers: the maker pays, you sign second', ok: pm.signers === 2 && pm.staticKeys[0] === maker && pm.staticKeys[1] === wallet },
    { name: 'Nothing is signed yet', ok: splitWire(wire).sigs.every(s => s.every(b => b === 0)) },
    { name: 'Only Compute Budget, one token-account create and one fill', ok: ixs.every(i => i.programId === 'ComputeBudget111111111111111111111111111111' || i.programId === PROGRAMS.ata || i.programId === JUPITERZ.orderEngine) && ixs.filter(i => i.programId === JUPITERZ.orderEngine).length === 1 },
    { name: 'The fill spends exactly your amount', ok: !!fill && (c.amountIn === undefined || fill.inputAmount === c.amountIn) },
    { name: 'The fill pays at least the minimum', ok: !!fill && (c.minOut === undefined || fill.outputAmount >= c.minOut) },
    { name: 'Output goes to your own account', ok: outMint === WSOL ? none(k[4]) : k[4] === ataAddress(wallet, outMint, tp(outMint)) },
    { name: 'Input comes from your wallet or your own account', ok: inMint === WSOL ? none(k[2]) : k[2] === ataAddress(wallet, inMint, tp(inMint)) },
    { name: 'Maker accounts are not yours', ok: [k[3], k[5]].every(a => !a || none(a) || (a !== wallet && a !== ataAddress(wallet, outMint, tp(outMint)) && a !== ataAddress(wallet, inMint, tp(inMint)))) && (k.length !== 12 || k[11] === findProgramAddress([Buffer.from(JUPITERZ.tempWsolSeed), pubkeyBytes(maker)], JUPITERZ.orderEngine).address) },
    { name: 'Quote not expired, and expires within 2 minutes', ok: !!fill && fill.expireAt > nowSec && fill.expireAt <= nowSec + 120 },
    { name: 'No lookup tables', ok: pm.lookups.length === 0 },
  ];
  return { signers: pm.staticKeys.slice(0, pm.signers).map((k, i) => ({ key: k, slot: i, who: k === maker ? 'Maker (pays the network fee)' : k === wallet ? 'Your wallet' : 'Unknown' })), instructions, fill: fill && { inputAmount: String(fill.inputAmount), outputAmount: String(fill.outputAmount), expireAt: fill.expireAt, feeBps: fill.feeBps }, verdict, checks, wallet, maker, inMint, outMint, bytes: wire.length };
}

/** Read-only simulation of the unsigned RFQ transaction: what your wallet would spend and receive. */
async function simulate(wire: Uint8Array, wallet: string, inMint: string, outMint: string) {
  const tp = await tokenProgram([inMint, outMint]), outAta = ataAddress(wallet, outMint, tp(outMint)), inAta = ataAddress(wallet, inMint, tp(inMint));
  const watch = [wallet, outAta, ...(inMint === WSOL ? [] : [inAta])];
  const pre: any = await rpc.call('getMultipleAccounts', [watch, { encoding: 'base64' }]);
  const sim: any = await rpc.call('simulateTransaction', [Buffer.from(wire).toString('base64'), { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', accounts: { encoding: 'base64', addresses: watch } }]);
  const tok = (a: any) => (a?.data?.[0] ? (() => { const b = Buffer.from(a.data[0], 'base64'); return b.length >= 72 ? b.readBigUInt64LE(64) : 0n; })() : 0n);
  if (sim.value.err) return { ok: false, error: JSON.stringify(sim.value.err), log: sim.value.logs?.slice(-3) ?? [] };
  return { ok: true, units: sim.value.unitsConsumed, solSpent: String(BigInt(pre.value[0]?.lamports ?? 0) - BigInt(sim.value.accounts[0]?.lamports ?? 0)), tokensReceived: String(tok(sim.value.accounts[1]) - tok(pre.value[1])),
    paid: inMint === WSOL ? undefined : String(tok(pre.value[2]) - tok(sim.value.accounts[2])), log: sim.value.logs?.slice(-2) ?? [] };
}

async function perShare(mint: string, sol: number) {
  const st = (await readStockStates(rpc as any, [mint]).catch(() => new Map())).get(mint), ref = (await prices.get([mint])).get(mint)?.stockPrice ?? null;
  return { decimals: st?.decimals ?? stockByMint(mint)?.decimals ?? 8, multiplier: st?.multiplier ?? '1', paused: !!st?.paused, ref, checkUsd: (usd1e9: bigint, raw: bigint) => checkFillPrice({ side: 'buy', solLamports: usd1e9, tokensRaw: raw, decimals: st?.decimals ?? 8, multiplier: st?.multiplier ?? '1', solUsd: 1, referenceUsd: ref, maxDeviationPct: 3 }),
    check: (lamports: bigint, raw: bigint) => checkFillPrice({ side: 'buy', solLamports: lamports, tokensRaw: raw, decimals: st?.decimals ?? 8, multiplier: st?.multiplier ?? '1', solUsd: sol, referenceUsd: ref, maxDeviationPct: 3 }) };
}

/** A public holder of `mint` for a sell quote: makers build a transaction only for a wallet that holds what it sells. Among the token's largest accounts, the first
 *  that holds at least `amount`, is not frozen, and belongs to a plain wallet (System-owned, no data) with 0.01 SOL. Nothing is ever signed for it. */
async function pickHolder(mint: string, amount: bigint): Promise<{ taker: string; lamports: bigint; held: bigint; enough: boolean }> {
  const big: any = await rpc.call('getTokenLargestAccounts', [mint]), accts: string[] = (big?.value ?? []).map((x: any) => x.address).slice(0, 20);
  const ta: any = await rpc.call('getMultipleAccounts', [accts, { encoding: 'jsonParsed' }]);
  const rows = accts.map((a, i) => { const info = ta?.value?.[i]?.data?.parsed?.info; return info ? { owner: String(info.owner), held: BigInt(info.tokenAmount?.amount ?? 0), frozen: info.state === 'frozen' } : undefined; })
    .filter((x): x is { owner: string; held: bigint; frozen: boolean } => !!x && !x.frozen);
  const own: any = rows.length ? await rpc.call('getMultipleAccounts', [rows.map(r => r.owner), { encoding: 'base64' }]) : { value: [] };
  const ok = rows.map((r, i) => { const o = own?.value?.[i]; return o && o.owner === PROGRAMS.system && (o.space ?? 0) === 0 ? { taker: r.owner, lamports: BigInt(o.lamports), held: r.held, enough: r.held >= amount && BigInt(o.lamports) >= 10_000_000n } : undefined; })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return ok.find(x => x.enough) ?? ok.sort((x, y) => (y.held > x.held ? 1 : -1))[0] ?? { taker: DEFAULT_TAKER, lamports: 0n, held: 0n, enough: false };
}
/** The token's dollar price, to size a sell in dollars and to say how big it is: Jupiter's usdPrice, or the share price times the multiplier. */
async function tokenUsd(mint: string, sol: number) { const ps = await perShare(mint, sol); return (await prices.get([mint]).catch(() => new Map())).get(mint)?.usdPrice ?? (ps.ref ? ps.ref * Number(ps.multiplier) : null); }

/** POST /api/quote: NDJSON, one line per stage as it arrives, so the desk fills in while Jupiter's rate limit paces the calls.
 *  Body: mint (the stock), pay ('SOL' or 'USDC': the quote asset), side ('buy', default, or 'sell'), amount (raw units of the input: the pay asset for a buy, the stock
 *  for a sell; `lamports` is still accepted), minUsd (RFQ threshold), marginBps, taker (optional). The engine takes RFQ quotes on both sides (SolanaChain.tryRfq). */
async function quote(body: any, emit: (o: unknown) => void) {
  const mint = String(body.mint), payMint = body.pay === 'USDC' ? USDC : WSOL, side: 'buy' | 'sell' = body.side === 'sell' ? 'sell' : 'buy', amount = BigInt(body.amount ?? body.lamports), given = String(body.taker ?? '').trim();
  const [inMint, outMint] = side === 'buy' ? [payMint, mint] : [mint, payMint];
  const marginBps = Number(body.marginBps ?? 20), minUsd = Number(body.minUsd ?? 7500), paySym = sym(payMint), inSym = sym(inMint), inDec = decOf(inMint), forWallet = body.forWallet === true && !!given;
  if (!(amount > 0n)) throw new Error(`enter an amount of ${inSym} above zero`);
  const sol = await solPrice(), perToken = side === 'sell' ? await tokenUsd(mint, sol) : null;
  const usd = side === 'buy' ? (payMint === WSOL ? Number(amount) / 1e9 * sol : Number(amount) / 1e6) : Number(amount) / 10 ** inDec * (perToken ?? 0);
  let taker: string, held: bigint, lamports: bigint, auto = !given;
  if (given) {
    taker = given; lamports = BigInt((await rpc.call<any>('getBalance', [taker]).catch(() => ({ value: 0 }))).value ?? 0);
    const tp = await tokenProgram([inMint]);
    held = inMint === WSOL ? lamports : await rpc.call<any>('getTokenAccountBalance', [ataAddress(taker, inMint, tp(inMint))]).then(r => BigInt(r?.value?.amount ?? 0)).catch(() => 0n);
  } else {
    const p = await (side === 'buy' ? pickQuoteWallet(payMint, amount) : pickHolder(mint, amount)).catch(() => ({ taker: DEFAULT_TAKER, lamports: 0n, held: 0n, enough: false }));
    taker = p.taker; held = p.held; lamports = p.lamports;
  }
  const heldTxt = `${(Number(held) / 10 ** inDec).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${inSym}`;
  emit({ stage: 'context', side, solUsd: sol, usd, pay: paySym, taker, takerSol: Number(lamports) / 1e9, held: heldTxt, auto, rpc: rpcKind, keyed: !!API_KEY });
  const stock = stockByMint(mint), ps = stock ? await perShare(mint, sol) : undefined;
  if (stock && ps) emit({ stage: 'stock', symbol: stock.symbol, issuer: stock.issuer, decimals: ps.decimals, multiplier: ps.multiplier, paused: ps.paused, sharePrice: ps.ref });
  // per-share price: the dollars paid (a buy) or received (a sell) over the shares. USDC is taken at $1; checkFillPrice works in lamports and a SOL price, so USDC
  // amounts are passed as 1e9 units of $1 (raw USDC x 1000)
  const share = (out: bigint) => {
    if (!ps) return undefined;
    const [payRaw, tokens] = side === 'buy' ? [amount, out] : [out, amount], lam = payMint === WSOL ? payRaw : payRaw * 1000n;
    return checkFillPrice({ side, solLamports: lam, tokensRaw: tokens, decimals: ps.decimals, multiplier: ps.multiplier, solUsd: payMint === WSOL ? sol : 1, referenceUsd: ps.ref, maxDeviationPct: 3 });
  };
  // the firm quote: asked again after a pause when Jupiter's per-second limit answers 429 (the ARM screenshot of 2026-11-19), twice at most
  let rfq: Awaited<ReturnType<typeof fetchRfqOrder>> | { none: string } = { none: '' };
  for (let i = 0; i < 3; i++) { rfq = await jup(() => fetchRfqOrder({ ...cfg, inputMint: inMint, outputMint: outMint, amount, taker })).catch(e => ({ none: (e as Error).message })); if (!('none' in rfq) || !/\b429\b/.test(rfq.none)) break; await new Promise(ok => setTimeout(ok, 1500 * (i + 1))); }
  if ('none' in rfq) emit({ stage: 'rfq', none: rfq.none });
  else emit({ stage: 'rfq', out: String(rfq.outAmount), maker: rfq.maker, expireAt: rfq.expireAt, feeBps: rfq.feeBps, slippageBps: 0, requestId: rfq.requestId, share: share(rfq.outAmount) });
  const other = await bestOther(inMint, outMint, amount).catch(e => ({ error: (e as Error).message }));
  emit({ stage: 'other', ...('error' in other ? other : { out: String(other.out), router: other.router, feeBps: other.feeBps, impactPct: other.impactPct, slippageBps: other.slippageBps, networkLamports: other.networkLamports, labels: other.labels, share: share(other.out) }) });
  const build = await jup(() => fetchBuild({ ...cfg, inputMint: inMint, outputMint: outMint, amount, taker, slippageBps: 50 })).catch(e => ({ error: (e as Error).message }));
  emit({ stage: 'build', ...('error' in build ? build : { out: String(build.outAmount), minOut: String(build.minOut), labels: build.routeLabels, impactPct: build.priceImpactPct, slippageBps: build.slippageBps, feeBps: 0, share: share(build.outAmount) }) });
  if (!('none' in rfq)) {
    const minOut = 'error' in build ? undefined : build.minOut;
    let x: Awaited<ReturnType<typeof xray>>;
    try { x = await xray(rfq.tx, { wallet: taker, maker: rfq.maker, inMint, outMint, amountIn: amount, minOut }); }
    catch (e) { emit({ stage: 'decision', useRfq: false, reasons: [{ ok: false, text: `The transaction could not be checked (the node did not answer: ${(e as Error).message}), so it would not be signed` }] }); emit({ stage: 'done' }); return; }
    // Jupiter's gasless mode: when the wallet cannot pay the rent of its new token account, Jupiter adds its own payer as a third signer to fund it. The gate still
    // refuses any signer but the maker and the wallet; this only says why, in terms of what the wallet holds (mainnet 2026-11-18: 30 SOL asked of a wallet with 0.03 SOL)
    const gasPayer = x.verdict.ok ? undefined : x.signers.find(s => s.who === 'Unknown' && x.instructions.some(i => i.program === PROGRAMS.ata && i.accounts[0]?.key === s.key))?.key;
    const gasNote = gasPayer ? `Jupiter added its own payer (${short(gasPayer)}) to fund your new ${sym(outMint)} account, which it does when the wallet cannot pay for it. The wallet holds ${heldTxt}${inMint === WSOL ? '' : ` and ${(Number(lamports) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`}; this trade needs ${amt(amount, inMint)}. Only the maker and your wallet may sign, so this quote is refused: try a size the wallet can pay.` : undefined;
    if (gasNote) x.verdict.reason = `${x.verdict.reason}. ${gasNote}`;
    emit({ stage: 'xray', ...x });
    const sim = await simulate(rfq.tx, taker, inMint, outMint).catch(e => ({ ok: false, error: (e as Error).message, log: [] as string[] }));
    emit({ stage: 'sim', ...sim });
    // the engine's decision, exactly as SolanaChain.tryRfq takes it (the threshold is in USD here; the engine takes it per quote asset)
    const reasons: { ok: boolean; text: string }[] = [], fmt$ = (v: number) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    reasons.push({ ok: usd >= minUsd, text: side === 'buy' ? `Size ${fmt$(usd)} in ${paySym} ${usd >= minUsd ? 'meets' : 'is below'} the ${fmt$(minUsd)} threshold` : `Size ${fmt$(usd)} of ${inSym} for ${paySym} ${usd >= minUsd ? 'meets' : 'is below'} the ${fmt$(minUsd)} threshold` });
    if (!('error' in build)) { const need = build.outAmount * BigInt(10_000 + marginBps) / 10_000n; const bps = Number((rfq.outAmount - build.outAmount) * 10_000n / build.outAmount); reasons.push({ ok: rfq.outAmount >= need, text: `RFQ pays ${bps >= 0 ? '+' : ''}${bps} bps against the /build route; the margin is ${marginBps} bps` }); reasons.push({ ok: rfq.outAmount >= build.minOut, text: `RFQ output ${rfq.outAmount >= build.minOut ? 'reaches' : 'is below'} the engine minimum` }); }
    else reasons.push({ ok: false, text: `No /build route to compare with: ${build.error}` });
    reasons.push({ ok: x.verdict.ok, text: x.verdict.ok ? 'The gate accepts the transaction' : `The gate refuses: ${x.verdict.reason}` });
    const sh = share(rfq.outAmount); if (sh) reasons.push({ ok: sh.ok, text: sh.referenceUsd ? `Share price check: $${sh.perShareUsd.toFixed(2)} per share against $${sh.referenceUsd.toFixed(2)}${sh.ok ? '' : ` (${sh.why})`}` : 'No reference share price right now, so the check is skipped' });
    if (sim.ok === false) {
      // System error 0x1 (not enough lamports) or Token error 0x1 (insufficient funds): the quote wallet cannot pay this size
      const log = (sim.log ?? []).join(' '), short_ = /(11111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) failed: custom program error: 0x1(?![0-9a-f])/.test(log);
      const frozen = /Tokenkeg\w+ failed: custom program error: 0x11(?![0-9a-f])|TokenzQd\w+ failed: custom program error: 0x11(?![0-9a-f])/.test(log);
      reasons.push({ ok: false, text: frozen ? `Simulation: a token account in this fill is frozen by its issuer (Token error 17), so it cannot move.${given ? ' If it is the quote wallet\'s, enter another wallet, or leave it empty to pick one automatically' : ''}` : short_ ? `Simulation: the quote wallet holds ${heldTxt}, less than this trade. ${auto ? `No public wallet ${side === 'buy' ? 'on the list' : 'among its largest holders'} holds that much ${inSym} right now: enter a wallet that does, under Engine rules, or try a smaller size` : `Enter a wallet that holds the ${inSym}, under Engine rules, or leave it empty to pick one automatically`}` : `Simulation failed: ${sim.error}` });
    } else reasons.push({ ok: true, text: `Simulation: the wallet pays the ${inSym} amount and receives at least the minimum` });
    emit({ stage: 'decision', useRfq: reasons.every(r => r.ok), reasons });
    // a connected wallet may sign and execute THIS order: only if the gate accepted it and the simulation passed, and under the desk's size cap
    if (forWallet) {
      // the share-price check binds here as it does in the engine (rfqFillCheck): a fill priced far from the underlying share is never offered for signing
      const priceOk = sh?.ok !== false, tradable = x.verdict.ok && sim.ok === true && priceOk && usd <= MAX_USD, outDec = decOf(outMint);
      const summary = `${side === 'buy' ? 'Pay' : 'Sell'} ${(Number(amount) / 10 ** inDec).toLocaleString('en-US', { maximumFractionDigits: inDec === 9 ? 4 : 4 })} ${inSym}, receive ${(Number(rfq.outAmount) / 10 ** outDec).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${sym(outMint)} from maker ${rfq.maker.slice(0, 4)}…${rfq.maker.slice(-4)}`;
      if (tradable) { prune(); PENDING.set(rfq.requestId, { message: Uint8Array.from(rfq.message), wallet: taker, expireAt: rfq.expireAt, usd, summary }); }
      emit({ stage: 'trade', tradable, summary, requestId: rfq.requestId, expireAt: rfq.expireAt, transaction: tradable ? Buffer.from(rfq.tx).toString('base64') : undefined,
        why: tradable ? undefined : !x.verdict.ok ? (gasNote ? `The gate refused this transaction. ${gasNote}` : 'The gate refused this transaction') : sim.ok !== true ? 'The simulation did not pass' : !priceOk ? `The fill fails the share-price check (${sh!.why})` : `This desk executes at most $${MAX_USD.toLocaleString('en-US')} per trade (RFQ_DESK_MAX_USD)` });
    }
  } else emit({ stage: 'decision', useRfq: false, reasons: [{ ok: false, text: `No RFQ quote: ${rfq.none}` }] });
  // after the decision, so these extra quotes never eat into the firm quote's short life
  const vs = await venueQuotes(inMint, outMint, amount).catch(() => []);
  if (vs.length) emit({ stage: 'venues', venues: vs.map(v => ('out' in v && v.out ? { ...v, share: share(BigInt(v.out)) } : v)) });
  // when the maker's quote is behind our route, find how much it fills at market and what a split would give (price-only, nothing is signed)
  if (!('none' in rfq) && !('error' in build) && rfq.outAmount < build.outAmount) {
    emit({ stage: 'capacity', pending: true });
    const ourRoute = { full: build.outAmount, route: async (a: bigint) => (await jup(() => fetchBuild({ ...cfg, inputMint: inMint, outputMint: outMint, amount: a, taker, slippageBps: 50 }))).outAmount };
    const c = await makerCapacity(inMint, outMint, amount, ourRoute).catch(e => ({ error: (e as Error).message }));
    emit({ stage: 'capacity', marginBps, ...c, ...('split' in c && c.split ? { share: share(BigInt(c.split.total)) } : {}) });
  }
  emit({ stage: 'done' });
}

/** More venues for the Routes table, quote-only (no taker, nothing to sign): each of Jupiter's /order routers on its own, and Jupiter's quote restricted to one DEX at a
 *  time. They are prices to compare against, not routes this desk or the engine can trade. Labels as Jupiter's GET /swap/v1/program-id-to-label lists them (checked 2026-11-18). */
const ROUTERS = [{ id: 'metis', name: 'Metis' }, { id: 'okx', name: 'OKX' }, { id: 'dflow', name: 'DFlow' }];
// kept to four: with Kipseli, BisonFi and Manifest as well, one request made more Jupiter calls than the key allows per second and those three came back 429 (2026-11-18)
const DEXES = ['Whirlpool', 'Raydium CLMM', 'Meteora DLMM', 'HumidiFi'];
async function venueQuotes(inputMint: string, outputMint: string, amount: bigint) {
  const hdr = API_KEY ? { 'x-api-key': API_KEY } : {}, all = [...ROUTERS.map(r => r.id), 'jupiterz'];
  // paced like every Jupiter call here; a 429 (the key's per-second limit, hit when ten quotes go out together) is asked again after a pause, twice at most
  const get = async (u: string) => { for (let a = 0; ; a++) { const x = await jup(async () => { const r = await fetch(u, { headers: hdr, signal: AbortSignal.timeout(15_000) }); return { status: r.status, j: (await r.json().catch(() => ({}))) as any }; });
    if (x.status !== 429 || a >= 2) return x; await new Promise(r => setTimeout(r, 1200 * (a + 1))); } };
  const viaRouter = ROUTERS.map(async r => {
    const { status, j } = await get(`https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&excludeRouters=${all.filter(x => x !== r.id).join(',')}`);
    return j?.outAmount && j.router === r.id ? { id: r.id, name: r.name, kind: 'router', out: String(j.outAmount), labels: (j.routePlan ?? []).map((p: any) => String(p?.swapInfo?.label ?? '?')), ...costs(j) }
      : { id: r.id, name: r.name, kind: 'router', none: j?.error ? String(j.error).slice(0, 80) : j?.router ? `answered by ${j.router}` : `no quote (HTTP ${status})` };
  });
  const viaDex = DEXES.map(async d => {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: '50', dexes: d, restrictIntermediateTokens: 'true' });
    const { status, j } = await get(`${API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag'}/swap/v1/quote?${q}`);
    return j?.outAmount ? { id: 'dex-' + d.toLowerCase().replace(/\W+/g, '-'), name: `${d} only`, kind: 'dex', out: String(j.outAmount), labels: (j.routePlan ?? []).map((p: any) => String(p?.swapInfo?.label ?? '?')), ...costs({ ...j, feeBps: j.platformFee?.feeBps ?? 0 }) }
      : { id: 'dex-' + d.toLowerCase().replace(/\W+/g, '-'), name: `${d} only`, kind: 'dex', none: j?.error ? String(j.error).slice(0, 80) : `no route (HTTP ${status})` };
  });
  // venues asked directly, not through Jupiter: Raydium's own Trade API (keyless; GET transaction-v1.raydium.io/compute/swap-base-in, answered 2026-11-18).
  // DFlow's and OKX's own APIs answered 403 and 401 without a key, so they appear only through Jupiter above.
  const raydium = (async () => {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: '50', txVersion: 'V0' });
    try { const r = await fetch(`https://transaction-v1.raydium.io/compute/swap-base-in?${q}`, { signal: AbortSignal.timeout(15_000) }); const j: any = await r.json().catch(() => ({}));
      const d = j?.data; return j?.success && d?.outputAmount && d.inputMint === inputMint && d.outputMint === outputMint && String(d.inputAmount) === String(amount)
        ? { id: 'raydium-api', name: 'Raydium (own API)', kind: 'direct', out: String(d.outputAmount), labels: [`${(d.routePlan ?? []).length || 1} Raydium pool${(d.routePlan ?? []).length > 1 ? 's' : ''}`], ...costs({ priceImpactPct: d.priceImpactPct === undefined ? undefined : Number(d.priceImpactPct) / 100, slippageBps: d.slippageBps, feeBps: 0 }) }
        : { id: 'raydium-api', name: 'Raydium (own API)', kind: 'direct', none: String(j?.msg ?? `no route (HTTP ${r.status})`).slice(0, 80) }; }
    catch (e) { return { id: 'raydium-api', name: 'Raydium (own API)', kind: 'direct', none: (e as Error).message.slice(0, 80) }; }
  })();
  // DFlow's own Trading API: GET /order without userPublicKey returns a quote only (inputMint, inAmount, outputMint, outAmount: https://pond.dflow.net/resources/trading-api/order/order).
  // With DFLOW_API_KEY: the production host and x-api-key; without: the rate-limited developer host (https://pond.dflow.net/get-started/endpoints), which timed out (504) on 2026-11-18.
  const dflow = (async () => {
    const k = process.env.DFLOW_API_KEY?.trim(), host = k ? 'https://quote-api.dflow.net' : 'https://dev-quote-api.dflow.net', name = `DFlow (own API${k ? '' : ', developer host'})`;
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: '50' });
    try { const r = await fetch(`${host}/order?${q}`, { headers: k ? { 'x-api-key': k } : {}, signal: AbortSignal.timeout(12_000) }); const j: any = await r.json().catch(() => ({}));
      return r.ok && /^\d+$/.test(String(j?.outAmount ?? '')) && j.inputMint === inputMint && j.outputMint === outputMint && String(j.inAmount) === String(amount)
        ? { id: 'dflow-api', name, kind: 'direct', out: String(j.outAmount), labels: (j.routePlan ?? []).map((p: any) => String(p?.venue ?? p?.label ?? '?')).slice(0, 6), ...costs({ priceImpactPct: j.priceImpactPct, slippageBps: j.slippageBps, feeBps: j.platformFee?.feeBps ?? 0 }) }
        : { id: 'dflow-api', name, kind: 'direct', none: String(j?.msg ?? j?.error ?? `no quote (HTTP ${r.status})`).slice(0, 80) }; }
    catch (e) { return { id: 'dflow-api', name, kind: 'direct', none: (e as Error).name === 'TimeoutError' ? 'no answer within 12 s' : (e as Error).message.slice(0, 80) }; }
  })();
  return Promise.all([...viaRouter, ...viaDex, raydium, dflow]);
}

/* ---------------- EVM chains: tokenized stocks, price-only comparison of EVM aggregators ---------------- */
// Read-only quotes for buying a stock token with the native coin, or selling it for the native coin, on Base (Coinbase stocks), BNB Chain (bStocks) and Robinhood Chain
// (Robinhood stock tokens). Relay, KyberSwap, LI.FI and OpenOcean all answered keyless on 2026-11-19 on these chains, except Relay on Robinhood Chain ("Unsupported
// currency" for its stock tokens). Each answer is checked for the same token and amount before it is shown. Relay and LI.FI need a sender for a quote: a busy public
// wallet on that chain is used (nothing is signed or sent). The execution server trades through Relay (Base) or KyberSwap (BASE_AGGREGATOR, Robinhood's default);
// BNB stocks are not wired there (docs/XSTOCKS.md). The share multiplier is read on chain (uiMultiplier(); 1 where the token has none, as Coinbase's B20 tokens).
const alchemy = (net: string) => (process.env.ALCHEMY_API_KEY ? `https://${net}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : undefined);
const EVM_DESK: Record<string, { label: string; chainId: number; native: string; rpc: string; kyber: string; taker: string; stocks: Record<string, string>; ticker: (s: string) => string; net: string; serverRoute: string }> = {
  base: { label: 'Base', chainId: 8453, native: 'ETH', rpc: process.env.BASE_RPC_URL?.trim() || alchemy('base-mainnet') || 'https://mainnet.base.org', kyber: 'base', taker: '0x43f3c1c1da83dd6a541a98a7914e3791e39aac85',
    stocks: BASE_STOCKS, ticker: s => s.replace(/c$/, ''), net: 'base', serverRoute: 'Relay by default, or KyberSwap with BASE_AGGREGATOR=kyberswap' },
  bnb: { label: 'BNB Chain', chainId: 56, native: 'BNB', rpc: process.env.BNB_RPC_URL?.trim() || alchemy('bnb-mainnet') || 'https://bsc-dataseed.bnbchain.org', kyber: 'bsc', taker: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
    stocks: BNB_STOCKS, ticker: s => s.replace(/B$/, ''), net: 'bnb', serverRoute: 'not wired: the server trades BNB tokens only through their PancakeSwap V2 pool, which is thin for these' },
  robinhood: { label: 'Robinhood Chain', chainId: 4663, native: 'ETH', rpc: process.env.ROBINHOOD_RPC_URL?.trim() || alchemy('robinhood-mainnet') || 'https://rpc.mainnet.chain.robinhood.com', kyber: 'robinhood', taker: '0x43f3c1c1da83dd6a541a98a7914e3791e39aac85',
    stocks: ROBINHOOD_STOCKS, ticker: s => s, net: 'robinhood', serverRoute: 'KyberSwap (ROBINHOOD_AGGREGATOR default)' },
};
const EEE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', ZERO = '0x0000000000000000000000000000000000000000', UI_MULT = '0xa60bf13d';
const evmRt = new Map<string, { rpc: EvmJsonRpc; usd: () => Promise<{ price: number } | null>; relay: RelayClient }>(), tokenInfo = new Map<string, { decimals: number; mult: { v: string; at: number } }>();
const rt = (id: string) => { let r = evmRt.get(id); if (!r) { const c = EVM_DESK[id], rpc = new EvmJsonRpc(c.rpc); r = { rpc, usd: baseEthUsd(rpc, 30_000, EVM_NETWORKS[c.net]), relay: new RelayClient({ chainId: c.chainId, apiKey: process.env.RELAY_API_KEY?.trim(), retries429: 1 }) }; evmRt.set(id, r); } return r; };
async function evmToken(id: string, token: string) {
  const k = `${id}:${token}`, hit = tokenInfo.get(k); if (hit && Date.now() - hit.mult.at < 60_000) return hit;
  const { rpc } = rt(id), decimals = hit?.decimals ?? Number(BigInt(await rpc.call<string>('eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])));
  const m = await rpc.call<string>('eth_call', [{ to: token, data: UI_MULT }, 'latest']).then(x => BigInt(x)).catch(() => 0n);
  const v = m > 0n ? `${m / 10n ** 18n}.${(m % 10n ** 18n).toString().padStart(18, '0')}` : '1', info = { decimals, mult: { v, at: Date.now() } }; tokenInfo.set(k, info); return info;
}
/** POST /api/evm/quote {chain, symbol, side: 'buy'|'sell', amount}: amount is in the native coin for a buy, in stock tokens for a sell (whole units). */
async function evmQuote(body: any) {
  const id = String(body.chain ?? 'base'), c = EVM_DESK[id]; if (!c) throw new Error(`unknown chain ${id}: one of ${Object.keys(EVM_DESK).join(', ')}`);
  const symbol = String(body.symbol ?? ''), token = c.stocks[symbol]; if (!token) throw new Error(`unknown ${c.label} stock ${symbol}`);
  const side = body.side === 'sell' ? 'sell' : 'buy', units = Number(body.amount ?? body.eth); if (!(units > 0 && units <= 1e7)) throw new Error('enter an amount above zero');
  const t = token.toLowerCase(), info = await evmToken(id, token), { usd } = rt(id);
  const decIn = side === 'buy' ? 18 : info.decimals, amount = BigInt(Math.round(units * 1e9)) * 10n ** BigInt(decIn) / 1_000_000_000n;
  const [tin, tout] = side === 'buy' ? [EEE, token] : [token, EEE], nativeUsd = await usd().then(x => x?.price ?? null).catch(() => null);
  const json = async (u: string, init?: RequestInit) => { const r = await fetch(u, { ...init, signal: AbortSignal.timeout(20_000) }); return { status: r.status, j: (await r.json().catch(() => ({}))) as any }; };
  // each venue's costs, as it reports them: feeBps/feeUsd (the aggregator's own fee; pool fees are inside the output), gasUsd (network), impactPct (percent; negative is
  // worse; Relay's and OpenOcean's own figure, else the dollar value out against in, which includes the fee), slippageBps (the tolerance its transaction would carry;
  // undefined where it is chosen when the swap is built)
  type Costs = { feeBps?: number; feeUsd?: number; gasUsd?: number; impactPct?: number; impactFrom?: string; slippageBps?: number; slippageNote?: string };
  const num = (x: any) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));
  const usdImpact = (inUsd: any, outUsd: any) => { const i = num(inUsd), o = num(outUsd); return i && o ? (o / i - 1) * 100 : undefined; };
  // the stock side of each answer must be this token, and the input this amount
  const stockOk = (a?: string, b?: string) => String(side === 'buy' ? b : a).toLowerCase() === t;
  // each venue as a function of the input, so it can be asked at this size and at 1% of it (see below)
  const fns: [string, (amount: bigint) => Promise<{ out: string; path: string } & Costs>][] = [
    ['Relay', async (amount: bigint) => {
      // Relay serves Robinhood Chain but not its stock tokens ("Unsupported currency", checked 2026-11-19): said plainly instead of asking
      if (id === 'robinhood') throw new Error(`Relay does not quote Robinhood Chain's stock tokens (it answers "Unsupported currency"); the server trades them through KyberSwap`);
      const key = process.env.RELAY_API_KEY?.trim(), { status, j } = await json('https://api.relay.link/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
        body: JSON.stringify({ user: c.taker, recipient: c.taker, originChainId: c.chainId, destinationChainId: c.chainId, originCurrency: side === 'buy' ? ZERO : t, destinationCurrency: side === 'buy' ? t : ZERO, amount: String(amount), tradeType: 'EXACT_INPUT' }) });
      const d = j?.details; if (!d?.currencyOut?.amount || !stockOk(d.currencyIn?.currency?.address, d.currencyOut?.currency?.address) || String(d.currencyIn?.amount) !== String(amount)) throw new Error(j?.message ? `Relay quote failed: HTTP ${status}: ${j.message}` : `no route (HTTP ${status})`);
      const inUsd = num(d.currencyIn?.amountUsd), feeUsd = num(j.fees?.relayer?.amountUsd);
      return { out: String(d.currencyOut.amount), path: 'Relay same-chain swap', feeUsd, feeBps: feeUsd !== undefined && inUsd ? feeUsd / inUsd * 1e4 : undefined, gasUsd: num(j.fees?.gas?.amountUsd),
        impactPct: num(d.totalImpact?.percent), impactFrom: 'Relay totalImpact (fees included)', slippageBps: num(d.slippageTolerance?.origin?.percent) !== undefined ? Number(d.slippageTolerance.origin.percent) * 100 : undefined };
    }],
    ['KyberSwap', async (amount: bigint) => { const { status, j } = await json(`https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amount}`, { headers: { 'x-client-id': 'memedesk' } });
      const r = j?.data?.routeSummary; if (!r || !stockOk(r.tokenIn, r.tokenOut) || String(r.amountIn) !== String(amount)) throw new Error(j?.message ?? `no route (HTTP ${status})`);
      const extra = num(r.extraFee?.feeAmount);
      return { out: String(r.amountOut), path: [...new Set((r.route ?? []).flat().map((x: any) => String(x?.exchange ?? '?')))].join(', '), feeBps: extra ? undefined : 0, gasUsd: (num(r.gasUsd) ?? 0) + (num(r.l1FeeUsd) ?? 0) || undefined,
        impactPct: usdImpact(r.amountInUsd, r.amountOutUsd), impactFrom: 'KyberSwap amountOutUsd against amountInUsd', slippageNote: 'set when the swap is built' }; }],
    ['LI.FI', async (amount: bigint) => { const { status, j } = await json(`https://li.quest/v1/quote?fromChain=${c.chainId}&toChain=${c.chainId}&fromToken=${side === 'buy' ? ZERO : token}&toToken=${side === 'buy' ? token : ZERO}&fromAmount=${amount}&fromAddress=${c.taker}`);
      if (!j?.estimate?.toAmount || !stockOk(j.action?.fromToken?.address, j.action?.toToken?.address) || String(j.action?.fromAmount) !== String(amount)) throw new Error(j?.message ?? `no route (HTTP ${status})`);
      const e = j.estimate, fees = (e.feeCosts ?? []).filter((f: any) => f?.included !== false), pct = fees.reduce((a: number, f: any) => a + (num(f.percentage) ?? 0), 0);
      return { out: String(e.toAmount), path: (j.includedSteps ?? []).map((s: any) => String(s?.toolDetails?.name ?? s?.tool ?? '?')).join(', ') || String(j.tool ?? ''), feeBps: fees.length ? pct * 1e4 : 0,
        feeUsd: fees.length ? fees.reduce((a: number, f: any) => a + (num(f.amountUSD) ?? 0), 0) : undefined, gasUsd: (e.gasCosts ?? []).reduce((a: number, g: any) => a + (num(g.amountUSD) ?? 0), 0) || undefined,
        impactPct: usdImpact(e.fromAmountUSD, e.toAmountUSD), impactFrom: 'LI.FI toAmountUSD against fromAmountUSD (fee included)', slippageBps: num(j.action?.slippage) !== undefined ? Number(j.action.slippage) * 1e4 : undefined }; }],
    ['OpenOcean', async (amount: bigint) => { const { status, j } = await json(`https://open-api.openocean.finance/v4/${c.chainId}/quote?inTokenAddress=${tin}&outTokenAddress=${tout}&amountDecimals=${amount}&gasPriceDecimals=1000000000`);
      const d = j?.data; if (!d?.outAmount || !stockOk(d.inToken?.address, d.outToken?.address) || String(d.inAmount) !== String(amount)) throw new Error(j?.message ?? j?.error ?? `no route (HTTP ${status})`);
      return { out: String(d.outAmount), path: (d.dexes ?? []).filter((x: any) => x?.swapAmount && x.swapAmount !== '0').map((x: any) => String(x.dexCode)).slice(0, 4).join(', '), feeBps: 0,
        impactPct: num(String(d.price_impact ?? '').replace('%', '')), impactFrom: 'OpenOcean price_impact', slippageNote: 'set when the swap is built' }; }],
  ];
  // Impact is computed the same way for every venue: its price at this size against its own price at 1% of it. A venue's own figure is not comparable across venues
  // (KyberSwap's dollar values on Robinhood Chain priced TSLA below its share price, so 10 ETH showed 5.86% "impact" against OpenOcean's 0.47% for the same output,
  // 2026-11-19); it is kept as venueImpactPct for the tooltip. Fees that do not scale with size (a fixed relayer fee, gas) count in the small quote too.
  const small = amount / 100n > 0n ? amount / 100n : amount;
  const venues = await Promise.all(fns.map(async ([name, f]) => {
    const [big, ref] = await Promise.all([f(amount).then(x => ({ ok: x }), e => ({ err: String((e as Error).message).slice(0, 140) })), f(small).catch(() => undefined)]);
    if ('err' in big) return { name, none: big.err };
    const v = big.ok, rate = (o: string, a: bigint) => Number(o) / Number(a), imp = ref && Number(ref.out) > 0 ? (rate(v.out, amount) / rate(ref.out, small) - 1) * 100 : undefined;
    return { name, ...v, venueImpactPct: v.impactPct, venueImpactFrom: v.impactFrom, impactPct: imp, impactFrom: imp === undefined ? 'no quote at 1% of this size to compare with' : `its own price for this size against its price for 1% of it (${String(small)} raw in)` };
  }));
  // reference share price: Jupiter's stockData.price for a Solana stock of the same ticker (NVDAc, NVDAB and Robinhood NVDA -> NVDA -> NVDAx)
  const ticker = c.ticker(symbol), sol = STOCKS.find(s => s.underlying === ticker), refUsd = sol ? (await prices.get([sol.mint]).catch(() => new Map())).get(sol.mint)?.stockPrice ?? null : null;
  return { chain: id, label: c.label, native: c.native, side, symbol, ticker, token, decimals: info.decimals, multiplier: info.mult.v, units, amount: String(amount), nativeUsd, refUsd, serverRoute: c.serverRoute,
    rpc: c.rpc.includes('alchemy') ? 'Alchemy' : 'public RPC', venues };
}

/* ---------------- Liquidity: every public pool that holds the token, on any of the four chains ---------------- */
// DexScreener's keyless GET /token-pairs/v1/{chain}/{token} (checked 2026-11-19 on solana, base, bsc and robinhood): each pool with its DEX, pair and USD liquidity.
// Its liquidity is the whole pool's value (both sides), for at most 30 pools. Market makers (JupiterZ) and prop AMMs that keep no public pool are not in it; the
// desk's maker-capacity search and the size ladder show those.
const DS_CHAIN: Record<string, string> = { solana: 'solana', base: 'base', bnb: 'bsc', robinhood: 'robinhood' };
const liqCache = new Map<string, { at: number; v: unknown }>();
async function liquidity(chain: string, token: string) {
  const c = DS_CHAIN[chain]; if (!c) throw new Error(`unknown chain ${chain}: one of ${Object.keys(DS_CHAIN).join(', ')}`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('not a token address');
  const k = `${c}:${token.toLowerCase()}`, hit = liqCache.get(k); if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${c}/${token}`, { signal: AbortSignal.timeout(15_000) }), j: any = await r.json().catch(() => null);
  if (!Array.isArray(j)) throw new Error(`DexScreener answered HTTP ${r.status}`);
  const lc = token.toLowerCase(), pools = j.filter((p: any) => String(p?.baseToken?.address).toLowerCase() === lc || String(p?.quoteToken?.address).toLowerCase() === lc)
    .map((p: any) => ({ dex: [String(p.dexId ?? '?'), ...(p.labels ?? [])].join(' '), pair: `${p.baseToken?.symbol ?? '?'} / ${p.quoteToken?.symbol ?? '?'}`, usd: Number(p.liquidity?.usd ?? 0), address: String(p.pairAddress ?? ''), url: String(p.url ?? '') }))
    .sort((a: any, b: any) => b.usd - a.usd);
  const byDex = new Map<string, { dex: string; usd: number; pools: number }>();
  for (const p of pools) { const d = byDex.get(p.dex) ?? { dex: p.dex, usd: 0, pools: 0 }; d.usd += p.usd; d.pools++; byDex.set(p.dex, d); }
  const v = { chain, token, source: 'DexScreener', total: pools.reduce((a: number, p: any) => a + p.usd, 0), count: pools.length, capped: j.length >= 30, byDex: [...byDex.values()].sort((a, b) => b.usd - a.usd), pools: pools.slice(0, 12) };
  liqCache.set(k, { at: Date.now(), v }); return v;
}

/** A quote-only /order (no taker: price only, no transaction), for the size ladder. `routers` excludes the others. */
async function priceOnly(inputMint: string, outputMint: string, amount: bigint, exclude: string) {
  const u = `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&excludeRouters=${exclude}`;
  const j: any = await jup(async () => (await fetch(u, { headers: API_KEY ? { 'x-api-key': API_KEY } : {}, signal: AbortSignal.timeout(15_000) })).json()).catch(e => ({ error: (e as Error).message }));
  return j?.outAmount && (exclude !== JUPITERZ.others || j.router === 'jupiterz') ? { out: String(j.outAmount), router: String(j.router ?? '?') } : { none: String(j?.error ?? `won by ${j?.router}`) };
}
/** How much a JupiterZ maker fills at market for this buy, and the split it suggests. A maker that runs out of inventory keeps quoting its last few shares for any larger
 *  input (SPCXx on 2026-11-19: about 353 shares for $100k and for $250k, at market up to about $50k), so its per-share price jumps past that size. Binary search on the
 *  input: a size is "at market" when the maker's price-only /order pays at least what Jupiter's best other router pays for the same size. Price-only, about 14 paced
 *  Jupiter calls; nothing is built or signed. `split`: the largest at-market size through the maker plus the rest through the router, against the router alone. */
async function makerCapacity(inMint: string, outMint: string, amount: bigint, our?: { full: bigint; route: (a: bigint) => Promise<bigint> }) {
  // right after the venue quotes Jupiter's per-second limit is often spent (an answer with no outAmount and no router): ask again after a pause, twice at most
  const ask = async (a: bigint, ex: string) => { let r = await priceOnly(inMint, outMint, a, ex);
    for (let i = 0; i < 2 && 'none' in r && /won by undefined|429|rate/i.test(r.none); i++) { await new Promise(ok => setTimeout(ok, 1500 * (i + 1))); r = await priceOnly(inMint, outMint, a, ex); } return r; };
  let lo = 0n, hi = amount, best: { size: bigint; rfq: bigint; route: bigint } | undefined, probes = 0, lastNone: string | undefined;
  for (let i = 0; i < 6 && (hi - lo) * 50n > amount; i++) {
    const mid = (lo + hi) / 2n, r = await ask(mid, JUPITERZ.others), o = await ask(mid, 'jupiterz'); probes++;
    if ('none' in r) lastNone = r.none;
    if ('out' in r && 'out' in o && BigInt(r.out) >= BigInt(o.out)) { lo = mid; best = { size: mid, rfq: BigInt(r.out), route: BigInt(o.out) }; } else hi = mid;
  }
  if (!best) return { probes, none: `the maker is behind the router at every size down to ${amt(hi, inMint)}${lastNone ? ` (last answer: ${lastNone})` : ''}` };
  // the rest goes through our own route (/build) when the caller gives one, so the split compares with the "Our route" row; else through Jupiter's best other router
  const restIn = amount - best.size;
  let rest: { out: string } | { none: string }, routeFull: bigint;
  if (our) { try { rest = { out: String(restIn > 0n ? await our.route(restIn) : 0n) }; } catch (e) { rest = { none: (e as Error).message }; } routeFull = our.full; }
  else { const full = await ask(amount, 'jupiterz'); if (!('out' in full)) return { probes, none: `no router price for the whole amount: ${full.none}` }; routeFull = BigInt(full.out); rest = restIn > 0n ? await ask(restIn, 'jupiterz') : { out: '0' }; }
  if (!('out' in rest)) return { probes, none: `no route price for the rest (${amt(restIn, inMint)}): ${rest.none}` };
  const total = best.rfq + BigInt(rest.out);
  return { probes, capacity: { in: String(best.size), out: String(best.rfq), routeOut: String(best.route), edgeBps: Number((best.rfq - best.route) * 10_000n / best.route), upTo: String(hi) },
    split: { makerIn: String(best.size), makerOut: String(best.rfq), restIn: String(restIn), restOut: rest.out, total: String(total), routeFull: String(routeFull), restVia: our ? 'our route (/build)' : 'best other router', gainBps: Number((total - routeFull) * 10_000n / routeFull) } };
}
/** POST /api/ladder: one rung of the benchmark, buy (pay asset in, `usd` worth) or sell (stock in, `usd` worth at the token price, pay asset out). The page walks the rungs. */
async function ladder(body: any) {
  const mint = String(body.mint), side = body.side === 'sell' ? 'sell' : 'buy', payMint = body.pay === 'USDC' ? USDC : WSOL, usd = Number(body.usd); if (!(usd > 0)) throw new Error('usd must be positive');
  const sol = await solPrice();
  let amount: bigint;
  if (side === 'buy') amount = payMint === WSOL ? BigInt(Math.round(usd / sol * 1e9)) : BigInt(Math.round(usd * 1e6));
  else { const ps = await perShare(mint, sol); const usdPer = (await prices.get([mint])).get(mint)?.usdPrice ?? (ps.ref ? ps.ref * Number(ps.multiplier) : 0); if (!usdPer) throw new Error('no token price to size a sell'); amount = BigInt(Math.round(usd / usdPer * 10 ** ps.decimals)); }
  const [i, o] = side === 'buy' ? [payMint, mint] : [mint, payMint];
  const rfq = await priceOnly(i, o, amount, JUPITERZ.others), other = await priceOnly(i, o, amount, 'jupiterz');
  return { side, pay: sym(payMint), outDecimals: decOf(o), usd, amount: String(amount), rfq, other };
}

/** POST /api/gate: the gate on any /order transaction (pasted), or on the recorded one with a chosen tampering. */
const TAMPER: Record<string, { label: string; apply: (ixs: any[]) => void }> = {
  none: { label: 'As recorded', apply: () => {} },
  amount: { label: 'Fill takes 1 lamport more', apply: ixs => { const f = ixs.find(i => i.programId === JUPITERZ.orderEngine); const d = Uint8Array.from(f.data); const v = new DataView(d.buffer); v.setBigUint64(8, v.getBigUint64(8, true) + 1n, true); f.data = d; } },
  redirect: { label: 'Output paid to the maker', apply: ixs => { const f = ixs.find(i => i.programId === JUPITERZ.orderEngine); f.accounts[4] = { pubkey: ataAddress(FIXTURE.maker, FIXTURE.outputMint, PROGRAMS.token2022), isSigner: false, isWritable: true }; } },
  drain: { label: 'Extra SOL transfer from you', apply: ixs => { ixs.splice(2, 0, { programId: PROGRAMS.system, data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0), accounts: [{ pubkey: FIXTURE.taker, isSigner: true, isWritable: true }, { pubkey: FIXTURE.maker, isSigner: false, isWritable: true }] }); } },
  signer: { label: 'A third signer', apply: ixs => { const f = ixs.find(i => i.programId === JUPITERZ.orderEngine); f.accounts.push({ pubkey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', isSigner: true, isWritable: false }); } },
};
async function gate(body: any) {
  const { compileV0, unsignedV0 } = await import('../../packages/sol/src/jupiterswap.ts');
  if (body.transaction) {
    const w = Uint8Array.from(Buffer.from(String(body.transaction).trim(), 'base64'));
    // a pasted quote is checked as of now; `asOfQuote` checks it as of 30 s before its own expiry (for transactions saved earlier)
    let nowSec: number | undefined; if (body.asOfQuote) { const f = resolveMessage(parseMessage(splitWire(w).message), []).find(i => i.programId === JUPITERZ.orderEngine); if (f) nowSec = decodeFill(f.data).expireAt - 30; }
    return { source: 'pasted', ...(await xray(w, { nowSec })) };
  }
  const t = TAMPER[String(body.tamper ?? 'none')] ?? TAMPER.none, w0 = Uint8Array.from(Buffer.from(FIXTURE.transaction, 'base64'));
  const ixs = resolveMessage(parseMessage(splitWire(w0).message), []); t.apply(ixs);
  const w = body.tamper && body.tamper !== 'none' ? unsignedV0(compileV0(FIXTURE.maker, ixs, new Uint8Array(32).fill(7), [])) : w0;
  // the recorded quote has expired: it is checked as of 30 s before its expiry
  return { source: 'recorded', tamper: t.label, recordedAt: '2026-11-18 12:35 UTC', ...(await xray(w, { wallet: FIXTURE.taker, maker: FIXTURE.maker, inMint: WSOL, outMint: FIXTURE.outputMint, amountIn: BigInt(FIXTURE.inAmount), minOut: BigInt(FIXTURE.outAmount), nowSec: Number(FIXTURE.expireAt) - 30 })) };
}

/** POST /api/execute {requestId, signedTransaction}: forwards to Jupiter /execute only what this server gated for that wallet, unchanged, signed by that wallet, once. */
async function execute(body: any) {
  const id = String(body.requestId ?? ''), p = PENDING.get(id);
  if (!p) return { ok: false, error: 'This quote is not one the desk checked for your wallet, or it has expired. Request quotes again.' };
  if (p.executed) return { ok: true, repeated: true, ...(p.executed.result as object) };
  if (Date.now() / 1000 >= p.expireAt) return { ok: false, error: 'The quote expired before it was signed. Request quotes again.' };
  let signed: Uint8Array; try { signed = Uint8Array.from(Buffer.from(String(body.signedTransaction ?? ''), 'base64')); } catch { return { ok: false, error: 'The signed transaction is not base64.' }; }
  let w: ReturnType<typeof splitWire>; try { w = splitWire(signed); } catch { return { ok: false, error: 'The signed transaction could not be read. Nothing was sent.' }; }
  const same = w.message.length === p.message.length && w.message.every((b, i) => b === p.message[i]);
  if (!same) return { ok: false, error: 'The wallet returned a different transaction from the one the desk checked. Nothing was sent.' };
  if (w.sigs.length !== 2 || w.sigs[0].some(b => b !== 0)) return { ok: false, error: 'The maker signature slot is not empty. Nothing was sent.' };
  if (!verifySignature(p.wallet, w.message, w.sigs[1])) return { ok: false, error: 'Your wallet signature does not verify for this transaction. Nothing was sent.' };
  if (p.usd > MAX_USD) return { ok: false, error: `Above the desk cap of $${MAX_USD}. Nothing was sent.` };
  p.executed = { at: Date.now(), result: { status: 'Sending' } };   // claimed before the network call: a second click never sends again
  let r; try { r = await executeRfq({ apiKey: API_KEY, timeoutMs: 60_000 }, Buffer.from(signed).toString('base64'), id); }
  catch (e) { const result = { status: 'Unknown', error: `Jupiter did not answer (${(e as Error).message}). It may still land until the quote expires: check the status.`, userSignature: base58(w.sigs[1]) }; p.executed.result = result; return { ok: true, ...result }; }
  const result = { status: r.status, code: r.code, signature: r.signature, error: r.error, totalInputAmount: r.totalInputAmount, totalOutputAmount: r.totalOutputAmount, userSignature: base58(w.sigs[1]), summary: p.summary };
  p.executed.result = result; return { ok: true, ...result };
}
/** GET /api/status?sig=: the chain's status for a landed signature. */
async function status(sig: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return { found: false, error: 'not a signature' };
  const r: any = await rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]); const v = r?.value?.[0];
  return v ? { found: true, confirmation: v.confirmationStatus ?? null, err: v.err ?? null, slot: v.slot } : { found: false };
}

const STOCKS = STOCKS_SOLANA.filter(a => a.market.tradable).sort((a, b) => (b.market.liquidityUsd ?? 0) - (a.market.liquidityUsd ?? 0)).map(a => ({ symbol: a.symbol, mint: a.mint, issuer: a.issuer, underlying: (a as any).underlying ?? a.symbol, liquidityUsd: a.market.liquidityUsd, decimals: a.decimals }));
const json = (res: http.ServerResponse, code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v))); };
const readBody = (req: http.IncomingMessage) => new Promise<any>((ok, bad) => { let s = ''; req.on('data', c => { s += c; if (s.length > 200_000) bad(new Error('body too large')); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('the request body is not JSON')); } }); });

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    // Privy reads the page's opener policy with a HEAD request; same-origin-allow-popups lets wallet and social-login pop-ups talk back to the page
    if ((req.method === 'GET' || req.method === 'HEAD') && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin-allow-popups' }); res.end(req.method === 'HEAD' ? undefined : html()); return; }
    if (req.method === 'GET' && u.pathname === '/privy.bundle.js') { if (!existsSync(PRIVY_BUNDLE)) return json(res, 404, { error: 'Privy bundle not built: npm run build:privy' }); res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(PRIVY_BUNDLE)); return; }
    if (req.method === 'POST' && u.pathname === '/api/sol/rpc') {
      const body = await readBody(req), one = (b: any) => b && typeof b.method === 'string' && RPC_OK.has(b.method);
      if (Array.isArray(body) ? !body.every(one) : !one(body)) return json(res, 403, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed by this relay' } });
      try { const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
      catch { json(res, 502, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32000, message: 'RPC unreachable' } }); }
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/config') return json(res, 200, { privyAppId: PRIVY_APP_ID, privyBundle: existsSync(PRIVY_BUNDLE), maxUsd: MAX_USD, solUsd: await solPrice().catch(() => null), rpc: rpcKind, keyed: !!API_KEY, defaultTaker: DEFAULT_TAKER, orderEngine: JUPITERZ.orderEngine, stocks: STOCKS, baseStocks: Object.keys(BASE_STOCKS), evmStocks: Object.fromEntries(Object.entries(EVM_DESK).map(([k, v]) => [k, { label: v.label, native: v.native, symbols: Object.keys(v.stocks) }])), tamper: Object.entries(TAMPER).map(([id, t]) => ({ id, label: t.label })) });
    if (req.method === 'POST' && u.pathname === '/api/quote') {
      const body = await readBody(req); res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const emit = (o: unknown) => res.write(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n');
      try { await quote(body, emit); } catch (e) { emit({ stage: 'error', error: (e as Error).message }); } res.end(); return;
    }
    if (req.method === 'POST' && (u.pathname === '/api/evm/quote' || u.pathname === '/api/base/quote')) return json(res, 200, await evmQuote(await readBody(req)));
    if (req.method === 'GET' && u.pathname === '/api/liquidity') return json(res, 200, await liquidity(String(u.searchParams.get('chain') ?? ''), String(u.searchParams.get('token') ?? '')));
    if (req.method === 'GET' && u.pathname === '/api/token-price') return json(res, 200, { usd: await tokenUsd(String(u.searchParams.get('mint') ?? ''), await solPrice()).catch(() => null) });
    if (req.method === 'POST' && u.pathname === '/api/ladder') return json(res, 200, await ladder(await readBody(req)));
    if (req.method === 'POST' && u.pathname === '/api/gate') return json(res, 200, await gate(await readBody(req)));
    if (req.method === 'POST' && u.pathname === '/api/execute') return json(res, 200, await execute(await readBody(req)));
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, await status(String(u.searchParams.get('sig') ?? '')));
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 400, { error: (e as Error).message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`RFQ Desk on http://127.0.0.1:${PORT} (desk never signs; trades only from a connected wallet, max $${MAX_USD}; node: ${rpcKind}${skipped.length ? ` after skipping ${skipped.join('; ')}` : ''}; Jupiter ${API_KEY ? 'with API key' : 'keyless, paced'})`));
