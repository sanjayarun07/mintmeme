/** RFQ Desk: a standalone, READ-ONLY desk for JupiterZ market-maker quotes on Solana (docs/JUPITERZ.md).
 *  It asks Jupiter for a firm RFQ quote, the best other route and our own /build route; decodes the RFQ transaction; runs the same gate the engine runs before a wallet
 *  signs (packages/sol/src/jupiterz.ts gateRfq); simulates it against mainnet without signatures; and shows the engine's decision. The desk itself never signs.
 *  TRADING (optional): a browser wallet the user connects signs its own slot of a quote built for it; POST /api/execute forwards it to Jupiter /execute ONLY if the
 *  signed message is byte-for-byte the one this server gated and simulated for that wallet, the wallet's signature verifies, the maker slot is empty, the quote is
 *  live, and the trade is under RFQ_DESK_MAX_USD (default $1,500). Each gated order is executed at most once.
 *  Run: npm run rfq  (PORT, default 3700; SOL_RPC_URL or HELIUS_API_KEY for the node, else the public mainnet RPC; JUPITER_API_KEY optional, keyless is rate limited). */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { SolJsonRpc, STOCKS_SOLANA, stockByMint, readStockStates, checkFillPrice, JupiterStockPrices, ataAddress, PROGRAMS, findProgramAddress, pubkeyBytes } from '../../packages/sol/src/index.ts';
import { fetchBuild, parseMessage, resolveMessage, JupiterRefused } from '../../packages/sol/src/jupiterswap.ts';
import { fetchRfqOrder, gateRfq, decodeFill, splitWire, executeRfq, JUPITERZ } from '../../packages/sol/src/jupiterz.ts';
import { verifySignature } from '../../packages/sol/src/signer.ts';
import { base58 } from '../../packages/sol/src/tx.ts';
import { fetchJupiterQuote } from '../../packages/sol/src/jupiter.ts';

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

