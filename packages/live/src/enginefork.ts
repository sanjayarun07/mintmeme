/** ENGINE-ON-FORK: runs OUR engine (state machine, idempotency, reconcile, signer policy) over EvmRpcChain against a local mainnet fork (anvil),
 *  through the real Uniswap V2 router bytecode. Faults are injected at the RPC layer: lost ack, node down mid-flight + restart, a front-run that makes minOut fail on-chain.
 *  Everything is local: throwaway keys, fake ETH. usage: npm run verify:engine (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { Intent, TxRecord, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20, planApproval, swapExactETHForTokens, getAmountOut, decodeReserves } from '../../evm/src/index.ts';
import type { RawSigner, RpcLike } from '../../evm/src/index.ts';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8652, ETH1 = 10n ** 18n, gwei = (x: bigint) => (Number(x) / 1e9).toFixed(9);
const TERMINAL = new Set(['finalized', 'failed', 'expired']);

export class CastSigner implements RawSigner {
  keys = new Map<string, Wallet>();
  add(w: Wallet) { this.keys.set(w.address, w); return w; }
  sign(r: Parameters<RawSigner['sign']>[0]) {
    const w = this.keys.get(r.wallet); if (!w) throw new Error(`no dev key for ${r.wallet}`);
    return signRaw(w, { to: r.to, valueWei: r.value, nonce: r.nonce, chainId: r.chainId, gasLimit: r.gasLimit, maxFeeGwei: gwei(r.maxFeePerGas), priorityGwei: gwei(r.maxPriorityFeePerGas), data: r.data === '0x' ? undefined : r.data });
  }
}
/** RPC wrapper with fault injection. Transport faults throw a plain Error (as a dropped connection would); node rejections are JsonRpcError from LocalNode. */
export class FaultRpc implements RpcLike {
  sends = 0; down = false; dropAckOnce = false; downAfterSend = false; beforeSend?: () => Promise<void>;
  constructor(private node: LocalNode) {}
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (this.down) throw new Error('ECONNREFUSED (injected)');
    if (method === 'eth_sendRawTransaction') {
      await this.beforeSend?.(); this.beforeSend = undefined; this.sends++;
      const r = await this.node.call<T>(method, params);
      if (this.downAfterSend) { this.down = true; this.downAfterSend = false; throw new Error('connection reset after send (injected)'); }
      if (this.dropAckOnce) { this.dropAckOnce = false; throw new Error('connection reset after send (injected)'); }
      return r;
    }
    return this.node.call<T>(method, params);
  }
}

