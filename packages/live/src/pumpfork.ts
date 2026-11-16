/** SDK AND HTTP API ON A LOCAL SOLANA VALIDATOR, OVER A REAL PUMP.FUN BONDING CURVE. The pump.fun program, its fee program and one live mainnet curve (plus Global, fee config and the accounts a trade touches) are
 *  cloned into a loopback solana-test-validator. The same `Trader` as everywhere else then trades that curve through the real HTTP API and `MemeClient`: quote, market buy and sell, idempotent retry,
 *  slippage refusal by the program itself, per-tx policy refusal, limit buy / limit sell / stop loss / bracket / trailing stop, bulk buy, TWAP, pause, restart. Local only: fake SOL, throwaway keys, dev-only signer.
 *  usage: npm run verify:pump (needs ALCHEMY_API_KEY in .env and solana-test-validator). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, PumpVenue, buy as pumpBuy, quoteBuy, createAtaIdempotent2 } from '../../sol/src/index.ts';
import { compileLegacy, unsignedTx } from '../../sol/src/tx.ts';
import { startPumpValidator } from './pumpenv.ts';
import type { PumpEnv } from './pumpenv.ts';
import type { Check } from './localrun.ts';
import { Trader } from '../../sdk/src/trader.ts';
import { MemeClient } from '../../sdk/src/client.ts';
import { createApi } from '../../../apps/api/server.ts';

const PORT = 8944, SOLN = 10n ** 9n, KEY = 'pump-fork-verification-key-0123456', sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DONE = ['finalized', 'failed', 'expired'];

export async function runPump(env: PumpEnv): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const rpc = env.rpc, signer = new DevSolSigner(), T = env.mint;
  const airdrop = async (a: string, lamports: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(lamports)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus === 'confirmed' || s.value[0]?.confirmationStatus === 'finalized') return; await sleep(500); } throw new Error('airdrop not confirmed'); };
  const policy = (cap = 50n): WalletPolicy => ({ userId: 'u1', chains: ['sol-local'], allowedVenues: ['pump'], maxPerTx: { [NATIVE]: cap * SOLN, [T]: 10n ** 21n }, dailyLimit: { [NATIVE]: 100_000n * SOLN, [T]: 10n ** 22n }, destinations: [], deviceSecret: 'dev' });
  const [w1, w2, w3, small, mover] = [signer.add(), signer.add(), signer.add(), signer.add(), signer.add()];
  for (const w of [w1, w2, w3]) await airdrop(w, 40n * SOLN); await airdrop(small, 10n * SOLN); await airdrop(mover, 40n * SOLN);
  const pols = new Map<string, WalletPolicy>([[w1, policy()], [w2, policy()], [w3, policy()], [small, policy(1n)], [mover, policy(1_000n)]]);
  const chain = new SolanaChain({ id: 'sol-local', wsol: 'So11111111111111111111111111111111111111112', pools: [], pump: { mints: [T] } }, rpc, signer);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-pump-trader-')), stateDir = join(dir, 'trader'), store = Store.open(join(dir, 'engine.json'));
  await chain.refresh('venues');
  const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([...pols.keys()].map(w => [w, 'x'])), pols), router: new Router(chain), platformFeeBps: 0 });
  const trader = new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: stateDir });
  const api = createApi({ keys: [{ key: KEY, userId: 'u1' }], traderFor: u => (u === 'u1' ? trader : undefined) }); const port = await api.listen(0);
  const c = new MemeClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, timeoutMs: 120_000 });
  const tokOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: T }, { encoding: 'jsonParsed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));
  const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const sigs = async (w: string) => (await rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 200, commitment: 'confirmed' }])).length;
  const fin = async (key: string, ms = 120_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await c.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };
  const finT = async (key: string, ms = 120_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await trader.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };
  const until = async (cond: () => Promise<boolean> | boolean, ms = 150_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await trader.tick(); if (await cond()) return true; await sleep(700); } return false; };
  const tradeDone = (k: string) => () => DONE.includes(store.records.get(k)?.state ?? '');
  const spot = () => trader.spotE18(T)!;
  const v = () => chain.venues()[0] as PumpVenue;
  facts.push(`validator cloned the pump.fun program, the fee program and a live curve for mint ${T.slice(0, 6)}... (Token-2022); on-chain virtual SOL ${(Number(env.curve.virtualSol) / 1e9).toFixed(1)} SOL, total fee ${v().totalFeeBps} bps read from the cloned fee config`);

  // P1 quote
  const amt = SOLN, q = await c.quote({ side: 'buy', token: T, amount: amt }), direct = v().quote(NATIVE, T, amt);
  check('P1 the API quote equals the curve venue\'s own quote, and the minimum output is quote x (1 - slippage)', BigInt(q.amountOut) === BigInt(direct.amountOut) && BigInt(q.minOut) === BigInt(direct.amountOut) * 9700n / 10000n, `API ${q.amountOut}, venue ${direct.amountOut}, minOut ${q.minOut}`);

  // P2 market buy: the real fill against the quote
  const t0 = await tokOf(w1), l0 = await lamports(w1), n0 = await sigs(w1);
  const b0 = await c.buy({ walletId: w1, token: T, amount: amt, slippageBps: 300, key: 'buy-1' }), b = await fin(b0.key); const t1 = await tokOf(w1), l1 = await lamports(w1), n1 = await sigs(w1);
  const spent = l0 - l1;
  check('P2 a market buy over HTTP finalizes on the validator; tokens received equal the fill and meet the minimum output; SOL spent stays within the amount plus network fees and rent; one transaction', b.state === 'finalized' && t1 - t0 === BigInt(b.fill.received) && BigInt(b.fill.received) >= BigInt(q.minOut) && spent <= amt + 10_000_000n && n1 === n0 + 1, `state ${b.state}, received ${b.fill?.received}, minOut ${q.minOut}, spent ${spent}, signatures ${n0}->${n1}`);
  const quoteErr = (BigInt(q.amountOut) - (t1 - t0)) * 10000n / BigInt(q.amountOut);
  check('P3 the real fill is within 1% of the quote (the curve and fee schedule are modelled correctly)', quoteErr >= -100n && quoteErr <= 100n, `quote ${q.amountOut}, filled ${t1 - t0}, difference ${quoteErr} bps`);
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
  const ns = await sigs(small), big = await c.buy({ walletId: small, token: T, amount: 5n * SOLN, key: 'too-big' });
  check('P7 a buy above the wallet\'s per-transaction cap is refused by the policy signer and nothing is sent', big.state === 'failed' && /per-tx limit/.test(big.failure) && (await sigs(small)) === ns, big.failure);

  // P8 limit orders
  const p = spot(), tb = await tokOf(w2);
  const lb = await c.limitBuy({ id: 'lb', walletId: w2, token: T, amount: SOLN / 2n, priceE18: String(p * 12n / 10n), slippageBps: 500 });
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
  const u = await trader.buy({ walletId: mover, token: T, amount: 10n * SOLN, slippageBps: 1500, key: 'push-up' }); up = await finT(u.key);
  await until(async () => BigInt((await c.order(tr.id)).peakE18 ?? 0) > base, 40_000); peak = BigInt((await c.order(tr.id)).peakE18 ?? 0); stillActive = (await c.order(tr.id)).status === 'active';
  const d = await trader.sell({ walletId: mover, token: T, amount: await tokOf(mover), slippageBps: 1500, key: 'push-down' }); dn = await finT(d.key);
  await until(tradeDone('order:u1.tr:a0'), 120_000); tro = await c.order(tr.id);
  check('P11 a trailing stop follows the curve price up (peak rises, not fired), then fires once the price falls 3% from its peak', up?.state === 'finalized' && dn?.state === 'finalized' && peak > base && stillActive && tro?.status === 'fired' && t5 - (await tokOf(w1)) === t5 / 10n, `base ${base}, peak ${peak}, status ${tro?.status}, up ${up?.state}, down ${dn?.state}`);

  // P12 bulk buy from two wallets
  const bu = [await tokOf(w2), await tokOf(w3)];
  await c.bulkBuy({ id: 'bb', token: T, wallets: [w2, w3], total: 2n * SOLN, slippageBps: 500 });
  let bs: any; await until(async () => (bs = await c.bulk('u1.bb')).done);
  check('P12 a bulk buy from 2 wallets: both legs filled from their own wallets, each wallet\'s tokens rose by its own leg, the legs sum to the total (an exact-token buy leaves at most a few lamports of rounding unspent)', bs.done && bs.filled === 2 && (await tokOf(w2)) - bu[0] === BigInt(bs.legs[0].received) && (await tokOf(w3)) - bu[1] === BigInt(bs.legs[1].received) && BigInt(bs.spent) <= 2n * SOLN && 2n * SOLN - BigInt(bs.spent) <= 10n, `filled ${bs.filled}, spent ${bs.spent}, legs ${JSON.stringify(bs.legs, (_k, x) => typeof x === 'bigint' ? x.toString() : x)}`);

  // P13 TWAP, real seconds
  const t6 = await tokOf(w3);
  await c.twap({ id: 'tw', walletId: w3, token: T, side: 'buy', total: 3n * SOLN / 2n, slices: 3, intervalS: 20, windowS: 80, slippageBps: 500 });
  let tw: any; await until(async () => (tw = await c.twapStatus('u1.tw')).done, 240_000);
  check('P13 a 3-slice TWAP traded one slice per interval: 3 filled, slices scheduled exactly 20 s apart, the wallet\'s tokens equal what the slices received', tw.done && tw.filled === 3 && tw.slices[1].dueAt - tw.slices[0].dueAt === 20 && tw.slices[2].dueAt - tw.slices[1].dueAt === 20 && (await tokOf(w3)) - t6 === BigInt(tw.received), `filled ${tw.filled}, skipped ${tw.skipped}, received ${tw.received}; slices ${JSON.stringify(tw.slices, (_k, x) => typeof x === 'bigint' ? x.toString() : x)}`);

  // P14 pause
  await c.pauseEntries(); const np = await sigs(w1); let refused = ''; try { await c.buy({ walletId: w1, token: T, amount: SOLN / 10n }); } catch (e) { refused = (e as any).code; }
  const sp0 = await c.sell({ walletId: w1, token: T, amount: (await tokOf(w1)) / 20n, slippageBps: 500, key: 'sell-paused' }), sp = await fin(sp0.key); await c.resumeEntries();
  check('P14 while paused a buy is refused (nothing sent) and a sell still works', refused === 'entries_paused' && sp.state === 'finalized' && (await sigs(w1)) === np + 1, `buy: ${refused}, sell: ${sp.state}`);

  // P15 restart
  await c.limitBuy({ id: 'persist', walletId: w2, token: T, amount: SOLN / 20n, priceE18: '1' });
  const t2b = new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: stateDir });
  const again = await t2b.limitBuy({ id: 'u1.persist', walletId: w2, token: T, amount: SOLN / 20n, priceE18: '1' });
  check('P15 after a restart a new Trader loads the active order from its state file and placing the same id again does not create a second one', again.status === 'active' && t2b.listOrders().filter(o => o.id === 'u1.persist').length === 1, `files: ${readdirSync(stateDir).join(', ')}`);

  await api.close();
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# SDK and HTTP API over a pump.fun bonding curve on a local Solana validator', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with the pump.fun and fee programs and one live mainnet curve cloned. NOT mainnet. Throwaway keys, fake SOL, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same `Trader` as the other verifications, running over `SolanaChain` and a `PumpVenue`, buying and selling on the REAL pump.fun program code (not a mock) with the real fee program, driven through the real HTTP API and `MemeClient`. The program itself enforces the slippage guard.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A local validator is not mainnet: no leader competition, priority-fee market or MEV. No real funds were used.', '- The curve is a snapshot cloned at start; other traders do not move it. Price moves are made by a second throwaway wallet.', '- Buys use the v1 `buy` instruction with an exact token amount and a maximum SOL cost; `buy_exact_sol_in` and the v3 / quote-mint instructions are not used.', '- Curves that are complete (graduated to PumpSwap), mayhem-mode and cashback coins are refused, not traded.', '- The fee schedule layout was decoded from one live account; an unrecognised layout makes the venue untradable.'].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let env: PumpEnv | undefined;
  try {
    env = await startPumpValidator(key, PORT);
    const r = await runPump(env), rep = report(env.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-pump.md`; writeFileSync(file, env.redact(rep.text));
    console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('pumpfork.ts')) main();
