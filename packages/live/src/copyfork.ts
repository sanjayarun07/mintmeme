/** COPY-TRADING-ON-FORK: a leader wallet swaps on a local mainnet fork; OUR LeaderWatcher reads its blocks over JSON-RPC, CopyEngine decides, and the
 *  Engine mirrors the trade for a follower wallet through the real Uniswap V2 router. Reorg, skip and crash-restart cases included.
 *  Local only: throwaway keys, fake ETH, loopback anvil. usage: npm run verify:copy (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, CopyRunner } from '../../core/src/index.ts';
import type { CopyConfig, LeaderEvent, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, LeaderWatcher, encodeCall, decodeParams, erc20, swapExactETHForTokens, swapExactTokensForETH } from '../../evm/src/index.ts';
import type { RpcLike } from '../../evm/src/index.ts';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8654, ETH1 = 10n ** 18n;

export async function runCopyFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const head0: any = await node.call('eth_getBlockByNumber', ['latest', false]);
  facts.push(`fork of mainnet at block ${big(head0.number)}; pool WETH/USDC ${pair}; every transaction is local with fake ETH`);
  const usdcBal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const fund = async (w: Wallet, eth = 10n) => { await node.call('anvil_setBalance', [w.address, hex(eth * ETH1)]); };
  const nonceOf = async (a: string) => Number(big(await node.call('eth_getTransactionCount', [a, 'latest'])));
  const blockNo = async () => Number(big(await node.call('eth_blockNumber')));
  const policy = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
  const mkChain = (rpc: RpcLike, signer: CastSigner) => new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
  const cfgFor = (f: Wallet, leader: Wallet, o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f-' + f.address.slice(2, 8), walletId: f.address, userId: 'u-' + f.address, leader: leader.address, chain: 'evm-fork', quoteToken: NATIVE,
    mode: 'fixed', fixed: ETH1 / 20n, ratioBps: 0, sides: 'both', maxPerLeader: ETH1, maxPerToken: ETH1, dailyLimit: 5n * ETH1, maxPositions: 3, cooldownS: 0, minLiquidity: 10n ** 18n, maxDeviationBps: 300,
    minConfirmations: 0, followLeaderExit: true, slippageBps: 100, venues: ['uniswap-v2'], ...o });

  // leader helpers: the leader signs with its own key and talks to the node directly (we only ever READ it through the watcher)
  const leaderSend = async (L: Wallet, st: { n: number }, tx: { to: string; data: string; value: bigint }, gas = 400_000n) => {
    const raw = signRaw(L, { to: tx.to, data: tx.data, valueWei: tx.value, nonce: st.n++, chainId: 1, gasLimit: gas, maxFeeGwei: '300', priorityGwei: '1' });
    const h = await node.call<string>('eth_sendRawTransaction', [raw]); return node.waitReceipt(h);
  };
  const dl = async () => BigInt(Number(big((await node.call<any>('eth_getBlockByNumber', ['latest', false])).timestamp)) + 3600);
  const leaderBuy = async (L: Wallet, st: { n: number }, eth: bigint) => leaderSend(L, st, swapExactETHForTokens({ router, amountIn: eth, amountOutMin: 0n, path: [weth, usdc], to: L.address, deadline: await dl() }));
  const leaderSellAll = async (L: Wallet, st: { n: number }) => {
    const bal = await usdcBal(L.address); const ap = erc20.approve(usdc, router, bal); await leaderSend(L, st, { to: ap.to, data: ap.data, value: 0n }, 100_000n);
    return leaderSend(L, st, swapExactTokensForETH({ router, amountIn: bal, amountOutMin: 0n, path: [usdc, weth], to: L.address, deadline: await dl() }));
  };
  const newLeader = async () => { const L = newWallet(); await fund(L); return { L, st: { n: 0 } }; };

  const wrap = async (leader: Wallet, o: { cfg?: Partial<CopyConfig>; persist?: { ef: string; cf: string }; signer?: CastSigner; follower?: Wallet; confirmations?: number } = {}) => {
    const signer = o.signer ?? new CastSigner(), rpc = new FaultRpc(node), f = o.follower ?? signer.add(newWallet()); if (!o.follower) await fund(f);
    const chain = mkChain(rpc, signer), store = o.persist ? Store.open(o.persist.ef) : new Store();
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[f.address, 'x']]), new Map([[f.address, policy(f.address)]])), router: new Router(chain), platformFeeBps: 0 });
    const watcher = new LeaderWatcher({ chain: 'evm-fork', weth, leaders: [leader.address], quoteTokens: [NATIVE], minConfirmations: o.confirmations ?? 0, startBlock: (await blockNo()) + 1 }, rpc);
    const seen: LeaderEvent[] = []; const source = { poll: async () => { const r = await watcher.poll(); seen.push(...r.events); return r; }, snapshot: () => watcher.snapshot(), load: (s: any) => watcher.load(s) };
    const cfg = cfgFor(f, leader, o.cfg); const runner = new CopyRunner({ engine, chain, source, cfgs: [cfg], persistPath: o.persist?.cf });
    await chain.refresh('venues'); return { signer, rpc, f, chain, store, engine, runner, cfg, seen, watcher };
  };
  type W = Awaited<ReturnType<typeof wrap>>;
  const drive = async (w: W) => { for (let i = 0; i < 25; i++) { await w.runner.settle(); if (!w.runner.inflight.size) return; await node.call('anvil_mine', ['0x1']); } };
  const copyKeys = (w: W) => [...w.store.records.keys()].filter(k => k.startsWith('copy:') && !k.endsWith(':approve'));
  const X = newWallet(); await fund(X, 5000n); const xs = new CastSigner(); xs.add(X); const xn = { n: 0 };
  const competitorBuys = async (eth: bigint) => { const t = swapExactETHForTokens({ router, amountIn: eth * ETH1, amountOutMin: 0n, path: [weth, usdc], to: X.address, deadline: await dl() });
    const raw = xs.sign({ wallet: X.address, to: t.to, data: t.data, value: t.value, nonce: xn.n++, chainId: 1, gasLimit: 500_000n, maxFeePerGas: 300n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }); await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [raw])); };

  // ---- C1/C2: leader buy is mirrored; the same block is never copied twice
  const { L: L1, st: s1 } = await newLeader(); const A = await wrap(L1);
  const lr = await leaderBuy(L1, s1, ETH1 / 2n); const leaderGot = await usdcBal(L1.address);
  const t1 = await A.runner.tick(); await drive(A); const key = t1.submitted[0], r1 = A.store.records.get(key);
  check('C1 leader swap detected from its block over plain JSON-RPC: one swap event, buy, correct token', A.seen.length === 1 && A.seen[0].kind === 'swap' && A.seen[0].side === 'buy' && A.seen[0].token === usdc && A.seen[0].leader === L1.address, JSON.stringify(A.seen.map(e => [e.kind, e.side, e.token])));
  check('C1 event amounts equal the leader\'s real balance delta and its ETH spent', A.seen[0].tokenAmount === leaderGot && A.seen[0].quoteAmount === ETH1 / 2n && A.seen[0].leaderBalanceAfter === leaderGot && A.seen[0].leaderBalanceBefore === 0n, `event ${A.seen[0]?.tokenAmount} vs balance ${leaderGot}`);
  check('C1 follower mirrored it through the engine: finalized, origin copy, fixed 0.05 ETH, key tied to the leader tx', r1?.state === 'finalized' && r1.intent.origin === 'copy' && r1.intent.amountIn === ETH1 / 20n && key === `copy:${A.cfg.follower}:evm-fork:${lr.transactionHash}:${A.seen[0].logIndex}`, `${r1?.state} ${key}`);
  check('C1 attribution == follower\'s real USDC balance; cost basis == ETH spent', A.runner.copy.attributed(A.cfg.follower, L1.address, usdc) === (await usdcBal(A.f.address)) && A.runner.copy.exposure(A.cfg.follower, L1.address) === r1?.fill?.spent && r1!.fill!.received > 0n);
  const sends1 = A.rpc.sends; const t2 = await A.runner.tick(); await A.runner.tick();
  check('C2 re-scanning with no new leader trade sends nothing', t2.events === 0 && t2.submitted.length === 0 && A.rpc.sends === sends1 && copyKeys(A).length === 1);

  // ---- C3: leader exits; follower sells only what it bought for this leader; unrelated holding untouched
  const { L: L3, st: s3 } = await newLeader(); const B = await wrap(L3);
  const seed = swapExactETHForTokens({ router, amountIn: ETH1 / 10n, amountOutMin: 0n, path: [weth, usdc], to: B.f.address, deadline: await dl() });
  const seedRaw = B.signer.sign({ wallet: B.f.address, to: seed.to, data: seed.data, value: seed.value, nonce: 0, chainId: 1, gasLimit: 400_000n, maxFeePerGas: 300n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }); await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [seedRaw]));
  const seedBal = await usdcBal(B.f.address);
  await leaderBuy(L3, s3, ETH1 / 2n); const tb = await B.runner.tick(); await drive(B); const mine = B.runner.copy.attributed(B.cfg.follower, L3.address, usdc), afterBuy = await usdcBal(B.f.address);
  const sendsB = B.rpc.sends; await leaderSellAll(L3, s3); const ts = await B.runner.tick(); await drive(B); const rs = B.store.records.get(ts.submitted[0]);
  check('C3 follower held unrelated USDC before copying; the copied buy added exactly the attributed amount', tb.submitted.length === 1 && afterBuy === seedBal + mine && mine > 0n, `seed ${seedBal}, attributed ${mine}`);
  check('C3 leader sold everything: follower sold exactly its attributed tokens (approve + swap), unrelated holding intact', rs?.state === 'finalized' && rs.intent.amountIn === mine && (await usdcBal(B.f.address)) === seedBal && B.rpc.sends - sendsB === 2, `sold ${rs?.intent.amountIn} of attributed ${mine}`);
  check('C3 attribution back to zero; leader position closed', B.runner.copy.attributed(B.cfg.follower, L3.address, usdc) === 0n && B.runner.copy.positionStatus(B.cfg.follower, L3.address, usdc) === 'none');

  // ---- C4: price moved after the leader traded -> skipped with a reason, nothing sent
  const { L: L4, st: s4 } = await newLeader(); const C = await wrap(L4, { cfg: { maxDeviationBps: 100 } });
  await leaderBuy(L4, s4, ETH1 / 2n); await competitorBuys(800n); const t4 = await C.runner.tick();
  check('C4 pool price moved beyond the 1% limit before we could follow: skipped, reason recorded, nothing sent', t4.submitted.length === 0 && C.rpc.sends === 0 && C.runner.copy.log.some(l => l.decision === 'skip: price moved beyond deviation limit'), JSON.stringify(C.runner.copy.log.map(l => l.decision)));

  // ---- C5: leader tx REORGED OUT after a fast (0-conf) copy: position flagged, attribution reversed, no automatic sell
  const { L: L5, st: s5 } = await newLeader(); const D = await wrap(L5); const snapId = await node.call<string>('evm_snapshot');
  await leaderBuy(L5, s5, ETH1 / 2n); const t5 = await D.runner.tick(); await drive(D); const k5 = t5.submitted[0], raw5 = D.store.records.get(k5)!.tx!.raw!;
  const had = D.runner.copy.attributed(D.cfg.follower, L5.address, usdc);
  const reverted = await node.call<boolean>('evm_revert', [snapId]);                         // the whole chain after the snapshot disappears, including the leader's trade AND our copy
  await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [raw5])).catch(() => undefined);   // our copy tx is mined again, standing alone (the leader's tx is gone)
  for (let i = 0; i < 4; i++) await node.call('anvil_mine', ['0x1']);
  const sends5 = D.rpc.sends; const t5b = await D.runner.tick();
  check('C5 chain reorg removed the leader\'s transaction; watcher reported it', reverted === true && t5b.reorged === 1, `reverted ${reverted}, reorged ${t5b.reorged}`);
  check('C5 follower position flagged orphaned, attribution reversed, tokens still held, NO automatic sell sent', D.runner.copy.positionStatus(D.cfg.follower, L5.address, usdc) === 'orphaned' && had > 0n && D.runner.copy.attributed(D.cfg.follower, L5.address, usdc) === 0n && (await usdcBal(D.f.address)) > 0n && D.rpc.sends === sends5 && t5b.submitted.length === 0, D.runner.copy.orphanReason(D.cfg.follower, L5.address, usdc) ?? '');

  // ---- C6: durable restart. Crash after the write-ahead checkpoint but before the hand-over to the engine; rebuild from the two files only.
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-copyfork-')), files = { ef: join(dir, 'engine.json'), cf: join(dir, 'copy.json') };
  const { L: L6, st: s6 } = await newLeader(); const h1 = await wrap(L6, { persist: files }); const lr6 = await leaderBuy(L6, s6, ETH1 / 2n);
  (h1.engine as any).submit = async () => { throw new Error('process killed'); };
  let crashed = false; try { await h1.runner.tick(); } catch (e) { crashed = /process killed/.test((e as Error).message); }
  const h2 = await wrap(L6, { persist: files, signer: h1.signer, follower: h1.f });                  // fresh objects: only the files survive
  check('C6 crash left the copy decision on disk: one intent waiting in the outbox, cursor already past the leader block', crashed && h2.runner.outbox.length === 1 && (await nonceOf(h1.f.address)) === 0 && h2.watcher.cursor! > Number(big(lr6.blockNumber)), `outbox ${h2.runner.outbox.length}`);
  await h2.runner.resume(); await drive(h2); await h2.runner.tick(); await drive(h2);
  check('C6 restarted from files only: exactly ONE copy tx on chain, finalized, attributed once', (await nonceOf(h1.f.address)) === 1 && copyKeys(h2).length === 1 && h2.store.records.get(copyKeys(h2)[0])!.state === 'finalized' && h2.runner.copy.attributed(h2.cfg.follower, L6.address, usdc) === (await usdcBal(h1.f.address)), `nonce ${await nonceOf(h1.f.address)}`);
  const onDisk = readFileSync(files.ef, 'utf8') + readFileSync(files.cf, 'utf8');
  check('C6 no private key material is written to the state files', !onDisk.includes(h1.signer.keys.get(h1.f.address)!.key.slice(2)));
  facts.push('copy settings used: fixed 0.05 ETH per leader buy, slippage 1%, price-deviation limit 3% (1% in C4), 0 confirmations (fast mode)');
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Copy trading on a mainnet fork — LeaderWatcher + CopyEngine + Engine over JSON-RPC', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: a leader swap mined on the fork is detected from block data and receipts over plain JSON-RPC, filtered by the copy rules, and mirrored by OUR engine through the real Uniswap V2 router; leader exits close only attributed inventory; a leader-tx reorg flags the position without auto-selling; a crash between decision and hand-over resumes with exactly one execution.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Only transactions SENT BY the leader EOA are seen: smart-contract wallets, aggregator-internal swaps and bundled/relayed txs are not.', '- No mempool: the earliest signal is a mined leader block, so followers always trade after the leader (no front-running, and the leader\'s own price impact is already in the pool).',
    '- Leader and follower are both ours on a private fork: no competing bots, no MEV, no real latency.', '- Only WETH/USDC through Uniswap V2; tax, honeypot and rebasing tokens are not exercised here.', '- The reorg is simulated with evm_snapshot/evm_revert and re-sending our own tx; a real reorg can also move or reorder our tx.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runCopyFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-copy-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('copyfork.ts')) main();
