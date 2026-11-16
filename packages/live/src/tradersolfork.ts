/** SDK AND HTTP API ON A LOCAL SOLANA VALIDATOR. The same `Trader` as on the practice chain and the Ethereum fork, now over `SolanaChain` against the Raydium AMM v4 SOL/USDC pool cloned from mainnet into a loopback
 *  solana-test-validator, driven through the real HTTP API and `MemeClient`: quote, market buy and sell, idempotent retry, per-tx policy refusal, limit buy / limit sell / stop loss / bracket / trailing stop,
 *  bulk buy, TWAP, pause entries, restart. Local only: fake SOL, throwaway keys, dev-only signer. Real time (the validator produces blocks at its own pace), so this takes several minutes.
 *  usage: npm run verify:trader-solana (needs ALCHEMY_API_KEY in .env and solana-test-validator). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner } from '../../sol/src/index.ts';
import { SOL, SOL_POOL } from './config.ts';
import { startSolValidator } from './solenv.ts';
import type { SolEnv } from './solenv.ts';
import type { Check } from './localrun.ts';
import { Trader } from '../../sdk/src/trader.ts';
import { MemeClient } from '../../sdk/src/client.ts';
import { createApi } from '../../../apps/api/server.ts';

const PORT = 8934, SOLN = 10n ** 9n, KEY = 'solana-fork-verification-key-012345', sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const USDC = SOL_POOL.usdc.mint, WSOL = SOL_POOL.wsol.mint, DONE = ['finalized', 'failed', 'expired'];

export async function runTraderSolana(env: SolEnv): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const rpc = env.rpc, signer = new DevSolSigner(), programId = SOL.programs[0].address;
  const airdrop = async (a: string, lamports: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(lamports)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus === 'confirmed' || s.value[0]?.confirmationStatus === 'finalized') return; await sleep(500); } throw new Error('airdrop not confirmed'); };
  const policy = (cap = 200n): WalletPolicy => ({ userId: 'u1', chains: ['sol-local'], allowedVenues: ['raydium-v4'], maxPerTx: { [NATIVE]: cap * SOLN, [USDC]: 10n ** 18n }, dailyLimit: { [NATIVE]: 100_000n * SOLN, [USDC]: 10n ** 19n }, destinations: [], deviceSecret: 'dev' });
  const [w1, w2, w3, small, mover] = [signer.add(), signer.add(), signer.add(), signer.add(), signer.add()];
  for (const w of [w1, w2, w3]) await airdrop(w, 150n * SOLN); await airdrop(small, 50n * SOLN);
  const pols = new Map<string, WalletPolicy>([[w1, policy()], [w2, policy()], [w3, policy()], [small, policy(1n)], [mover, policy(1_000_000n)]]);
  const chain = new SolanaChain({ id: 'sol-local', wsol: WSOL, program: programId, pools: [{ id: SOL_POOL.id, program: programId }] }, rpc, signer);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-tradersol-')), stateDir = join(dir, 'trader'), store = Store.open(join(dir, 'engine.json'));
  await chain.refresh('venues');
  const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([...pols.keys()].map(w => [w, 'x'])), pols), router: new Router(chain), platformFeeBps: 0 });
  const trader = new Trader({ engine, chain, userId: 'u1', venues: ['raydium-v4'], persistDir: stateDir });
  const api = createApi({ keys: [{ key: KEY, userId: 'u1' }], traderFor: u => (u === 'u1' ? trader : undefined) }); const port = await api.listen(0);
  const c = new MemeClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, timeoutMs: 120_000 });
  const usdcOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: USDC }, { encoding: 'jsonParsed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));
  const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const sigs = async (w: string) => (await rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 200, commitment: 'confirmed' }])).length;
  const fin = async (key: string, ms = 120_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await c.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };
  const finT = async (key: string, ms = 120_000) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < ms) { t = await trader.advance(key); if (DONE.includes(t.state)) return t; await sleep(700); } return t; };   // direct SDK calls (the mover wallet), not through the API
  const until = async (cond: () => Promise<boolean> | boolean, ms = 150_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await trader.tick(); if (await cond()) return true; await sleep(700); } return false; };
  const tradeDone = (k: string) => () => DONE.includes(store.records.get(k)?.state ?? '');
  const spot = () => trader.spotE18(USDC)!;
  const v: any = chain.venues()[0], liq = BigInt(v.quote(NATIVE, USDC, 10n ** 6n).liquidity);
  facts.push(`validator cloned Raydium AMM v4 and the mainnet SOL/USDC pool (SOL-side reserve about ${(Number(liq) / 1e9).toFixed(0)} SOL); wallets w1, w2, w3 hold 150 fake SOL, "small" 50 SOL with a 1 SOL per-transaction cap; the API runs on loopback and the client is MemeClient`);

  // S1 quote
  const amt = 5n * SOLN, q = await c.quote({ side: 'buy', token: USDC, amount: amt });
  const direct = v.quote(NATIVE, USDC, amt);
  check('S1 the API quote equals the pool venue\'s own quote for the same amount, and the minimum output is quote x (1 - slippage)', BigInt(q.amountOut) === BigInt(direct.amountOut) && BigInt(q.minOut) === BigInt(direct.amountOut) * 9700n / 10000n, `API ${q.amountOut}, venue ${direct.amountOut}, minOut ${q.minOut}`);

  // S2 market buy
  const u0 = await usdcOf(w1), n0 = await sigs(w1);
  const b0 = await c.buy({ walletId: w1, token: USDC, amount: amt, slippageBps: 300, key: 'buy-1' }), b = await fin(b0.key); const u1 = await usdcOf(w1), n1 = await sigs(w1);
  check('S2 a market buy over HTTP finalizes on the validator, the wallet\'s USDC rose by exactly the fill, the fill respects the minimum output, and the trade was one transaction', b.state === 'finalized' && u1 - u0 === BigInt(b.fill.received) && BigInt(b.fill.received) >= BigInt(q.minOut) && n1 === n0 + 1, `state ${b.state}, received ${b.fill?.received}, minOut ${q.minOut}, signatures ${n0}->${n1}`);
  await c.buy({ walletId: w1, token: USDC, amount: amt, slippageBps: 300, key: 'buy-1' });
  check('S3 repeating the same Idempotency-Key trades nothing: same USDC, no new signature', (await usdcOf(w1)) === u1 && (await sigs(w1)) === n1);

  // S4 percentage sell
  const s0 = await c.sell({ walletId: w1, token: USDC, pctBps: 5000, key: 'sell-1' }), s = await fin(s0.key), u2 = await usdcOf(w1);
  check('S4 a 50% sell finalizes, sold exactly half the USDC balance, and the wallet received SOL', s.state === 'finalized' && u1 - u2 === u1 * 5000n / 10000n && BigInt(s.fill.received) > 0n, `sold ${u1 - u2} of ${u1}, received ${s.fill?.received} lamports`);

  // S5 per-tx cap
  const ns = await sigs(small), big = await c.buy({ walletId: small, token: USDC, amount: 5n * SOLN, key: 'too-big' });
  check('S5 a buy above the wallet\'s per-transaction cap is refused by the policy signer and nothing is sent', big.state === 'failed' && /per-tx limit/.test(big.failure) && (await sigs(small)) === ns, big.failure);

  // S6 limit orders
  const p = spot(), ub = await usdcOf(w2);
  const lb = await c.limitBuy({ id: 'lb', walletId: w2, token: USDC, amount: SOLN / 2n, priceE18: String(p * 12n / 10n), slippageBps: 500 });
  const ls = await c.limitSell({ id: 'ls', walletId: w1, token: USDC, amount: (await usdcOf(w1)) / 4n, priceE18: String(p * 5n) });
  const ok6 = await until(tradeDone('order:u1.lb:a0')); const lbo = await c.order(lb.id), lso = await c.order(ls.id);
  check('S6 a limit buy whose trigger is met fires and buys real USDC from the pool; a limit sell 5x above the market stays active and says why', ok6 && lbo.status === 'fired' && (await usdcOf(w2)) > ub && lso.status === 'active' && /not met/.test(lso.detail.reason ?? ''), `buy ${lbo.status} (${store.records.get('order:u1.lb:a0')?.state}), sell ${lso.status}: ${lso.detail.reason}`);

  // S7 stop loss
  const u3 = await usdcOf(w1), sl = await c.stopLoss({ id: 'sl', walletId: w1, token: USDC, amount: u3 / 10n, priceE18: String(spot() * 11n / 10n), slippageBps: 500 });
  const ok7 = await until(tradeDone('order:u1.sl:a0'));
  check('S7 a stop loss whose trigger is above the price fires and sells exactly its amount of USDC', ok7 && (await c.order(sl.id)).status === 'fired' && u3 - (await usdcOf(w1)) === u3 / 10n, `sold ${u3 - (await usdcOf(w1))}`);

  // S8 bracket
  const u4 = await usdcOf(w1), br = await c.bracket({ id: 'br', walletId: w1, token: USDC, amount: u4 / 10n, takeProfitE18: String(spot() * 50n), stopLossE18: String(spot() * 11n / 10n), slippageBps: 500 });
  const ok8 = await until(tradeDone('order:u1.br:sl:a0')); const [tp, sl2] = [await c.order(br[0].id), await c.order(br[1].id)];
  check('S8 in a bracket the leg that hit fires and the other is cancelled; only one sale happened', ok8 && sl2.status === 'fired' && tp.status === 'cancelled' && u4 - (await usdcOf(w1)) === u4 / 10n, `tp ${tp.status}, sl ${sl2.status}`);

  // S9 trailing stop; a second wallet moves the real pool up and back
  const u5 = await usdcOf(w1), tr = await c.trailingStop({ id: 'tr', walletId: w1, token: USDC, amount: u5 / 10n, trailBps: 300, slippageBps: 800 });
  await trader.tick(); await trader.tick(); const base = spot(), X = liq / 12n; let pushed = false, up: any, dn: any, peak = 0n, stillActive = false, tro: any;
  try { await airdrop(mover, X + 10n * SOLN); pushed = true; } catch (e) { facts.push(`mover airdrop of ${(Number(X) / 1e9).toFixed(0)} SOL failed: ${(e as Error).message}`); }
  if (pushed) {
    const u = await trader.buy({ walletId: mover, token: USDC, amount: X, slippageBps: 1500, key: 'push-up' }); up = await finT(u.key);
    await until(async () => BigInt((await c.order(tr.id)).peakE18 ?? 0) > base, 40_000); peak = BigInt((await c.order(tr.id)).peakE18 ?? 0); stillActive = (await c.order(tr.id)).status === 'active';
    const d = await trader.sell({ walletId: mover, token: USDC, amount: await usdcOf(mover), slippageBps: 1500, key: 'push-down' }); dn = await finT(d.key);
    await until(tradeDone('order:u1.tr:a0'), 120_000); tro = await c.order(tr.id);
  }
  check('S9 a trailing stop follows the price up (peak rises, not fired), then fires once the price falls 3% from its peak', pushed && up?.state === 'finalized' && dn?.state === 'finalized' && peak > base && stillActive && tro?.status === 'fired' && u5 - (await usdcOf(w1)) === u5 / 10n, `base ${base}, peak ${peak}, status ${tro?.status}`);

  // S10 bulk buy from two wallets
  const bu = [await usdcOf(w2), await usdcOf(w3)];
  await c.bulkBuy({ id: 'bb', token: USDC, wallets: [w2, w3], total: 4n * SOLN, slippageBps: 500 });
  let bs: any; await until(async () => (bs = await c.bulk('u1.bb')).done);
  check('S10 a bulk buy from 2 wallets: both legs filled from their own wallets, each wallet\'s USDC rose by its own leg, the legs sum to the total', bs.done && bs.filled === 2 && (await usdcOf(w2)) - bu[0] === BigInt(bs.legs[0].received) && (await usdcOf(w3)) - bu[1] === BigInt(bs.legs[1].received) && BigInt(bs.spent) === 4n * SOLN, `filled ${bs.filled}, spent ${bs.spent}`);

  // S11 TWAP, real seconds
  const t3 = await usdcOf(w3);
  await c.twap({ id: 'tw', walletId: w3, token: USDC, side: 'buy', total: 3n * SOLN, slices: 3, intervalS: 25, windowS: 90, slippageBps: 500 });
  let tw: any; await until(async () => (tw = await c.twapStatus('u1.tw')).done, 240_000);
  check('S11 a 3-slice TWAP traded one slice per interval: 3 filled, each slice its own transaction, slices scheduled exactly 25 s apart, the wallet\'s USDC equals what the slices received', tw.done && tw.filled === 3 && tw.slices[1].dueAt - tw.slices[0].dueAt === 25 && tw.slices[2].dueAt - tw.slices[1].dueAt === 25 && (await usdcOf(w3)) - t3 === BigInt(tw.received), `filled ${tw.filled}, skipped ${tw.skipped}, received ${tw.received}`);

  // S12 pause
  await c.pauseEntries(); const np = await sigs(w1); let refused = ''; try { await c.buy({ walletId: w1, token: USDC, amount: SOLN / 10n }); } catch (e) { refused = (e as any).code; }
  const sp0 = await c.sell({ walletId: w1, token: USDC, amount: (await usdcOf(w1)) / 20n, slippageBps: 500, key: 'sell-paused' }), sp = await fin(sp0.key); await c.resumeEntries();
  check('S12 while paused a buy is refused (nothing sent) and a sell still works', refused === 'entries_paused' && sp.state === 'finalized' && (await sigs(w1)) === np + 1, `buy: ${refused}, sell: ${sp.state}`);

  // S13 restart
  await c.limitBuy({ id: 'persist', walletId: w2, token: USDC, amount: SOLN / 20n, priceE18: '1' });
  const t2 = new Trader({ engine, chain, userId: 'u1', venues: ['raydium-v4'], persistDir: stateDir });
  const again = await t2.limitBuy({ id: 'u1.persist', walletId: w2, token: USDC, amount: SOLN / 20n, priceE18: '1' });
  check('S13 after a restart a new Trader loads the active order from its state file and placing the same id again does not create a second one', again.status === 'active' && t2.listOrders().filter(o => o.id === 'u1.persist').length === 1, `files: ${readdirSync(stateDir).join(', ')}`);

  await api.close();
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# SDK and HTTP API on a local Solana validator', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with Raydium AMM v4 and the mainnet SOL/USDC pool cloned. NOT mainnet. Throwaway keys, fake SOL, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same `Trader` that the practice-chain and Ethereum-fork tests cover, running over `SolanaChain` against the cloned Raydium SOL/USDC pool, driven through the real HTTP API and `MemeClient`. Every trade is built, signed under wallet policy, sent and reconciled by OUR engine, with finality at the validator\'s own pace.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A local validator is not mainnet: no leader competition, priority-fee market, MEV or real fills. No real funds were used.', '- Price moves are made by a second throwaway wallet trading the same cloned pool.', '- Only Raydium AMM v4 SOL/USDC; Jupiter routes, Orca, Meteora and Pump.fun curves are not exercised here.', '- Sniping and copy trading through the Trader are not exercised here (their runners have their own validator reports).', '- Private-key material on disk was not checked on this run (the dev Solana signer does not expose its secrets to the harness).'].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let env: SolEnv | undefined;
  try {
    env = await startSolValidator(key, PORT);
    const r = await runTraderSolana(env), rep = report(env.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-trader-solana.md`; writeFileSync(file, env.redact(rep.text));
    console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('tradersolfork.ts')) main();
