/** SDK ACTIONS ON SOLANA DEVNET (a real public test network), OVER A LIVE DEVNET PUMP.FUN BONDING CURVE. Unlike the local-validator run, these are real transactions on a shared network that other people also trade on,
 *  so the curve moves under us and results carry real network latency. Test SOL only (devnet faucet), three throwaway keys kept in `.devnet-wallets.json` (git-ignored; never printed).
 *  The RPC faucet on devnet is closed, so the first run only creates the wallets and prints the trading wallet's PUBLIC address: fund it at https://faucet.solana.com (devnet) and run again.
 *  usage: npm run verify:pump-devnet (needs ALCHEMY_API_KEY in .env, which also serves Solana devnet). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc, PumpVenue, buy as pumpBuy, quoteBuy, createAtaIdempotent2 } from '../../sol/src/index.ts';
import { compileLegacy, unsignedTx, systemTransfer, b58decode, wireTx, base58 } from '../../sol/src/tx.ts';
import { discoverCurve } from './pumpenv.ts';
import type { Check } from './localrun.ts';
import { Trader } from '../../sdk/src/trader.ts';
import { MemeClient } from '../../sdk/src/client.ts';
import { createApi } from '../../../apps/api/server.ts';

const KEY = 'pump-devnet-verification-key-01234', SOLN = 10n ** 9n, MIL = SOLN / 1000n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)), DONE = ['finalized', 'failed', 'expired'];
const WALLET_FILE = '.devnet-wallets.json', MIN_FUND = 900n * MIL;

export interface DevEnv { rpc: SolJsonRpc; mint: string; tokenProgram: string; curveSol: bigint; url: string }
export async function runDevnet(env: DevEnv, seeds: Uint8Array[]): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const rpc = env.rpc, signer = new DevSolSigner(), T = env.mint;
  const policy = (cap = 1n): WalletPolicy => ({ userId: 'u1', chains: ['sol-devnet'], allowedVenues: ['pump'], maxPerTx: { [NATIVE]: cap * SOLN / 2n, [T]: 10n ** 21n }, dailyLimit: { [NATIVE]: 100_000n * SOLN, [T]: 10n ** 22n }, destinations: [], deviceSecret: 'dev' });
  const [w1, w2, w3, mover] = seeds.slice(0, 4).map(s => signer.add(s)), small = signer.add();   
  const lamports0 = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const sendSol = async (from: string, to: string, l: bigint) => { const bh: any = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]); const msg = compileLegacy(from, [systemTransfer(from, to, l)], b58decode(bh.value.blockhash)); const sig = signer.sign(from, msg); const h = await rpc.call<string>('sendTransaction', [Buffer.from(wireTx(msg, [sig])).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]); for (let i = 0; i < 90; i++) { const s: any = await rpc.call('getSignatureStatuses', [[h]]); if (s.value[0]?.confirmationStatus === 'confirmed' || s.value[0]?.confirmationStatus === 'finalized') return; await sleep(1000); } throw new Error('funding transfer not confirmed'); };
  for (const [to, amt] of [[w2, 150n * MIL], [w3, 150n * MIL], [mover, 250n * MIL]] as [string, bigint][]) if ((await lamports0(to)) < amt / 2n) await sendSol(w1, to, amt);
  await sendSol(w1, small, 40n * MIL);   // 'small' is a fresh key each run: it needs an account to simulate from, but its policy cap is far below the buy we send it
  const pols = new Map<string, WalletPolicy>([[w1, policy()], [w2, policy()], [w3, policy()], [small, { ...policy(), maxPerTx: { [NATIVE]: 10n * MIL, [T]: 10n ** 21n } }], [mover, policy()]]);
  const chain = new SolanaChain({ id: 'sol-devnet', wsol: 'So11111111111111111111111111111111111111112', pools: [], pump: { mints: [T] } }, rpc, signer);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-pump-trader-')), stateDir = join(dir, 'trader'), store = Store.open(join(dir, 'engine.json'));
  await chain.refresh('venues');
  const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([...pols.keys()].map(w => [w, 'x'])), pols), router: new Router(chain), platformFeeBps: 0 });
  const trader = new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: stateDir });
  const api = createApi({ keys: [{ key: KEY, userId: 'u1' }], traderFor: u => (u === 'u1' ? trader : undefined) }); const port = await api.listen(0);
  const c = new MemeClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, timeoutMs: 180_000 });
  const tokOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: T }, { encoding: 'jsonParsed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));
  const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const sigs = async (w: string) => (await rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 200, commitment: 'confirmed' }])).length;
  const fin = async (key: string, ms = 240_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await c.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };
  const finT = async (key: string, ms = 240_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await trader.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };
  const until = async (cond: () => Promise<boolean> | boolean, ms = 240_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await trader.tick(); if (await cond()) return true; await sleep(700); } return false; };
  const tradeDone = (k: string) => () => DONE.includes(store.records.get(k)?.state ?? '');
  const spot = () => trader.spotE18(T)!;
  const v = () => chain.venues()[0] as PumpVenue;
  facts.push(`Solana DEVNET (real shared network), live pump.fun curve for mint ${T.slice(0, 6)}... (Token-2022); virtual SOL at start ${(Number(env.curveSol) / 1e9).toFixed(1)} SOL, total fee ${v().totalFeeBps} bps read from the on-chain fee config`);

  // P1 quote
  const amt = 20n * MIL, q = await c.quote({ side: 'buy', token: T, amount: amt }), direct = v().quote(NATIVE, T, amt);
  check('P1 the API quote equals the curve venue\'s own quote, and the minimum output is quote x (1 - slippage)', BigInt(q.amountOut) === BigInt(direct.amountOut) && BigInt(q.minOut) === BigInt(direct.amountOut) * 9700n / 10000n, `API ${q.amountOut}, venue ${direct.amountOut}, minOut ${q.minOut}`);

  // P2 market buy: the real fill against the quote
  const t0 = await tokOf(w1), l0 = await lamports(w1), n0 = await sigs(w1);
  const b0 = await c.buy({ walletId: w1, token: T, amount: amt, slippageBps: 300, key: 'buy-1' }), b = await fin(b0.key); const t1 = await tokOf(w1), l1 = await lamports(w1), n1 = await sigs(w1);
  const spent = l0 - l1;
  check('P2 a market buy over HTTP finalizes on the validator; tokens received equal the fill and meet the minimum output; SOL spent stays within the amount plus network fees and rent; one transaction', b.state === 'finalized' && t1 - t0 === BigInt(b.fill.received) && BigInt(b.fill.received) >= BigInt(q.minOut) && spent <= amt + 15_000_000n && n1 === n0 + 1, `state ${b.state}, received ${b.fill?.received}, minOut ${q.minOut}, spent ${spent}, signatures ${n0}->${n1}`);
  const quoteErr = (BigInt(q.amountOut) - (t1 - t0)) * 10000n / BigInt(q.amountOut);
  check('P3 the real fill is within 3% of the quote (other people trade this curve, so it can move between quote and fill) (the curve and fee schedule are modelled correctly)', quoteErr >= -300n && quoteErr <= 300n, `quote ${q.amountOut}, filled ${t1 - t0}, difference ${quoteErr} bps`);
  facts.push(`quote ${q.amountOut} tokens vs real fill ${t1 - t0} tokens (${quoteErr} bps difference); SOL spent including network fee and any rent ${spent} lamports for a ${amt} lamport budget`);
  await c.buy({ walletId: w1, token: T, amount: amt, slippageBps: 300, key: 'buy-1' });
  check('P4 repeating the same Idempotency-Key trades nothing: same token balance, no new signature', (await tokOf(w1)) === t1 && (await sigs(w1)) === n1);

  // P5 slippage enforced by the pump program itself
  const vv = v(), tk = quoteBuy(amt, vv.curve, vv.totalFeeBps).tokens;
  const ix = pumpBuy({ user: w2, mint: T, tokenProgram: env.tokenProgram, curve: vv.curve, feeRecipient: vv.global.feeRecipient, buybackRecipient: vv.global.buybackRecipients[0] }, tk, amt / 2n);
  const raw = Buffer.from(unsignedTx(compileLegacy(w2, [createAtaIdempotent2(w2, w2, T, env.tokenProgram), ix]))).toString('base64'); const sim: any = await rpc.call('simulateTransaction', [raw, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', encoding: 'base64' }]);
  check('P5 the program refuses a buy whose maximum cost is below the real cost (TooMuchSolRequired, code 6002) - the slippage guard is on chain, not only in our code', JSON.stringify(sim.value.err).includes('6002'), JSON.stringify(sim.value.err));

  // P6 percentage sell
  const s0 = await c.sell({ walletId: w1, token: T, pctBps: 5000, key: 'sell-1' }), s = await fin(s0.key), t2 = await tokOf(w1);
  check('P6 a 50% sell finalizes, sold exactly half the token balance, and the wallet received SOL', s.state === 'finalized' && t1 - t2 === t1 * 5000n / 10000n && BigInt(s.fill.received) > 0n, `sold ${t1 - t2} of ${t1}, received ${s.fill?.received} lamports`);

  // P7 per-tx cap
  const ns = await sigs(small), big = await c.buy({ walletId: small, token: T, amount: 30n * MIL, key: 'too-big' });
  check('P7 a buy above the wallet\'s per-transaction cap is refused by the policy signer and nothing is sent', big.state === 'failed' && /per-tx limit/.test(big.failure) && (await sigs(small)) === ns, big.failure);

  // P8 limit orders
  const p = spot(), tb = await tokOf(w2);
  const lb = await c.limitBuy({ id: 'lb', walletId: w2, token: T, amount: 10n * MIL, priceE18: String(p * 12n / 10n), slippageBps: 500 });
  const ls = await c.limitSell({ id: 'ls', walletId: w1, token: T, amount: (await tokOf(w1)) / 4n, priceE18: String(p * 5n) });
  const ok8 = await until(tradeDone('order:u1.lb:a0')); const lbo = await c.order(lb.id), lso = await c.order(ls.id);
  check('P8 a limit buy whose trigger is met fires and buys real tokens from the curve; a limit sell 5x above the market stays active and says why', ok8 && lbo.status === 'fired' && (await tokOf(w2)) > tb && lso.status === 'active' && /not met/.test(lso.detail.reason ?? ''), `buy ${lbo.status} (${store.records.get('order:u1.lb:a0')?.state}), sell ${lso.status}: ${lso.detail.reason}`);

  // P9 stop loss
  const t3 = await tokOf(w1), sl = await c.stopLoss({ id: 'sl', walletId: w1, token: T, amount: t3 / 10n, priceE18: String(spot() * 11n / 10n), slippageBps: 500 });
  const ok9 = await until(tradeDone('order:u1.sl:a0'));
  check('P9 a stop loss whose trigger is above the price fires and sells exactly its amount', ok9 && (await c.order(sl.id)).status === 'fired' && t3 - (await tokOf(w1)) === t3 / 10n, `sold ${t3 - (await tokOf(w1))}`);

  // P10 bracket
  const t4 = await tokOf(w1), br = await c.bracket({ id: 'br', walletId: w1, token: T, amount: t4 / 10n, takeProfitE18: String(spot() * 50n), stopLossE18: String(spot() * 11n / 10n), slippageBps: 500 });
  const ok10 = await until(tradeDone('order:u1.br:sl:a0')); const [tp, sl2] = [await c.order(br[0].id), await c.order(br[1].id)];
  check('P10 in a bracket the leg that hit fires and the other is cancelled; only one sale happened', ok10 && sl2.status === 'fired' && tp.status === 'cancelled' && t4 - (await tokOf(w1)) === t4 / 10n, `tp ${tp.status}, sl ${sl2.status}`);

  // P11 trailing stop; a second wallet moves the curve up and back
  const t5 = await tokOf(w1), tr = await c.trailingStop({ id: 'tr', walletId: w1, token: T, amount: t5 / 10n, trailBps: 300, slippageBps: 800 });
  await trader.tick(); await trader.tick(); const base = spot(); let up: any, dn: any, peak = 0n, stillActive = false, tro: any;
  const u = await trader.buy({ walletId: mover, token: T, amount: 100n * MIL, slippageBps: 2000, key: 'push-up' }); up = await finT(u.key);
  await until(async () => BigInt((await c.order(tr.id)).peakE18 ?? 0) > base, 40_000); peak = BigInt((await c.order(tr.id)).peakE18 ?? 0); stillActive = (await c.order(tr.id)).status === 'active';
  const d = await trader.sell({ walletId: mover, token: T, amount: await tokOf(mover), slippageBps: 1500, key: 'push-down' }); dn = await finT(d.key);
  await until(tradeDone('order:u1.tr:a0'), 240_000); tro = await c.order(tr.id);
  check('P11 a trailing stop follows the curve price up (peak rises, not fired), then fires once the price falls 3% from its peak', up?.state === 'finalized' && dn?.state === 'finalized' && peak > base && stillActive && tro?.status === 'fired' && t5 - (await tokOf(w1)) === t5 / 10n, `base ${base}, peak ${peak}, status ${tro?.status}, up ${up?.state}, down ${dn?.state}${dn?.failure ? ' (' + String(dn.failure).slice(0, 160) + ')' : ''}`);

  // P12 bulk buy from two wallets
  const bu = [await tokOf(w2), await tokOf(w3)];
  await c.bulkBuy({ id: 'bb', token: T, wallets: [w2, w3], total: 40n * MIL, slippageBps: 800 });
  let bs: any; await until(async () => (bs = await c.bulk('u1.bb')).done);
  check('P12 a bulk buy from 2 wallets: both legs filled from their own wallets, each wallet\'s tokens rose by its own leg, the legs sum to the total (an exact-token buy leaves at most a few lamports of rounding unspent)', bs.done && bs.filled === 2 && (await tokOf(w2)) - bu[0] === BigInt(bs.legs[0].received) && (await tokOf(w3)) - bu[1] === BigInt(bs.legs[1].received) && BigInt(bs.spent) <= 40n * MIL && 40n * MIL - BigInt(bs.spent) <= 10n, `filled ${bs.filled}, spent ${bs.spent}, legs ${JSON.stringify(bs.legs, (_k, x) => typeof x === 'bigint' ? x.toString() : x)}`);

  // P13 TWAP, real seconds
  const t6 = await tokOf(w3);
  await c.twap({ id: 'tw', walletId: w3, token: T, side: 'buy', total: 30n * MIL, slices: 3, intervalS: 30, windowS: 120, slippageBps: 500 });
  let tw: any; await until(async () => (tw = await c.twapStatus('u1.tw')).done, 240_000);
  check('P13 a 3-slice TWAP traded one slice per interval: 3 filled, slices scheduled exactly 30 s apart, the wallet\'s tokens equal what the slices received', tw.done && tw.filled === 3 && tw.slices[1].dueAt - tw.slices[0].dueAt === 30 && tw.slices[2].dueAt - tw.slices[1].dueAt === 30 && (await tokOf(w3)) - t6 === BigInt(tw.received), `filled ${tw.filled}, skipped ${tw.skipped}, received ${tw.received}; slices ${JSON.stringify(tw.slices, (_k, x) => typeof x === 'bigint' ? x.toString() : x)}`);

  // P14 pause
  await c.pauseEntries(); const np = await sigs(w1); let refused = ''; try { await c.buy({ walletId: w1, token: T, amount: 5n * MIL }); } catch (e) { refused = (e as any).code; }
  const sp0 = await c.sell({ walletId: w1, token: T, amount: (await tokOf(w1)) / 20n, slippageBps: 500, key: 'sell-paused' }), sp = await fin(sp0.key); await c.resumeEntries();
  check('P14 while paused a buy is refused (nothing sent) and a sell still works', refused === 'entries_paused' && sp.state === 'finalized' && (await sigs(w1)) === np + 1, `buy: ${refused}, sell: ${sp.state}`);

  // P15 restart
  await c.limitBuy({ id: 'persist', walletId: w2, token: T, amount: 5n * MIL, priceE18: '1' });
  const t2b = new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: stateDir });
  const again = await t2b.limitBuy({ id: 'u1.persist', walletId: w2, token: T, amount: 5n * MIL, priceE18: '1' });
  check('P15 after a restart a new Trader loads the active order from its state file and placing the same id again does not create a second one', again.status === 'active' && t2b.listOrders().filter(o => o.id === 'u1.persist').length === 1, `files: ${readdirSync(stateDir).join(', ')}`);

  await api.close();
  return { checks, facts };
}


function report(url: string, r: { checks: Check[]; facts: string[] }, addr: string) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# SDK actions on Solana devnet over a live pump.fun curve', '', `Run: ${new Date().toISOString()}`, `Network: Solana DEVNET (public test network, genesis EtWTRABZ...). Test SOL only; throwaway keys; trading wallet ${addr}.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same `Trader`, over `SolanaChain` and `PumpVenue`, sending REAL transactions to the devnet pump.fun program with the devnet fee program, through the real HTTP API and `MemeClient`.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Devnet is a test network: no real value, different liquidity and traffic from mainnet, and its pump.fun deployment may differ from mainnet.', '- Other devnet users trade the same curve, so prices move between steps; checks that assume a still market use a tolerance, and a failure can be market movement. Read the detail column.', '- Curves that are complete, mayhem-mode and cashback coins are refused, not traded.'].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const url = `https://solana-devnet.g.alchemy.com/v2/${key}`, redact = (s: string) => s.split(key).join('***');
  let seeds: Uint8Array[]; if (existsSync(WALLET_FILE)) seeds = (JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as string[]).map(h => Uint8Array.from(Buffer.from(h, 'hex'))); else { seeds = [0, 1, 2, 3].map(() => randomBytes(32)); writeFileSync(WALLET_FILE, JSON.stringify(seeds.map(s => Buffer.from(s).toString('hex'))), { mode: 0o600 }); }
  const addrs = seeds.map(s => new DevSolSigner().add(s)), rpc = new SolJsonRpc(url);
  try {
    const gh = await rpc.call<string>('getGenesisHash'); if (!gh.startsWith('EtWTRABZ')) throw new Error(`this endpoint is not Solana devnet (genesis ${gh.slice(0, 8)})`);
    const bal = BigInt((await rpc.call<any>('getBalance', [addrs[0], { commitment: 'confirmed' }])).value);
    console.log(`trading wallet (devnet, public address): ${addrs[0]}   balance ${(Number(bal) / 1e9).toFixed(4)} SOL`);
    if (bal < MIN_FUND) { console.log(`\nNeeds at least ${Number(MIN_FUND) / 1e9} devnet SOL. The RPC faucet is closed: request test SOL for that address at https://faucet.solana.com (choose devnet), then run again.`); process.exit(3); }
    let n = 0; const call = async (m: string, p: unknown[]) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: m, params: p }) }); const j: any = await r.json(); if (j.error) throw new Error(m + ': ' + redact(String(j.error.message))); return j.result; };
    const f = await discoverCurve(call, 60); console.log(`devnet curve ${f.mint} (${f.tokenProgram.slice(0, 8)}), virtual SOL ${Number(f.curve.virtualSol) / 1e9}`);
    const r = await runDevnet({ rpc, mint: f.mint, tokenProgram: f.tokenProgram, curveSol: f.curve.virtualSol, url: 'solana-devnet' }, seeds), rep = report('devnet', r, addrs[0]);
    mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-pump-devnet.md`; writeFileSync(file, redact(rep.text));
    console.log(`\nreport: ${file}`); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(redact((e as Error).stack ?? (e as Error).message)); process.exit(1); }
}
if (process.argv[1]?.endsWith('pumpdevnet.ts')) main();
