/** SDK AND HTTP API ON A LOCAL ETHEREUM MAINNET FORK. The practice-chain tests prove the Trader and API logic; this runs the SAME `Trader` over the real chain port (EvmRpcChain) on a loopback anvil fork of
 *  Ethereum mainnet, the real Uniswap V2 WETH/USDC pool, and drives it through the real HTTP API with the real client: quote, market buy and sell (automatic exact approval), idempotent retry, per-tx policy refusal,
 *  limit buy / limit sell / stop loss / bracket / trailing stop, bulk buy, TWAP, pause entries, and a restart from the state files. Local only: throwaway keys, fake ETH, dev-only signer.
 *  usage: npm run verify:evm (needs ALCHEMY_API_KEY in .env and Foundry's anvil). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import { newWallet, hex, big, CastSigner } from './localnode.ts';
import { ETH } from './config.ts';
import { startFork } from './forkenv.ts';
import type { LocalNode } from './localnode.ts';
interface Check { name: string; pass: boolean; detail: string }
import { Trader } from '../../sdk/src/trader.ts';
import { MemeClient } from '../../sdk/src/client.ts';
import { createApi } from '../../../apps/api/server.ts';

const PORT = 8664, ETH1 = 10n ** 18n, KEY = 'fork-verification-key-0123456789';

export interface ForkTarget { label: string; chainId: number; router: string; factory: string; token: string; unit: bigint; family: string; fee?: { num: bigint; den: bigint }; nativeName: string }
const ETH_TARGET: ForkTarget = { label: 'Ethereum mainnet', chainId: 1, router: ETH.uniswapV2Router02.address, factory: ETH.uniswapV2Factory.address, token: ETH.usdc.address, unit: 10n ** 18n, family: 'uniswap-v2', nativeName: 'ETH' };
export async function runTraderFork(node: LocalNode, T: ForkTarget = ETH_TARGET): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = T.router, factory = T.factory, usdc = T.token.toLowerCase(), U = T.unit;
  const call = (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const signer = new CastSigner(), keys = new Map<string, string>(), policies = new Map<string, WalletPolicy>();
  const secrets: string[] = [];
  const mk = async (big_ = false) => { const w = signer.add(newWallet()); secrets.push(w.key.slice(2)); await node.call('anvil_setBalance', [w.address, hex((big_ ? 100_000n : 10n) * 10n ** 18n)]); keys.set(w.address, 'dev');
    policies.set(w.address, { userId: 'u1', chains: ['evm-fork'], allowedVenues: [T.family], maxPerTx: { [NATIVE]: (big_ ? 100_000n : 5n) * U, [usdc]: 10n ** 33n }, dailyLimit: { [NATIVE]: (big_ ? 100_000n : 100n) * U, [usdc]: 10n ** 34n }, destinations: [], deviceSecret: 'dev' }); return w.address; };
  const w1 = await mk(), w2 = await mk(), w3 = await mk(), mover = await mk(true);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-traderfork-')), stateDir = join(dir, 'trader');
  const chain = new EvmRpcChain({ id: 'evm-fork', chainId: T.chainId, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3, family: T.family, fee: T.fee }, node, signer);
  const store = Store.open(join(dir, 'engine.json')); await chain.refresh('venues');
  const engine = new Engine({ store, chain, signer: new PolicySigner(keys, policies), router: new Router(chain), platformFeeBps: 0 });
  const mine = async (n = 4) => { await node.call('anvil_mine', [hex(BigInt(n))]); };
  const trader = new Trader({ engine, chain, userId: 'u1', venues: [T.family], persistDir: stateDir, advanceChain: () => mine(4) });
  const api = createApi({ keys: [{ key: KEY, userId: 'u1' }], traderFor: u => (u === 'u1' ? trader : undefined) }); const port = await api.listen(0);
  const c = new MemeClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY });
  const nonce = async (w: string) => Number(big(await node.call<string>('eth_getTransactionCount', [w, 'latest'])));
  const usdcOf = async (w: string) => { const q = erc20.balanceOf(usdc, w); return erc20.decodeUint(await call(q.to, q.data)); };
  const spot = () => trader.spotE18(usdc)!;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) await trader.tick(); };
  const liq = BigInt((chain.venues()[0] as any).quote(NATIVE, usdc, 10n ** 12n).liquidity);
  facts.push(`fork of ${T.label}, chain time ${chain.time}; spot ${(Number(spot()) / 1e18).toExponential(4)} ${T.nativeName} per raw token unit; pool wrapped-native reserve ${(Number(liq) / 1e18).toFixed(3)} ${T.nativeName}; wallets w1, w2, w3 hold 10 fake native coin each; the API runs on loopback and the client is MemeClient`);

  // F1 quote: the SDK's number equals the real router's number
  const amt = U / 10n, q = await c.quote({ side: 'buy', token: usdc, amount: amt });
  const real = decodeParams(['uint256[]'], await call(router, encodeCall('getAmountsOut(uint256,address[])', [amt, [weth, usdc]])))[0] as bigint[];
  check('F1 the API quote equals the real Uniswap V2 router getAmountsOut for the same amount', BigInt(q.amountOut) === real[1] && q.venue === 'uni:WETH-USDC', `API ${q.amountOut}, router ${real[1]}, venue ${q.venue}`);

  // F2 market buy through HTTP
  const u0 = await usdcOf(w1), n0 = await nonce(w1);
  const b = await c.buy({ walletId: w1, token: usdc, amount: amt, slippageBps: 300, key: 'buy-1' }); const u1 = await usdcOf(w1);
  check('F2 a market buy over HTTP is finalized, the wallet received exactly the fill, and one transaction was sent', b.state === 'finalized' && u1 - u0 === BigInt(b.fill.received) && BigInt(b.fill.received) >= BigInt(q.minOut) && (await nonce(w1)) === n0 + 1, `state ${b.state}, received ${b.fill?.received}, minOut ${q.minOut}, nonce ${n0}->${await nonce(w1)}`);
  await c.buy({ walletId: w1, token: usdc, amount: amt, slippageBps: 300, key: 'buy-1' });
  check('F3 repeating the same Idempotency-Key trades nothing: same USDC, same nonce', (await usdcOf(w1)) === u1 && (await nonce(w1)) === n0 + 1);

  // F4 percentage sell (automatic exact approval child)
  const s = await c.sell({ walletId: w1, token: usdc, pctBps: 5000, key: 'sell-1' }); const u2 = await usdcOf(w1);
  check('F4 a 50% sell is finalized, sold exactly half the balance, and used an exact-amount approval (child tx)', s.state === 'finalized' && u1 - u2 === u1 * 5000n / 10000n && store.records.has('u1.sell-1:approve'), `sold ${u1 - u2} of ${u1}`);

  // F5 per-tx policy cap is enforced for SDK trades
  const nBefore = await nonce(w2), big6 = await c.buy({ walletId: w2, token: usdc, amount: 6n * U, key: 'too-big' });
  check('F5 a buy above the wallet\'s per-transaction cap is refused by the policy signer and nothing is sent', big6.state === 'failed' && /per-tx limit/.test(big6.failure) && (await nonce(w2)) === nBefore, big6.failure);

  // F6 limit buy fires (trigger above spot), limit sell does not (trigger far above spot)
  const p = spot(), uBefore = await usdcOf(w2);
  const lb = await c.limitBuy({ id: 'lb', walletId: w2, token: usdc, amount: U / 20n, priceE18: String(p * 12n / 10n), slippageBps: 500 });
  const ls = await c.limitSell({ id: 'ls', walletId: w1, token: usdc, amount: (await usdcOf(w1)) / 4n, priceE18: String(p * 5n) });
  await tick(3); const lbo = await c.order(lb.id), lso = await c.order(ls.id);
  check('F6 a limit buy whose trigger is met fires and buys real USDC; a limit sell 5x above the market stays active and says why', lbo.status === 'fired' && (await usdcOf(w2)) > uBefore && lso.status === 'active' && /not met/.test(lso.detail.reason ?? ''), `buy ${lbo.status}, sell ${lso.status}: ${lso.detail.reason}`);

  // F7 stop loss fires when price is at or below its trigger
  const u3 = await usdcOf(w1), sl = await c.stopLoss({ id: 'sl', walletId: w1, token: usdc, amount: u3 / 10n, priceE18: String(spot() * 11n / 10n), slippageBps: 500 }); await tick(3);
  check('F7 a stop loss whose trigger is above the price fires and sells exactly its amount of real USDC', (await c.order(sl.id)).status === 'fired' && u3 - (await usdcOf(w1)) === u3 / 10n, `sold ${u3 - (await usdcOf(w1))}`);

  // F8 bracket: stop loss leg fires, take profit leg is cancelled and its reservation released
  const u4 = await usdcOf(w1), br = await c.bracket({ id: 'br', walletId: w1, token: usdc, amount: u4 / 10n, takeProfitE18: String(spot() * 50n), stopLossE18: String(spot() * 11n / 10n), slippageBps: 500 }); await tick(3);
  const [tp, sl2] = [await c.order(br[0].id), await c.order(br[1].id)];
  check('F8 in a bracket the leg that hit fires and the other is cancelled; only one sale happened', sl2.status === 'fired' && tp.status === 'cancelled' && u4 - (await usdcOf(w1)) === u4 / 10n, `tp ${tp.status}, sl ${sl2.status}`);

  // F9 trailing stop: price pushed up then back down by another wallet; the stop fires after the drop from the peak
  const u5 = await usdcOf(w1), tr = await c.trailingStop({ id: 'tr', walletId: w1, token: usdc, amount: u5 / 10n, trailBps: 300, slippageBps: 800 }); await tick(2);
  const base = spot(), X = liq / 12n;
  const up = await trader.buy({ walletId: mover, token: usdc, amount: X, slippageBps: 1500, key: 'push-up' }); await tick(2);
  const peak = BigInt((await c.order(tr.id)).peakE18 ?? 0), stillActive = (await c.order(tr.id)).status === 'active';
  const upU = await usdcOf(mover), dn = await trader.sell({ walletId: mover, token: usdc, amount: upU, slippageBps: 1500, key: 'push-down' }); await tick(3);
  const tro = await c.order(tr.id);
  check('F9 a trailing stop follows the price up (peak rises, not fired), then fires once the price falls 3% from its peak', up.state === 'finalized' && dn.state === 'finalized' && peak > base && stillActive && tro.status === 'fired' && u5 - (await usdcOf(w1)) === u5 / 10n, `base ${base}, peak ${peak}, status ${tro.status}`);

  // F10 bulk buy from two wallets
  const bu = [await usdcOf(w2), await usdcOf(w3)], n2 = [await nonce(w2), await nonce(w3)];
  await c.bulkBuy({ id: 'bb', token: usdc, wallets: [w2, w3], total: U / 5n, slippageBps: 500 }); let bs: any; for (let i = 0; i < 8; i++) { await tick(1); bs = await c.bulk('u1.bb'); if (bs.done) break; }
  check('F10 a bulk buy from 2 wallets: both legs filled from their own wallets, one transaction each, the legs sum to the total', bs.done && bs.filled === 2 && (await usdcOf(w2)) > bu[0] && (await usdcOf(w3)) > bu[1] && (await nonce(w2)) === n2[0] + 1 && (await nonce(w3)) === n2[1] + 1 && BigInt(bs.spent) === U / 5n, `filled ${bs.filled}, spent ${bs.spent}`);

  // F11 TWAP of 3 slices, time moved with evm_increaseTime
  const n3 = await nonce(w3); await c.twap({ id: 'tw', walletId: w3, token: usdc, side: 'buy', total: 3n * U / 10n, slices: 3, intervalS: 300, slippageBps: 500 });
  let tw: any; for (let i = 0; i < 10; i++) { await tick(1); tw = await c.twapStatus('u1.tw'); if (tw.done) break; await node.call('evm_increaseTime', [hex(300n)]); await mine(1); }
  check('F11 a 3-slice TWAP traded one slice per interval: 3 filled, 3 transactions, slices exactly 300 s apart', tw.done && tw.filled === 3 && (await nonce(w3)) === n3 + 3 && tw.slices[1].dueAt - tw.slices[0].dueAt === 300 && tw.slices[2].dueAt - tw.slices[1].dueAt === 300, `filled ${tw.filled}, nonce +${(await nonce(w3)) - n3}`);

  // F12 pause entries
  await c.pauseEntries(); const nP = await nonce(w1); let refused = ''; try { await c.buy({ walletId: w1, token: usdc, amount: U / 100n }); } catch (e) { refused = (e as any).code; }
  const sellWhilePaused = await c.sell({ walletId: w1, token: usdc, amount: (await usdcOf(w1)) / 20n, slippageBps: 500, key: 'sell-paused' }); await c.resumeEntries();
  check('F12 while paused a buy is refused (nothing sent) and a sell still works (one swap, plus its approval)', refused === 'entries_paused' && sellWhilePaused.state === 'finalized' && (await nonce(w1)) - nP === (store.records.has('u1.sell-paused:approve') ? 2 : 1), `buy: ${refused}, sell: ${sellWhilePaused.state}, transactions sent: ${(await nonce(w1)) - nP} (the sell, plus its exact-amount approval)`);

  // F13 restart: a new Trader on the same state directory and engine store finds the order and does not double it
  await c.limitBuy({ id: 'persist', walletId: w2, token: usdc, amount: U / 50n, priceE18: '1' }); trader.stop();
  const t2 = new Trader({ engine, chain, userId: 'u1', venues: [T.family], persistDir: stateDir, advanceChain: () => mine(4) });
  const again = await t2.limitBuy({ id: 'u1.persist', walletId: w2, token: usdc, amount: U / 50n, priceE18: '1' });
  check('F13 after a restart the new Trader loads the active order from its state file and placing the same id again does not create a second one', again.status === 'active' && t2.listOrders().filter(o => o.id === 'u1.persist').length === 1, `files: ${readdirSync(stateDir).join(', ')}`);
  const disk = readdirSync(stateDir).map(f => readFileSync(join(stateDir, f), 'utf8')).join('') + readFileSync(join(dir, 'engine.json'), 'utf8');
  check('F14 no private key material is written to any state file', !secrets.some(k => disk.includes(k)), 'checked engine and trader state files');

  await api.close();
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# SDK and HTTP API on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same `Trader` that the practice-chain tests cover, running over `EvmRpcChain` against the real Uniswap V2 WETH/USDC pool on a forked chain, driven through the real HTTP API and `MemeClient`. Every trade is built, signed under wallet policy, sent and reconciled by OUR engine.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A fork is not mainnet: no mempool competition, MEV, real gas markets or real fills. No real funds were used.', '- Price moves are made by a second throwaway wallet trading the same pool on the fork.', '- Sniping and copy trading through the Trader are not exercised here (their runners have their own fork reports); only the order, bulk, TWAP, pause and restart paths are.'].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runTraderFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-trader-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('traderfork.ts')) main();
