/** PENDING-TRANSACTION CANCEL (REPLACE-BY-FEE) ON A MAINNET FORK. With automine OFF the engine's buy sits in the mempool; cancelNonce sends a higher-fee no-op with the SAME nonce.
 *  R1: the replacement wins (original dropped, only the no-op's gas is spent, the wallet can trade again). R2: the original is mined first (the no-op is rejected as nonce-too-low and the
 *  buy completes exactly once). Local only: throwaway keys, fake ETH. usage: npm run verify:cancel (needs ALCHEMY_API_KEY in .env and Foundry). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { Intent, TxRecord, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import { LocalNode, newWallet, hex, big } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8660, ETH1 = 10n ** 18n, TERMINAL = new Set(['finalized', 'failed', 'expired']);

export async function runCancelFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const bal = async (a: string) => { const q = erc20.balanceOf(usdc, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const eth = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));
  const nonce = async (a: string) => Number(big(await node.call('eth_getTransactionCount', [a, 'latest'])));
  const signer = new CastSigner();
  const policy = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [usdc]: 10n ** 13n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 14n }, destinations: [], deviceSecret: 'dev' });
  const mk = () => {
    const w = signer.add(newWallet()), rpc = new FaultRpc(node), store = new Store();
    const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3 }, rpc, signer);
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'x']]), new Map([[w.address, policy(w.address)]])), router: new Router(chain), platformFeeBps: 0 });
    return { w, rpc, store, chain, engine };
  };
  const intent = (s: ReturnType<typeof mk>, key: string): Intent => ({ idempotencyKey: key, userId: 'u-' + s.w.address, walletId: s.w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: usdc, amountIn: ETH1 / 2n, minOut: 0n,
    slippageBps: 100, deadline: s.chain.time + 3600, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual' });
  const mine = (n = 1) => node.call('anvil_mine', [hex(BigInt(n))]);
  const drive = async (s: ReturnType<typeof mk>, key: string, rounds = 12): Promise<TxRecord> => { let r = s.store.records.get(key)!; for (let i = 0; i < rounds && !TERMINAL.has(r.state); i++) { r = await s.engine.advance(key); if (TERMINAL.has(r.state)) break; await mine(1); } return r; };
  facts.push(`fork with automine OFF so transactions stay pending until a block is mined; pool WETH/USDC ${pair}; local, fake ETH, throwaway keys`);

  // ---------- R1: replacement wins ----------
  const A = mk(); await node.call('anvil_setBalance', [A.w.address, hex(10n * ETH1)]); await A.chain.refresh('venues');
  await node.call('evm_setAutomine', [false]);
  await A.engine.submit(intent(A, 'buy-a')); let a = await A.engine.advance('buy-a');
  const origHash = a.tx?.hash;
  check('R1 with automine off the buy is signed and sent but stays pending in the mempool (state observed)', a.state === 'observed' && !!origHash && (await node.call('eth_getTransactionByHash', [origHash])) !== null && (await nonce(A.w.address)) === 0, `${a.state}`);
  const refused = await A.engine.cancelNonce(A.w.address);
  check('R1 without force the engine refuses to touch a pending transaction', refused.status === 'pending');
  const ethA0 = await eth(A.w.address);
  const res = await A.engine.cancelNonce(A.w.address, { force: true, reason: 'operator' });
  check('R1 force: a higher-fee no-op with the SAME nonce was sent (status "replacing"); the original is kept in play, not abandoned', res.status === 'replacing' && !!res.noopKey && A.store.records.get('buy-a')!.state === 'unresolved', `${res.status} orig ${A.store.records.get('buy-a')!.state}`);
  const noopTx = A.store.records.get(res.noopKey!)!.tx!;
  check('R1 the no-op has the same nonce and a fee at least 10% above the original (the node accepted the replacement)', noopTx.nonce === 0 && (await node.call('eth_getTransactionByHash', [origHash!])) === null && (await node.call('eth_getTransactionByHash', [noopTx.hash])) !== null, `nonce ${noopTx.nonce}`);
  await mine(1); const noop = await drive(A, res.noopKey!); const orig = await drive(A, 'buy-a');
  check('R1 the no-op landed; the original can never land: it ends failed with "nonce consumed", no tokens bought', noop.state === 'finalized' && orig.state === 'failed' && /nonce consumed/.test(orig.failure ?? '') && (await bal(A.w.address)) === 0n && (await nonce(A.w.address)) === 1, `noop ${noop.state} orig ${orig.state} ${orig.failure ?? ''}`);
  const spent = ethA0 - (await eth(A.w.address));
  check('R1 only the no-op\'s gas was spent (no swap value left the wallet)', spent > 0n && spent < ETH1 / 100n, `spent ${spent} wei`);
  await node.call('evm_setAutomine', [true]);
  await A.engine.submit(intent(A, 'buy-a2')); const again = await drive(A, 'buy-a2');
  check('R1 afterwards the wallet trades normally at the next nonce', again.state === 'finalized' && (await bal(A.w.address)) === again.fill!.received && (await nonce(A.w.address)) === 2, `${again.state}`);

  // ---------- R2: the original wins the race ----------
  const B = mk(); await node.call('anvil_setBalance', [B.w.address, hex(10n * ETH1)]); await B.chain.refresh('venues');
  await node.call('evm_setAutomine', [false]);
  await B.engine.submit(intent(B, 'buy-b')); await B.engine.advance('buy-b');
  B.rpc.beforeSend = async () => { await mine(1); };   // the original is mined just before the no-op reaches the node
  const res2 = await B.engine.cancelNonce(B.w.address, { force: true });
  const noop2 = B.store.records.get(res2.noopKey!)!;
  check('R2 the original was mined first: the no-op was rejected by the node (nonce too low) and its record failed; nothing was double-spent', noop2.state === 'failed' && /nonce|already|too low/i.test(noop2.failure ?? JSON.stringify(noop2.history)) && (await nonce(B.w.address)) === 1, `noop ${noop2.state} ${noop2.failure ?? ''}`);
  await node.call('evm_setAutomine', [true]); const buyB = await drive(B, 'buy-b');
  check('R2 the buy completed exactly once: finalized, fill == the wallet\'s USDC balance, the signer charge was kept (it did execute)', buyB.state === 'finalized' && buyB.fill?.received === (await bal(B.w.address)) && (await bal(B.w.address)) > 0n, `${buyB.state}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Pending-transaction cancel (replace-by-fee) on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Replace-by-fee is not atomic: until a block is mined either transaction may win. The engine handles both outcomes, but a real network with other pending transactions, fee spikes or a private mempool can reject the replacement as underpriced; that path was not exercised.', '- Only a pending transaction in the node\'s own pool is replaceable. A transaction already forwarded elsewhere (a relay or sequencer) may behave differently, and L2 sequencers with first-come ordering were not modelled.',
    '- Solana has no replace-by-fee: a signed Solana transaction can only be left to expire.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT); const r = await runCancelFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-cancel-fork.md`; writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('cancelfork.ts')) main();