async function bestOther(inputMint: string, outputMint: string, amount: bigint) {
  const u = `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&excludeRouters=jupiterz`;
  const j: any = await jup(async () => (await fetch(u, { headers: API_KEY ? { 'x-api-key': API_KEY } : {}, signal: AbortSignal.timeout(15_000) })).json());
  if (!j?.outAmount) throw new Error(j?.error ?? 'no route');
  return { out: BigInt(j.outAmount), router: String(j.router ?? '?'), feeBps: Number(j.feeBps ?? 0), labels: (j.routePlan ?? []).map((r: any) => String(r?.swapInfo?.label ?? '?')) };
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

/** POST /api/quote: NDJSON, one line per stage as it arrives, so the desk fills in while Jupiter's rate limit paces the calls.
 *  Body: mint (the stock), pay ('SOL' or 'USDC'), amount (raw units of the pay asset; `lamports` is still accepted), minUsd (RFQ threshold), marginBps, taker (optional). */
async function quote(body: any, emit: (o: unknown) => void) {
  const mint = String(body.mint), payMint = body.pay === 'USDC' ? USDC : WSOL, amount = BigInt(body.amount ?? body.lamports), given = String(body.taker ?? '').trim();
  const marginBps = Number(body.marginBps ?? 20), minUsd = Number(body.minUsd ?? 7500), paySym = sym(payMint), payDec = decOf(payMint), forWallet = body.forWallet === true && !!given;
  if (!(amount > 0n)) throw new Error(`enter an amount of ${paySym} above zero`);
  const sol = await solPrice(), usd = payMint === WSOL ? Number(amount) / 1e9 * sol : Number(amount) / 1e6;
  let taker: string, held: bigint, lamports: bigint, auto = !given;
  if (given) {
    taker = given; lamports = BigInt((await rpc.call<any>('getBalance', [taker]).catch(() => ({ value: 0 }))).value ?? 0);
    held = payMint === WSOL ? lamports : await rpc.call<any>('getTokenAccountBalance', [ataAddress(taker, payMint)]).then(r => BigInt(r?.value?.amount ?? 0)).catch(() => 0n);
  } else { const p = await pickQuoteWallet(payMint, amount).catch(() => ({ taker: DEFAULT_TAKER, lamports: 0n, held: 0n, enough: false })); taker = p.taker; held = p.held; lamports = p.lamports; }
  const heldTxt = `${(Number(held) / 10 ** payDec).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${paySym}`;
  emit({ stage: 'context', solUsd: sol, usd, pay: paySym, taker, takerSol: Number(lamports) / 1e9, held: heldTxt, auto, rpc: rpcKind, keyed: !!API_KEY });
  const stock = stockByMint(mint), ps = stock ? await perShare(mint, sol) : undefined;
  if (stock && ps) emit({ stage: 'stock', symbol: stock.symbol, issuer: stock.issuer, decimals: ps.decimals, multiplier: ps.multiplier, paused: ps.paused, sharePrice: ps.ref });
  // per-share price: the dollars paid over the shares received (USDC is taken at $1; checkFillPrice works in lamports and a SOL price, so USDC is passed as 1e9 units of $1)
  const share = (raw: bigint) => ps ? (payMint === WSOL ? ps.check(amount, raw) : ps.checkUsd(amount * 1000n, raw)) : undefined;
  const rfq = await jup(() => fetchRfqOrder({ ...cfg, inputMint: payMint, outputMint: mint, amount, taker })).catch(e => ({ none: (e as Error).message }));
  if ('none' in rfq) emit({ stage: 'rfq', none: rfq.none });
  else emit({ stage: 'rfq', out: String(rfq.outAmount), maker: rfq.maker, expireAt: rfq.expireAt, feeBps: rfq.feeBps, requestId: rfq.requestId, share: share(rfq.outAmount) });
  const other = await bestOther(payMint, mint, amount).catch(e => ({ error: (e as Error).message }));
  emit({ stage: 'other', ...('error' in other ? other : { out: String(other.out), router: other.router, feeBps: other.feeBps, labels: other.labels, share: share(other.out) }) });
  const build = await jup(() => fetchBuild({ ...cfg, inputMint: payMint, outputMint: mint, amount, taker, slippageBps: 50 })).catch(e => ({ error: (e as Error).message }));
  emit({ stage: 'build', ...('error' in build ? build : { out: String(build.outAmount), minOut: String(build.minOut), labels: build.routeLabels, share: share(build.outAmount) }) });
  if (!('none' in rfq)) {
    const minOut = 'error' in build ? undefined : build.minOut;
    let x: Awaited<ReturnType<typeof xray>>;
    try { x = await xray(rfq.tx, { wallet: taker, maker: rfq.maker, inMint: payMint, outMint: mint, amountIn: amount, minOut }); }
    catch (e) { emit({ stage: 'decision', useRfq: false, reasons: [{ ok: false, text: `The transaction could not be checked (the node did not answer: ${(e as Error).message}), so it would not be signed` }] }); emit({ stage: 'done' }); return; }
    emit({ stage: 'xray', ...x });
    const sim = await simulate(rfq.tx, taker, payMint, mint).catch(e => ({ ok: false, error: (e as Error).message, log: [] as string[] }));
    emit({ stage: 'sim', ...sim });
    // the engine's decision, exactly as SolanaChain.tryRfq takes it (the threshold is in USD here; the engine takes it per quote asset)
    const reasons: { ok: boolean; text: string }[] = [], fmt$ = (v: number) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    reasons.push({ ok: usd >= minUsd, text: `Size ${fmt$(usd)} in ${paySym} ${usd >= minUsd ? 'meets' : 'is below'} the ${fmt$(minUsd)} threshold` });
    if (!('error' in build)) { const need = build.outAmount * BigInt(10_000 + marginBps) / 10_000n; const bps = Number((rfq.outAmount - build.outAmount) * 10_000n / build.outAmount); reasons.push({ ok: rfq.outAmount >= need, text: `RFQ pays ${bps >= 0 ? '+' : ''}${bps} bps against the /build route; the margin is ${marginBps} bps` }); reasons.push({ ok: rfq.outAmount >= build.minOut, text: `RFQ output ${rfq.outAmount >= build.minOut ? 'reaches' : 'is below'} the engine minimum` }); }
    else reasons.push({ ok: false, text: `No /build route to compare with: ${build.error}` });
    reasons.push({ ok: x.verdict.ok, text: x.verdict.ok ? 'The gate accepts the transaction' : `The gate refuses: ${x.verdict.reason}` });
    const sh = share(rfq.outAmount); if (sh) reasons.push({ ok: sh.ok, text: sh.referenceUsd ? `Share price check: $${sh.perShareUsd.toFixed(2)} per share against $${sh.referenceUsd.toFixed(2)}${sh.ok ? '' : ` (${sh.why})`}` : 'No reference share price right now, so the check is skipped' });
    if (sim.ok === false) {
      // System error 0x1 (not enough lamports) or Token error 0x1 (insufficient funds): the quote wallet cannot pay this size
      const log = (sim.log ?? []).join(' '), short_ = /(11111111111111111111111111111111|TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA) failed: custom program error: 0x1(?![0-9a-f])/.test(log);
      const frozen = /Tokenkeg\w+ failed: custom program error: 0x11(?![0-9a-f])|TokenzQd\w+ failed: custom program error: 0x11(?![0-9a-f])/.test(log);
      reasons.push({ ok: false, text: frozen ? `Simulation: a token account in this fill is frozen by its issuer (Token error 17), so it cannot move.${given ? ' If it is the quote wallet\'s, enter another wallet, or leave it empty to pick one automatically' : ''}` : short_ ? `Simulation: the quote wallet holds ${heldTxt}, less than this trade. ${auto ? `No public wallet on the list holds that much ${paySym} right now: enter a wallet that does, under Engine rules, or try a smaller size` : `Enter a wallet that holds the ${paySym}, under Engine rules, or leave it empty to pick one automatically`}` : `Simulation failed: ${sim.error}` });
    } else reasons.push({ ok: true, text: `Simulation: the wallet pays the ${paySym} amount and receives at least the minimum` });
    emit({ stage: 'decision', useRfq: reasons.every(r => r.ok), reasons });
    // a connected wallet may sign and execute THIS order: only if the gate accepted it and the simulation passed, and under the desk's size cap
    if (forWallet) {
      const tradable = x.verdict.ok && sim.ok === true && usd <= MAX_USD, outSym = sym(mint), outDec = decOf(mint);
      const summary = `Pay ${(Number(amount) / 10 ** payDec).toLocaleString('en-US', { maximumFractionDigits: payDec === 9 ? 4 : 2 })} ${paySym}, receive ${(Number(rfq.outAmount) / 10 ** outDec).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${outSym} from maker ${rfq.maker.slice(0, 4)}…${rfq.maker.slice(-4)}`;
      if (tradable) { prune(); PENDING.set(rfq.requestId, { message: Uint8Array.from(rfq.message), wallet: taker, expireAt: rfq.expireAt, usd, summary }); }
      emit({ stage: 'trade', tradable, summary, requestId: rfq.requestId, expireAt: rfq.expireAt, transaction: tradable ? Buffer.from(rfq.tx).toString('base64') : undefined,
        why: tradable ? undefined : !x.verdict.ok ? 'The gate refused this transaction' : sim.ok !== true ? 'The simulation did not pass' : `This desk executes at most $${MAX_USD.toLocaleString('en-US')} per trade (RFQ_DESK_MAX_USD)` });
    }
  } else emit({ stage: 'decision', useRfq: false, reasons: [{ ok: false, text: `No RFQ quote: ${rfq.none}` }] });
  emit({ stage: 'done' });
}

/** A quote-only /order (no taker: price only, no transaction), for the size ladder. `routers` excludes the others. */
async function priceOnly(inputMint: string, outputMint: string, amount: bigint, exclude: string) {
  const u = `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&excludeRouters=${exclude}`;
  const j: any = await jup(async () => (await fetch(u, { headers: API_KEY ? { 'x-api-key': API_KEY } : {}, signal: AbortSignal.timeout(15_000) })).json()).catch(e => ({ error: (e as Error).message }));
  return j?.outAmount && (exclude !== JUPITERZ.others || j.router === 'jupiterz') ? { out: String(j.outAmount), router: String(j.router ?? '?') } : { none: String(j?.error ?? `won by ${j?.router}`) };
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

const STOCKS = STOCKS_SOLANA.filter(a => a.market.tradable).sort((a, b) => (b.market.liquidityUsd ?? 0) - (a.market.liquidityUsd ?? 0)).map(a => ({ symbol: a.symbol, mint: a.mint, issuer: a.issuer, underlying: (a as any).underlying ?? a.symbol, liquidityUsd: a.market.liquidityUsd }));
const json = (res: http.ServerResponse, code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v))); };
const readBody = (req: http.IncomingMessage) => new Promise<any>((ok, bad) => { let s = ''; req.on('data', c => { s += c; if (s.length > 200_000) bad(new Error('body too large')); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('the request body is not JSON')); } }); });

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html()); return; }
    if (req.method === 'GET' && u.pathname === '/api/config') return json(res, 200, { maxUsd: MAX_USD, solUsd: await solPrice().catch(() => null), rpc: rpcKind, keyed: !!API_KEY, defaultTaker: DEFAULT_TAKER, orderEngine: JUPITERZ.orderEngine, stocks: STOCKS, tamper: Object.entries(TAMPER).map(([id, t]) => ({ id, label: t.label })) });
    if (req.method === 'POST' && u.pathname === '/api/quote') {
      const body = await readBody(req); res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const emit = (o: unknown) => res.write(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n');
      try { await quote(body, emit); } catch (e) { emit({ stage: 'error', error: (e as Error).message }); } res.end(); return;
    }
    if (req.method === 'POST' && u.pathname === '/api/ladder') return json(res, 200, await ladder(await readBody(req)));
    if (req.method === 'POST' && u.pathname === '/api/gate') return json(res, 200, await gate(await readBody(req)));
    if (req.method === 'POST' && u.pathname === '/api/execute') return json(res, 200, await execute(await readBody(req)));
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, await status(String(u.searchParams.get('sig') ?? '')));
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 400, { error: (e as Error).message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`RFQ Desk on http://127.0.0.1:${PORT} (read-only; node: ${rpcKind}${skipped.length ? ` after skipping ${skipped.join('; ')}` : ''}; Jupiter ${API_KEY ? 'with API key' : 'keyless, paced'})`));
