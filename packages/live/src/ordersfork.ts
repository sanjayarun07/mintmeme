/** ORDERS-ON-FORK: price-triggered orders (limit buy, take-profit, stop-loss, OCO) evaluated from REAL Uniswap V2 pool reserves on a local mainnet fork, executed by OUR engine
 *  through EvmRpcChain. Price movement is produced by a competitor swapping in the same pool. Local only: throwaway keys, fake ETH.
 *  usage: npm run verify:orders (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, OrderRunner } from '../../core/src/index.ts';
import type { Order, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20, swapExactETHForTokens } from '../../evm/src/index.ts';
import type { RpcLike, RawSigner } from '../../evm/src/index.ts';
import { LocalNode, newWallet, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8653, ETH1 = 10n ** 18n, E18 = ETH1;

export async function runOrdersFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const head: any = await node.call('eth_getBlockByNumber', ['latest', false]);
  facts.push(`fork of mainnet at block ${big(head.number)}; pool WETH/USDC ${pair}; price = wei per USDC base unit x1e18; local fake ETH only`);
  const usdcBal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const fund = async (w: Wallet, eth = 10n) => { await node.call('anvil_setBalance', [w.address, hex(eth * ETH1)]); };
  const policy = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
  const mkChain = (rpc: RpcLike, signer: RawSigner) => new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
  const wrap = async () => {
    const signer = new CastSigner(), rpc = new FaultRpc(node), w = signer.add(newWallet()); await fund(w);
    const chain = mkChain(rpc, signer), store = new Store();
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'x']]), new Map([[w.address, policy(w.address)]])), router: new Router(chain), platformFeeBps: 0 });
    const runner = new OrderRunner({ engine, chain, clockMs: () => Date.now() }); await chain.refresh('venues');
    return { signer, rpc, w, chain, store, engine, runner };
  };
  type W = Awaited<ReturnType<typeof wrap>>;
  const price = (e: W) => (e.chain.venues()[0] as any).spotPriceE18(usdc, NATIVE) as bigint;
  const order = (e: W, o: Partial<Order>): Order => ({ id: 'o', userId: 'u-' + e.w.address, walletId: e.w.address, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, kind: 'limit_buy', amount: ETH1 / 20n, triggerPriceE18: price(e),
    expiresAt: e.chain.time + 3600, maxQuoteAgeMs: 60_000, minLiquidity: 10n ** 18n, maxDeviationBps: 1000, maxAttempts: 2, slippageBps: 50, venues: ['uniswap-v2'], status: 'active', attempts: 0, ...o });
  const drive = async (e: W) => { for (let i = 0; i < 25; i++) { await e.runner.settle(); if (!e.runner.inflight.size) return; await node.call('anvil_mine', ['0x1']); } };
  const X = newWallet(); await fund(X, 5000n); const xs = new CastSigner(); xs.add(X); let xNonce = 0;
  const competitorBuys = async (eth: bigint, chain: EvmRpcChain) => {   // moves the pool price: buys USDC with ETH
    const t = swapExactETHForTokens({ router, amountIn: eth * ETH1, amountOutMin: 0n, path: [weth, usdc], to: X.address, deadline: BigInt(chain.time) + 900n });
    const raw = xs.sign({ wallet: X.address, to: t.to, data: t.data, value: t.value, nonce: xNonce++, chainId: 1, gasLimit: 500_000n, maxFeePerGas: 300n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [raw]));
  };
  const buyUsdc = async (e: W, key: string, eth = ETH1 / 10n) => { // helper: give the wallet some USDC through the engine itself
    await e.engine.submit({ idempotencyKey: key, userId: 'u-' + e.w.address, walletId: e.w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: usdc, amountIn: eth, minOut: 0n, slippageBps: 100, deadline: e.chain.time + 900, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual' });
    for (let i = 0; i < 25 && !['finalized', 'failed'].includes(e.store.records.get(key)!.state); i++) { await node.call('anvil_mine', ['0x1']); await e.engine.advance(key); }
    await e.chain.refresh('venues');
  };

  // ---- O1: limit buy whose limit is above the market fires at once
  const A = await wrap(); const pA = price(A); facts.push(`pool price at start: ${pA} wei per USDC unit (~${Number(10n ** 30n / pA)} USDC per ETH)`);
  await A.runner.place(order(A, { id: 'o1', triggerPriceE18: pA * 105n / 100n }));
  const t1 = await A.runner.tick(); await drive(A);
  const r1 = A.store.records.get('order:o1:a0');
  check('O1 limit buy above market fires on the first tick', t1.fired.join() === 'o1' && t1.submitted.join() === 'order:o1:a0', JSON.stringify(t1));
  check('O1 engine executed it to finalized; order marked fired; USDC received == fill', r1?.state === 'finalized' && A.runner.orders.orders.get('o1')!.status === 'fired' && (await usdcBal(A.w.address)) === r1.fill?.received && r1.fill!.received > 0n, `${r1?.state}`);
  check('O1 reservation released after the fill', A.runner.reservations.reservedTotal(A.w.address, NATIVE) === 0n);

  // ---- O2: not triggered, illiquid: nothing is sent
  const B = await wrap(); const pB = price(B);
  await B.runner.place(order(B, { id: 'o2', triggerPriceE18: pB * 90n / 100n })); const t2 = await B.runner.tick();
  check('O2 limit below market does not fire; reason recorded; nothing sent', t2.fired.length === 0 && B.runner.orders.orders.get('o2')!.reason === 'trigger not met' && B.rpc.sends === 0, B.runner.orders.orders.get('o2')!.reason ?? '');
  await B.runner.place(order(B, { id: 'o2b', amount: ETH1 / 40n, minLiquidity: 10n ** 30n })); const t2b = await B.runner.tick();
  check('O2 pool liquidity below the order minimum blocks execution', t2b.fired.length === 0 && B.runner.orders.orders.get('o2b')!.reason === 'liquidity below minimum' && B.rpc.sends === 0, B.runner.orders.orders.get('o2b')!.reason ?? '');

  // ---- O3: take-profit fires only after REAL market movement (a competitor buys USDC and lifts the price)
  const C = await wrap(); await buyUsdc(C, 'seed'); const hold = await usdcBal(C.w.address); const pC = price(C);
  await C.runner.place(order(C, { id: 'o3', kind: 'take_profit', token: usdc, quoteToken: NATIVE, amount: hold / 2n, triggerPriceE18: pC * 102n / 100n, maxDeviationBps: 500 }));
  const t3a = await C.runner.tick(); const sendsBefore = C.rpc.sends;
  check('O3 take-profit above market does not fire while the price is below it', t3a.fired.length === 0 && C.runner.orders.orders.get('o3')!.reason === 'trigger not met');
  await competitorBuys(400n, C.chain); await C.chain.refresh('venues'); const pC2 = price(C); facts.push(`O3 price moved ${(Number((pC2 - pC) * 10000n / pC) / 100).toFixed(2)}% after a 400 ETH competitor buy`);
  const t3b = await C.runner.tick(); await drive(C); const r3 = C.store.records.get('order:o3:a0'), ch3 = C.store.records.get('order:o3:a0:approve');
  check('O3 after the price rose past the trigger the order fired and the engine sold (approve + swap)', t3b.fired.join() === 'o3' && r3?.state === 'finalized' && ch3?.state === 'finalized' && C.rpc.sends - sendsBefore === 2, `${r3?.state}${r3?.failure ? ': ' + r3.failure : ''}`);
  check('O3 sold exactly the order amount and kept the rest', r3?.fill?.spent === hold / 2n && (await usdcBal(C.w.address)) === hold - hold / 2n);

  // ---- O4: OCO take-profit / stop-loss: one leg only
  const D = await wrap(); await buyUsdc(D, 'seed'); const holdD = await usdcBal(D.w.address); const pD = price(D);
  await D.runner.place(order(D, { id: 'tp', kind: 'take_profit', ocoGroup: 'g', amount: holdD, triggerPriceE18: pD * 102n / 100n, maxDeviationBps: 500 }));
  await D.runner.place(order(D, { id: 'sl', kind: 'stop_loss', ocoGroup: 'g', amount: holdD, triggerPriceE18: pD * 50n / 100n }));
  check('O4 OCO legs share one reservation', D.runner.reservations.reservedTotal(D.w.address, usdc) === holdD);
  const sendsD = D.rpc.sends; await competitorBuys(400n, D.chain); const t4 = await D.runner.tick(); await drive(D);
  check('O4 exactly one leg executed (take-profit); stop-loss cancelled; approve + swap only', t4.fired.join() === 'tp' && D.runner.orders.orders.get('sl')!.status === 'cancelled' && D.rpc.sends - sendsD === 2 && D.store.records.get('order:tp:a0')?.state === 'finalized', `fired ${t4.fired}`);
  check('O4 position fully sold and reservation released', (await usdcBal(D.w.address)) === 0n && D.runner.reservations.reservedTotal(D.w.address, usdc) === 0n);

  // ---- O5: a front-run reverts attempt 0 on-chain; the order retries with the SAME limits under a new key and succeeds
  const F = await wrap(); const pF = price(F);
  await F.runner.place(order(F, { id: 'o5', triggerPriceE18: pF * 150n / 100n, slippageBps: 10 }));
  F.rpc.beforeSend = async () => { await competitorBuys(150n, F.chain); };
  await F.runner.tick(); await drive(F); const o5 = F.runner.orders.orders.get('o5')!;
  check('O5 attempt 0 reverted on-chain and the order went back to active with attempts=1', F.store.records.get('order:o5:a0')?.state === 'failed' && /reverted on-chain/.test(F.store.records.get('order:o5:a0')?.failure ?? '') && o5.status === 'active' && o5.attempts === 1, `${F.store.records.get('order:o5:a0')?.state} / ${o5.status} / ${o5.attempts}`);
  await F.runner.tick(); await drive(F); const a1 = F.store.records.get('order:o5:a1');
  check('O5 attempt 1 (new key) finalized with slippage unchanged at 10 bps; order fired', a1?.state === 'finalized' && a1.intent.slippageBps === 10 && F.runner.orders.orders.get('o5')!.status === 'fired', `${a1?.state}${a1?.failure ? ': ' + a1.failure : ''}`);
  check('O5 exactly one successful swap overall', (await usdcBal(F.w.address)) === a1?.fill?.received && F.rpc.sends === 2, `sends ${F.rpc.sends}`);

  // ---- O6: node goes down right after the order's tx is sent; restart re-adopts it; re-placing the order cannot double-execute
  const G = await wrap(); const pG = price(G); const og = order(G, { id: 'o6', triggerPriceE18: pG * 105n / 100n });
  await G.runner.place(og); G.rpc.downAfterSend = true; await G.runner.tick();
  check('O6 node down after send: the execution is parked, not failed', G.runner.inflight.size === 1 && !['failed', 'finalized'].includes(G.store.records.get('order:o6:a0')!.state) && G.rpc.sends === 1, G.store.records.get('order:o6:a0')!.state);
  const snap = G.store.snapshot(), rpc2 = new FaultRpc(node), chain2 = mkChain(rpc2, G.signer); const store2 = Store.restore(snap);
  const eng2 = new Engine({ store: store2, chain: chain2, signer: new PolicySigner(new Map([[G.w.address, 'x']]), new Map([[G.w.address, policy(G.w.address)]])), router: new Router(chain2), platformFeeBps: 0 });
  const run2 = new OrderRunner({ engine: eng2, chain: chain2, clockMs: () => Date.now() }); await chain2.refresh('venues'); run2.adopt(); await run2.place(og);
  const G2 = { ...G, runner: run2, engine: eng2, store: store2, chain: chain2, rpc: rpc2 } as W; await drive(G2); await run2.tick(); await drive(G2);
  check('O6 restarted runner finished the SAME tx; re-placed order did not send a second one', store2.records.get('order:o6:a0')?.state === 'finalized' && rpc2.sends === 0 && Number(big(await node.call('eth_getTransactionCount', [G.w.address, 'latest']))) === 1, `sends after restart ${rpc2.sends}`);

  // ---- O7: DURABLE state on disk. Crash right after the send; rebuild everything from the files only.
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-orders-')); const ef = join(dir, 'engine.json'), of = join(dir, 'orders.json');
  const hs = new CastSigner(), hw = hs.add(newWallet()); await fund(hw);
  const build = (rpc: RpcLike) => { const chain = mkChain(rpc, hs), store = Store.open(ef);
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[hw.address, 'x']]), new Map([[hw.address, policy(hw.address)]])), router: new Router(chain), platformFeeBps: 0 });
    return { chain, store, engine, runner: new OrderRunner({ engine, chain, clockMs: () => Date.now(), persistPath: of }) }; };
  const rpcH = new FaultRpc(node), h1 = build(rpcH); await h1.chain.refresh('venues'); const pH = (h1.chain.venues()[0] as any).spotPriceE18(usdc, NATIVE) as bigint;
  const mk7 = (id: string, trig: bigint): Order => ({ id, userId: 'u-' + hw.address, walletId: hw.address, chain: 'evm-fork', token: usdc, quoteToken: NATIVE, kind: 'limit_buy', amount: ETH1 / 20n, triggerPriceE18: trig, expiresAt: h1.chain.time + 3600,
    maxQuoteAgeMs: 60_000, minLiquidity: 10n ** 18n, maxDeviationBps: 1000, maxAttempts: 2, slippageBps: 50, venues: ['uniswap-v2'], status: 'active', attempts: 0 });
  await h1.runner.place(mk7('o7', pH * 105n / 100n)); await h1.runner.place(mk7('o7b', pH * 80n / 100n)); await h1.runner.place(mk7('o7c', pH * 80n / 100n)); h1.runner.cancel('o7c');
  rpcH.downAfterSend = true; await h1.runner.tick();   // o7 fires, tx is sent, then the node goes dark: process "dies" here
  const rpc7 = new FaultRpc(node), h2 = build(rpc7); await h2.chain.refresh('venues');   // fresh objects; only the two files survive
  check('O7 restored orders from disk: fired / active / cancelled, with the in-flight execution recorded', h2.runner.orders.orders.get('o7')!.status === 'fired' && h2.runner.orders.orders.get('o7b')!.status === 'active' && h2.runner.orders.orders.get('o7c')!.status === 'cancelled' && h2.runner.inflight.size === 1, [...h2.runner.orders.orders.values()].map(o => o.id + ':' + o.status).join(' '));
  await h2.runner.resume(); for (let i = 0; i < 25 && h2.runner.inflight.size; i++) { await node.call('anvil_mine', ['0x1']); await h2.runner.settle(); }
  await h2.runner.tick();
  check('O7 restarted from files only: the SAME tx finalized, no second send, one execution, reservation released', h2.store.records.get('order:o7:a0')?.state === 'finalized' && rpc7.sends === 0 && Number(big(await node.call('eth_getTransactionCount', [hw.address, 'latest']))) === 1 && h2.runner.reservations.reservedTotal(hw.address, NATIVE) === ETH1 / 20n, `sends after restart ${rpc7.sends}; reserved ${h2.runner.reservations.reservedTotal(hw.address, NATIVE)} (only o7b's budget)`);
  check('O7 the untriggered order stayed active and the cancelled one did not fire', h2.runner.orders.orders.get('o7b')!.status === 'active' && h2.runner.orders.orders.get('o7c')!.status === 'cancelled');
  const onDisk = readFileSync(ef, 'utf8') + readFileSync(of, 'utf8');
  check('O7 no private key material is written to the state files', !onDisk.includes(hw.key.slice(2)) && !onDisk.includes(hw.key));
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Orders on a mainnet fork — OrderRunner + EvmRpcChain', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: price-triggered orders evaluated from real Uniswap V2 pool reserves (spot price, liquidity, executable output), fired when a real swap in the same pool moves the price, executed by the engine through the real router, with retries, OCO, reservations and restart adoption.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Prices come from one pool\'s reserves read at tick time: no TWAP, no oracle, no cross-venue comparison; a flash-loan style one-block price spike inside this pool would trigger an order (the executable-output and deviation checks limit, not remove, that exposure).', '- Orders and reservations are in memory: after a restart they must be re-placed (in-flight executions are re-adopted and idempotency keys prevent double execution).', '- Trailing stops, market-cap triggers and curve (launchpad) venues are not exercised on a real chain; curve venues expose no spot price here and are reported as not evaluable.', '- Local anvil: no real mempool competition, latency or reorgs. Platform fees are not collected on-chain.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runOrdersFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-orders-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('ordersfork.ts')) main();