export async function runEngineFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const head: any = await node.call('eth_getBlockByNumber', ['latest', false]);
  facts.push(`fork of mainnet at block ${big(head.number)}; pool WETH/USDC ${pair}; all transactions local, fake ETH, throwaway keys`);
  const usdcBal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const ethBal = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));
  const fund = async (w: Wallet, eth = 10n) => { await node.call('anvil_setBalance', [w.address, hex(eth * ETH1)]); };
  const policy = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 12n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 13n }, destinations: [], deviceSecret: 'dev' });
  const mkChain = (rpc: RpcLike, signer: RawSigner) => new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
  const mkEngine = (chain: EvmRpcChain, store: Store, w: Wallet, feeBps = 0) => new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'hmac-standin']]), new Map([[w.address, policy(w.address)]])), router: new Router(chain), platformFeeBps: feeBps });
  const intent = (w: Wallet, key: string, chain: EvmRpcChain, o: Partial<Intent> = {}): Intent => ({ idempotencyKey: key, userId: 'u-' + w.address, walletId: w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: usdc,
    amountIn: ETH1 / 10n, minOut: 0n, slippageBps: 50, deadline: chain.time + 900, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual', ...o });
  const settle = async (engine: Engine, key: string): Promise<TxRecord> => {
    let r = await engine.advance(key);
    for (let i = 0; i < 25 && !TERMINAL.has(r.state); i++) { await node.call('anvil_mine', ['0x1']); r = await engine.advance(key); }
    return r;
  };
  const wrap = (): { signer: CastSigner; rpc: FaultRpc; chain: EvmRpcChain; w: Wallet } => { const signer = new CastSigner(), rpc = new FaultRpc(node), w = signer.add(newWallet()); return { signer, rpc, chain: mkChain(rpc, signer), w }; };

  // ---- E1: buy through the engine
  const A = wrap(); await fund(A.w); await A.chain.refresh('head');
  const storeA = new Store(), engA = mkEngine(A.chain, storeA, A.w);
  const ethA0 = await ethBal(A.w.address);
  let r = await engA.submit(intent(A.w, 'e1', A.chain)); const quote = r.quote!.amountOut; r = await settle(engA, 'e1');
  check('E1 buy reaches finalized through the engine', r.state === 'finalized', `${r.state}${r.failure ? ': ' + r.failure : ''}`);
  const got = await usdcBal(A.w.address);
  check('E1 fill.received == USDC balance == the quote the engine made', r.fill?.received === got && got === quote, `received ${r.fill?.received}, balance ${got}, quote ${quote}`);
  const rcA: any = await node.call('eth_getTransactionReceipt', [r.tx!.hash]); const gasA = big(rcA.gasUsed) * big(rcA.effectiveGasPrice);
  check('E1 engine tx hash (keccak of our raw bytes) == the hash the node reports', rcA.transactionHash === r.tx!.hash);
  check('E1 networkFee == gasUsed*effectiveGasPrice and ETH spent == amountIn + networkFee', r.fill?.networkFee === gasA && ethA0 - (await ethBal(A.w.address)) === ETH1 / 10n + gasA, `gas ${gasA}`);
  check('E1 platform fee is 0 (nothing is collected on-chain)', r.fill?.platformFee === 0n);

  // ---- E2: idempotency
  const again = await engA.submit(intent(A.w, 'e1', A.chain));
  await Promise.all([engA.submit(intent(A.w, 'e1', A.chain)), engA.submit(intent(A.w, 'e1', A.chain)), engA.submit(intent(A.w, 'e1', A.chain))]);
  check('E2 resubmitting / concurrently submitting the same key executes once', again.state === 'finalized' && A.rpc.sends === 1 && Number(big(await node.call('eth_getTransactionCount', [A.w.address, 'latest']))) === 1 && (await usdcBal(A.w.address)) === got, `sends ${A.rpc.sends}`);

  // ---- E3: lost ack
  const B = wrap(); await fund(B.w); await B.chain.refresh('head'); const engB = mkEngine(B.chain, new Store(), B.w);
  B.rpc.dropAckOnce = true; await engB.submit(intent(B.w, 'e3', B.chain)); r = await settle(engB, 'e3');
  check('E3 lost submit ack: finalized, exactly one send, one execution', r.state === 'finalized' && B.rpc.sends === 1 && Number(big(await node.call('eth_getTransactionCount', [B.w.address, 'latest']))) === 1, `state ${r.state}, sends ${B.rpc.sends}`);
  check('E3 the history shows the engine reconciled instead of resending', r.history.some(h => /ack lost|reconciled|already known/.test(h.note ?? '')), r.history.map(h => h.state + (h.note ? `(${h.note})` : '')).join(' > '));

  // ---- E4: node goes down right after the send, process restarts from persisted state
  const C = wrap(); await fund(C.w); await C.chain.refresh('head'); const storeC = new Store(), engC = mkEngine(C.chain, storeC, C.w);
  C.rpc.downAfterSend = true; r = await engC.submit(intent(C.w, 'e4', C.chain));
  check('E4 node down after send: trade is parked (unresolved/signed), not failed', !['failed', 'finalized'].includes(r.state) && C.rpc.sends === 1, r.state);
  const snap = storeC.snapshot(), rpc2 = new FaultRpc(node), chain2 = mkChain(rpc2, C.signer); await chain2.refresh('head'); const eng2 = mkEngine(chain2, Store.restore(snap), C.w);
  r = await settle(eng2, 'e4');
  check('E4 restarted engine resumes the SAME tx: finalized, no second send, one execution', r.state === 'finalized' && rpc2.sends === 0 && Number(big(await node.call('eth_getTransactionCount', [C.w.address, 'latest']))) === 1, `state ${r.state}, sends after restart ${rpc2.sends}`);

  // ---- E5: front-run -> minOut fails ON CHAIN
  const D = wrap(); await fund(D.w); await D.chain.refresh('head'); const engD = mkEngine(D.chain, new Store(), D.w);
  const X = newWallet(); await fund(X, 1000n);
  D.rpc.beforeSend = async () => {   // a competitor buys 300 ETH of USDC first, moving the price well beyond our 10 bps tolerance
    const cs = new CastSigner(); cs.add(X); const t = swapExactETHForTokens({ router, amountIn: 300n * ETH1, amountOutMin: 0n, path: [weth, usdc], to: X.address, deadline: BigInt(D.chain.time) + 900n });
    const raw = cs.sign({ wallet: X.address, to: t.to, data: t.data, value: t.value, nonce: 0, chainId: 1, gasLimit: 400_000n, maxFeePerGas: 200n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    const h = await node.call<string>('eth_sendRawTransaction', [raw]); await node.waitReceipt(h);
  };
  const ethD0 = await ethBal(D.w.address);
  r = await engD.submit(intent(D.w, 'e5', D.chain, { slippageBps: 10 })); r = await settle(engD, 'e5');
  check('E5 front-run: engine ends failed with "reverted on-chain", no fill', r.state === 'failed' && /reverted on-chain/.test(r.failure ?? '') && r.fill === undefined, `${r.state}: ${r.failure}`);
  const rcD: any = await node.call('eth_getTransactionReceipt', [r.tx!.hash]);
  check('E5 reverted tx moved no USDC and cost exactly its gas', (await usdcBal(D.w.address)) === 0n && ethD0 - (await ethBal(D.w.address)) === big(rcD.gasUsed) * big(rcD.effectiveGasPrice) && rcD.status === '0x0', `status ${rcD.status}`);

  // ---- E6: sell through the engine; the engine itself approves EXACTLY the sell amount first (child transaction)
  await A.chain.refresh('head'); const ethA1 = await ethBal(A.w.address);
  const allowanceOf = async (owner: string) => { const q = erc20.allowance(usdc, owner, router); return erc20.decodeUint(await call(q.to, q.data)); };
  const sendsA = A.rpc.sends;
  r = await engA.submit(intent(A.w, 'e6', A.chain, { tokenIn: usdc, tokenOut: NATIVE, amountIn: got })); const sellQuote = r.quote?.amountOut; r = await settle(engA, 'e6');
  check('E6 sell reaches finalized through the engine (approval handled by the engine)', r.state === 'finalized', `${r.state}${r.failure ? ': ' + r.failure : ''}`);
  const child = storeA.records.get('e6:approve');
  check('E6 an approval child tx was created, is finalized, and approved exactly the sell amount', !!child && child.state === 'finalized' && child.tx?.kind === 'approve' && child.tx.amountIn === got && child.tx.spender === router.toLowerCase(), child ? `${child.state}, amount ${child.tx?.amountIn}` : 'no child');
  check('E6 allowance is fully used afterwards (never left open or unlimited)', (await allowanceOf(A.w.address)) === 0n, `allowance ${await allowanceOf(A.w.address)}`);
  check('E6 exactly two transactions were sent (approve, swap)', A.rpc.sends - sendsA === 2, `${A.rpc.sends - sendsA}`);
  const rcS: any = r.tx ? await node.call('eth_getTransactionReceipt', [r.tx.hash]) : undefined; const gasS = rcS ? big(rcS.gasUsed) * big(rcS.effectiveGasPrice) : 0n;
  const rcAp: any = child?.tx ? await node.call('eth_getTransactionReceipt', [child.tx.hash]) : undefined; const gasAp = rcAp ? big(rcAp.gasUsed) * big(rcAp.effectiveGasPrice) : 0n;
  check('E6 approval tx hash == node hash; no fill recorded for an approval', !!rcAp && rcAp.transactionHash === child!.tx!.hash && child!.fill === undefined);
  check('E6 fill.received (native) == the engine quote == ETH balance change + both gas costs', r.fill?.received === sellQuote && (await ethBal(A.w.address)) - ethA1 + gasS + gasAp === sellQuote && r.fill?.spent === got, `received ${r.fill?.received}, quote ${sellQuote}`);
  check('E6 all USDC sold', (await usdcBal(A.w.address)) === 0n);

  // ---- E7: a second wallet sells with no allowance and no help: same automatic exact approval
  const F = wrap(); await fund(F.w); await F.chain.refresh('head'); const engF = mkEngine(F.chain, new Store(), F.w);
  await settle(engF, (await engF.submit(intent(F.w, 'e7a', F.chain, { amountIn: ETH1 / 20n }))).key); const fUsdc = await usdcBal(F.w.address);
  const sendsBefore = F.rpc.sends; await engF.submit(intent(F.w, 'e7b', F.chain, { tokenIn: usdc, tokenOut: NATIVE, amountIn: fUsdc })); r = await settle(engF, 'e7b');
  check('E7 fresh wallet sell with zero allowance: finalized, 2 sends, USDC gone, allowance back to 0', r.state === 'finalized' && F.rpc.sends - sendsBefore === 2 && (await usdcBal(F.w.address)) === 0n && (await allowanceOf(F.w.address)) === 0n, r.failure ?? r.state);

  // ---- E7b: approval above the policy's per-tx cap is denied before anything is sent
  const H = wrap(); await fund(H.w); await H.chain.refresh('head'); const polH = policy(H.w.address); polH.maxPerTx[usdc] = 1000n;
  const engH = new Engine({ store: new Store(), chain: H.chain, signer: new PolicySigner(new Map([[H.w.address, 'x']]), new Map([[H.w.address, polH]])), router: new Router(H.chain), platformFeeBps: 0 });
  r = await engH.submit(intent(H.w, 'e7c', H.chain, { tokenIn: usdc, tokenOut: NATIVE, amountIn: 5000n }));
  check('E7b approval over the per-tx cap is denied by the policy signer; nothing sent', r.state === 'failed' && /approval failed: signer policy: exceeds per-tx limit/.test(r.failure ?? '') && H.rpc.sends === 0, r.failure ?? r.state);

  // ---- E8: platform fee refused
  const G = wrap(); await fund(G.w); await G.chain.refresh('head'); const engG = mkEngine(G.chain, new Store(), G.w, 100);
  r = await engG.submit(intent(G.w, 'e8', G.chain));
  check('E8 platform fee > 0 is refused (not silently booked as collected); nothing sent', r.state === 'failed' && /platform fee collection is not implemented/.test(r.failure ?? '') && G.rpc.sends === 0, r.failure ?? r.state);
  facts.push(`engine states observed: E1 ${storeA.records.get('e1')!.history.map(h => h.state).join(' > ')}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Engine on a mainnet fork — EvmRpcChain + Uniswap V2', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same engine code that passes the simulator tests (state machine, idempotency, write-ahead, reconcile-before-resubmit, signer policy) driving real signed transactions through the real Uniswap V2 router bytecode, with faults injected at the RPC layer.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Not a public network: no MEV/competition beyond the one injected front-run, no real mempool, no real inclusion delay or reorg (anvil does not reorg here).', '- Platform fees are not collected on-chain (refused, see E8); no fee contract exists.', '- Approvals are exact-amount, one per sell, and run as a child transaction; tokens that need the allowance reset to 0 first (USDT-style) are not handled.', '- Pending-tx cancel/replace is not offered on this port (a real node can mine it at any moment); it works on the simulator and is exercised on anvil only at the node level (see the local-node report).', '- The signer is a dev-only cast signer with throwaway keys; custody, HSM/MPC and the policy signer\'s HMAC stand-in are unchanged.', '- Only a plain token (WETH/USDC); tax and honeypot tokens are not exercised.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT);
    const r = await runEngineFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-engine-fork.md`;
    writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('enginefork.ts')) main();
