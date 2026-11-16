/** BULK BUY AND BULK SELL (multi-wallet) ON A LOCAL ETHEREUM MAINNET FORK. Five throwaway wallets buy USDC from the real Uniswap V2 WETH/USDC pool through ONE BulkRunner, then sell part of it back
 *  through another: each leg is an ordinary Engine intent from its own wallet, executed through EvmRpcChain and the real router. Sells go through the engine's automatic exact-amount approval.
 *  Local only: throwaway keys, fake ETH, dev-only signer, loopback anvil. usage: npm run verify:bulk-evm (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, BulkRunner } from '../../core/src/index.ts';
import type { BulkSpec, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import type { RpcLike, RawSigner } from '../../evm/src/index.ts';
import { newWallet, hex, big } from './localnode.ts';
import type { LocalNode } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8661, ETH1 = 10n ** 18n;

export async function runBulkEvmFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const head: any = await node.call('eth_getBlockByNumber', ['latest', false]);
  facts.push(`fork of mainnet at block ${big(head.number)}; pool WETH/USDC ${pair}; local fake ETH only, 5 funded throwaway wallets plus one with no ETH`);
  const usdcBal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const ethBal = async (a: string) => big(await node.call<string>('eth_getBalance', [a, 'latest']));
  const policy = (): WalletPolicy => ({ userId: 'u1', chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
  const signer = new CastSigner(), rpc = new FaultRpc(node);
  const wallets = Array.from({ length: 5 }, () => signer.add(newWallet()).address); for (const w of wallets) await node.call('anvil_setBalance', [w, hex(10n * ETH1)]);
  const poor = signer.add(newWallet()).address;                                      // no ETH at all
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-bulkevm-')), ef = join(dir, 'engine.json'), bf = join(dir, 'bulk.json');
  const mk = (persist = false, rpcOver?: RpcLike) => {
    const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpcOver ?? rpc, signer as RawSigner), store = persist ? Store.open(ef) : new Store();
    const all = [...wallets, poor], engine = new Engine({ store, chain, signer: new PolicySigner(new Map(all.map(w => [w, 'x'])), new Map(all.map(w => [w, policy()]))), router: new Router(chain), platformFeeBps: 0 });
    return { chain, store, engine };
  };
  const spec = (legs: BulkSpec['legs'], o: Partial<BulkSpec> = {}): BulkSpec => ({ id: 'bulk1', userId: 'u1', chain: 'evm-fork', token: usdc, quoteToken: NATIVE, venues: ['uniswap-v2'], legs, slippageBps: 300, ...o });
  const run = async (r: BulkRunner, m: { chain: EvmRpcChain }) => { for (let i = 0; i < 80; i++) { await r.tick(); await node.call('anvil_mine', ['0x1']); await r.settle(); await m.chain.refresh('venues'); if (r.summary().done) break; } return r.summary(); };
  const nonceOf = async (a: string) => Number(big(await node.call<string>('eth_getTransactionCount', [a, 'latest'])));

  // ---- buy: five wallets of different sizes plus one that cannot fund its leg
  const M = mk(true); await M.chain.refresh('venues');
  const ethBefore = await Promise.all(wallets.map(ethBal));
  const legs = wallets.map((w, i) => ({ walletId: w, amount: BigInt(1 + i) * ETH1 / 4n }));      // 0.25, 0.5, 0.75, 1.0, 1.25 ETH
  const R = new BulkRunner({ engine: M.engine, chain: M.chain, spec: spec([...legs, { walletId: poor, amount: ETH1 / 10n }], { maxTotal: 5n * ETH1 }), persistPath: bf });
  const sum = await run(R, M);
  check('E1 five wallets each bought USDC through the engine and finalized; the sixth, which had no ETH, was skipped with a reason and nothing was sent for it',
    sum.filled === 5 && sum.skipped === 1 && sum.legs[5].status === 'skipped' && /balance 0 is below/.test(sum.legs[5].reason ?? '') && (await nonceOf(poor)) === 0, `filled ${sum.filled}, skipped ${sum.skipped}: ${sum.legs[5].reason}`);
  const got = await Promise.all(wallets.map(usdcBal)), ethAfter = await Promise.all(wallets.map(ethBal));
  check('E2 each wallet holds exactly the USDC its own engine record says it received, and the summary adds up', got.every((g, i) => g === sum.legs[i].received && g > 0n) && sum.received === got.reduce((a, b) => a + b, 0n), `total ${sum.received} USDC base units`);
  check('E3 each wallet\'s ETH fell by its leg plus the network fee and nothing else', ethAfter.every((a, i) => { const rec = M.store.records.get(`bulk:bulk1:${wallets[i]}`)!; return ethBefore[i] - a === rec.fill!.spent + rec.fill!.networkFee && rec.fill!.spent === legs[i].amount; }));
  const per = sum.legs.slice(0, 5).map(l => Number(l.received!) / Number(l.spent!));
  check('E4 legs ran one after another on the pool as the earlier legs left it: USDC per ETH fell with every leg (price moved up)', per.every((p, i) => i === 0 || p < per[i - 1]), per.map(p => (p * 1e12).toFixed(3)).join(' > ') + ' (USDC per ETH, scaled)');

  // ---- restart: same bulk id, fresh objects, same files -> nothing new is bought
  const M2 = mk(true); await M2.chain.refresh('venues');
  const R2 = new BulkRunner({ engine: M2.engine, chain: M2.chain, spec: spec([...legs, { walletId: poor, amount: ETH1 / 10n }], { maxTotal: 5n * ETH1 }), persistPath: bf });
  const nonces = await Promise.all(wallets.map(nonceOf)); await R2.resume(); const s2 = await run(R2, M2);
  check('E5 restarting from the saved files and running the same bulk id again sends nothing more and buys nothing more', s2.filled === 5 && (await Promise.all(wallets.map(nonceOf))).every((n, i) => n === nonces[i]) && (await Promise.all(wallets.map(usdcBal))).every((g, i) => g === got[i]));

  // ---- impact limit judged on the TOTAL
  const M3 = mk(); const sends0 = rpc.sends;
  const R3 = new BulkRunner({ engine: M3.engine, chain: M3.chain, spec: spec(wallets.map(w => ({ walletId: w, amount: 2n * ETH1 })), { id: 'bulk-impact', maxImpactBps: 1 }) }); const s3 = await run(R3, M3);
  check('E6 a total that would move the pool more than the 1 bp limit is refused for every leg, with the measured impact in the reason, and nothing is sent', !!s3.refused && /bps, above the 1 bps limit/.test(s3.refused) && s3.skipped === 5 && rpc.sends === sends0, s3.refused ?? '');

  // ---- bulk SELL: each wallet sells half of its USDC; the engine adds the exact-amount approval
  const M4 = mk(); await M4.chain.refresh('venues');
  const sellLegs = wallets.map((w, i) => ({ walletId: w, amount: got[i] / 2n })), usdcBefore = await Promise.all(wallets.map(usdcBal)), ethBefore2 = await Promise.all(wallets.map(ethBal));
  const R4 = new BulkRunner({ engine: M4.engine, chain: M4.chain, spec: spec([...sellLegs, { walletId: poor, amount: 1000n }], { id: 'sell1', side: 'sell' }) }); const s4 = await run(R4, M4);
  check('E7 five wallets each sold half their USDC through the engine and finalized; the wallet holding no USDC was skipped with a reason', s4.filled === 5 && s4.skipped === 1 && /balance 0 is below/.test(s4.legs[5].reason ?? ''), `filled ${s4.filled}, skipped ${s4.skipped}`);
  const usdcAfter = await Promise.all(wallets.map(usdcBal)), ethAfter2 = await Promise.all(wallets.map(ethBal));
  const diag = await Promise.all(wallets.map(async (w, i) => { const rec = M4.store.records.get(`bulk:sell1:${w}`)!, ap = [...M4.store.records].filter(([k]) => k.startsWith(`bulk:sell1:${w}`) && k.endsWith(':approve')).map(([, r]) => r);
    const apFee = (await Promise.all(ap.map(async r => (await M4.chain.receipt(r.tx!.hash))?.network ?? 0n))).reduce((a, f) => a + f, 0n);   // the approval is not a swap, so its gas comes from its own receipt
    return { usdcOk: usdcBefore[i] - usdcAfter[i] === sellLegs[i].amount, ethDelta: ethAfter2[i] - ethBefore2[i], received: rec.fill!.received, fee: rec.fill!.networkFee, apFee }; }));
  check('E8 each wallet gave up exactly its leg of USDC, and its ETH rose by the proceeds minus the network fees of the approval and the swap', diag.every(d => d.usdcOk && d.apFee > 0n && d.ethDelta === d.received - d.fee - d.apFee), JSON.stringify(diag[0], (_, v) => typeof v === 'bigint' ? v.toString() : v));
  const approves = [...M4.store.records.keys()].filter(k => k.startsWith('bulk:sell1:') && k.endsWith(':approve')).length;
  check('E9 each sell was preceded by one exact-amount approval (a child transaction), not an unlimited one', approves === 5, `${approves} approval records`);
  const R5 = new BulkRunner({ engine: M4.engine, chain: M4.chain, spec: spec(sellLegs, { id: 'sell1', side: 'sell' }) }); const nn = await Promise.all(wallets.map(nonceOf)); await run(R5, M4);
  check('E10 running the same sell id again sells nothing more', (await Promise.all(wallets.map(nonceOf))).every((n, i) => n === nn[i]) && (await Promise.all(wallets.map(usdcBal))).every((u, i) => u === usdcAfter[i]));

  // ---- parallel mode: three wallets send in the SAME tick (before any block is mined), then all finalize
  const P = mk(false); await P.chain.refresh('venues'); const n0 = await Promise.all(wallets.slice(0, 3).map(nonceOf));
  const RP = new BulkRunner({ engine: P.engine, chain: P.chain, spec: spec(wallets.slice(0, 3).map(w => ({ walletId: w, amount: ETH1 / 20n })), { id: 'bulk-par', mode: 'parallel', maxTotal: ETH1 }) });
  await RP.tick(); const mid = RP.summary(), sentTogether = mid.legs.filter(l => l.status !== 'pending').length;   // anvil mines each transaction at once, so by the end of the tick an early leg may already be final
  const sp = await run(RP, P); const n1 = await Promise.all(wallets.slice(0, 3).map(nonceOf));
  check('E12 parallel mode: all three legs were sent in the very first tick (none left waiting for an earlier leg), and all three finalized', sentTogether === 3 && sp.filled === 3 && sp.failed === 0, `legs sent by the end of the first tick ${sentTogether}; filled ${sp.filled}, failed ${sp.failed}, skipped ${sp.skipped}`);
  check('E13 parallel mode: each wallet sent exactly one transaction of its own (nonce +1 each)', n1.every((n, i) => n === n0[i] + 1), `nonces ${n0.join(',')} -> ${n1.join(',')}`);

  // ---- stop mode: the second leg is over the wallet's per-transaction limit (the engine refuses it), so the legs after it must not be sent
  const S = mk(false); await S.chain.refresh('venues'); const n2 = await Promise.all([wallets[0], wallets[4], wallets[1], wallets[2]].map(nonceOf));
  const RS = new BulkRunner({ engine: S.engine, chain: S.chain, spec: spec([{ walletId: wallets[0], amount: ETH1 / 20n }, { walletId: wallets[4], amount: 6n * ETH1 }, { walletId: wallets[1], amount: ETH1 / 20n }, { walletId: wallets[2], amount: ETH1 / 20n }], { id: 'bulk-stop', onFailure: 'stop' }) });
  const ss = await run(RS, S); const n3 = await Promise.all([wallets[0], wallets[4], wallets[1], wallets[2]].map(nonceOf));
  const st = ss.legs.map(l => l.status);
  check('E14 stop mode: leg 1 filled, leg 2 (over the wallet limit) failed with a reason, legs 3 and 4 were skipped as "stopped after an earlier leg failed"', st.join() === 'filled,failed,skipped,skipped' && !!ss.legs[1].reason && /stopped after an earlier leg failed/.test(ss.legs[2].reason ?? '') , `statuses ${st.join(',')}; leg 2 reason: ${ss.legs[1].reason ?? 'none'}`);
  check('E15 stop mode: only the first wallet sent a transaction; the refused and the skipped wallets sent nothing', n3[0] === n2[0] + 1 && n3[1] === n2[1] && n3[2] === n2[2] && n3[3] === n2[3], `nonce change ${n3.map((n, i) => n - n2[i]).join(',')}`);

  // ---- the terminal's own endpoint with a separate amount per wallet (what the Orders page sends), against the same fork
  const { createLive } = await import('../../../apps/web/livemode.ts'); const live = await createLive(node), lapi = (pth: string, b: unknown = {}, m = 'POST') => live.api(pth, b, m) as Promise<any>;
  const amtA = ETH1 / 100n, amtB = 3n * ETH1 / 100n;                                   // 0.01 ETH and 0.03 ETH: different on purpose
  const before = await Promise.all(['w1', 'w2'].map(id => usdcBal(live.wallets[id].address)));
  const started = await lapi('/api/bulk', { side: 'buy', walletIds: ['w1', 'w2'], total: String(amtA + amtB), amounts: { w1: String(amtA), w2: String(amtB) }, mode: 'sequential' });
  let view: any; for (let i = 0; i < 60; i++) { await node.call('anvil_mine', ['0x1']); await live.settle(); view = (await lapi('/api/bulk', {}, 'GET'))[0]; if (view?.done) break; await new Promise(r => setTimeout(r, 250)); }
  const after = await Promise.all(['w1', 'w2'].map(id => usdcBal(live.wallets[id].address)));
  check('E16 the terminal\'s multi-wallet endpoint with a separate amount per wallet: the two legs carry 0.01 and 0.03 ETH (not an equal split) and both finalized', started.ok === true && view?.done && view.legs.length === 2 && String(view.legs[0].amount) === String(amtA) && String(view.legs[1].amount) === String(amtB) && view.legs.every((l: any) => l.status === 'filled'), JSON.stringify(view?.legs?.map((l: any) => [l.wallet, String(l.amount), l.status])));
  check('E17 each wallet received USDC from its own leg, and the bigger leg bought more USDC', after[0] - before[0] > 0n && after[1] - before[1] > after[0] - before[0], `w1 +${after[0] - before[0]}, w2 +${after[1] - before[1]}`);

  const onDisk = readFileSync(ef, 'utf8') + readFileSync(bf, 'utf8');
  check('E11 no private key material is written to the state files', ![...signer.keys.values()].some(w => onDisk.includes(w.key.slice(2))));
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Bulk buy and bulk sell (multi-wallet) on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: one BulkRunner request buys, then sells, the same token from several wallets on the real Uniswap V2 WETH/USDC pool. Each leg is an ordinary Engine intent from its own wallet with its own policy and idempotency key, executed through EvmRpcChain and the real router. Sequential mode prices every leg on the pool as the earlier legs left it.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- NOT atomic: legs are independent transactions. Any can fail while others land; the summary lists each leg.', '- Parallel mode (3 wallets, one tick) and stop-on-failure mode were run on this fork; the "continue" policy with a failed leg is covered by the simulated-chain tests only.', '- One pool, one block of history, a node with no other traffic: no mempool competition, no MEV, no real gas market.', '- Throwaway keys and a dev-only signer; real custody (HSM) is not exercised.', ''].join('\n') };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runBulkEvmFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-bulk-evm-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('bulkevmfork.ts')) main();
