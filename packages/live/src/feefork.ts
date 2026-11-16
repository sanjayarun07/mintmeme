/** ON-CHAIN PLATFORM FEE ON A MAINNET FORK. Compiles packages/evm/contracts/FeeRouter.sol with Foundry, deploys it on a LOCAL anvil fork next to the real Uniswap V2 router, and runs OUR engine
 *  with a 50 bps platform fee: the fee is taken from the input, atomically, and lands at the treasury address; the fill reports it. Local only: throwaway keys, fake ETH.
 *  The contract is an UNAUDITED reference implementation. usage: npm run verify:fee (needs ALCHEMY_API_KEY in .env and Foundry). */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { Intent, TxRecord, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import { LocalNode, newWallet, hex, big } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8661, ETH1 = 10n ** 18n, FEE_BPS = 50, TERMINAL = new Set(['finalized', 'failed', 'expired']);
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

function compile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-fee-')); mkdirSync(join(dir, 'src'));
  copyFileSync(new URL('../../evm/contracts/FeeRouter.sol', import.meta.url), join(dir, 'src/FeeRouter.sol')); writeFileSync(join(dir, 'foundry.toml'), "[profile.default]\nsrc='src'\nout='out'\n");
  execFileSync('forge', ['build', '--root', dir, '--silent'], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'out/FeeRouter.sol/FeeRouter.json'), 'utf8')).bytecode.object as string;
}

export async function runFeeFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address, usdc = ETH.usdc.address.toLowerCase();
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, usdc])))[0]);
  const bal = async (t: string, a: string) => { const q = erc20.balanceOf(t, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const allow = async (a: string, spender: string) => { const q = erc20.allowance(usdc, a, spender); return erc20.decodeUint(await call(q.to, q.data)); };
  const eth = async (a: string) => big(await node.call('eth_getBalance', [a, 'latest']));
  const treasury = newWallet().address, signer = new CastSigner(), w = signer.add(newWallet()), D = newWallet();
  await node.call('anvil_setBalance', [w.address, hex(50n * ETH1)]); await node.call('anvil_setBalance', [D.address, hex(5n * ETH1)]);

  const code = compile() + pad(router) + pad(treasury) + pad(FEE_BPS.toString(16));
  const nonce = Number(big(await node.call('eth_getTransactionCount', [D.address, 'latest'])));
  const rawDeploy = execFileSync('cast', ['mktx', '--nonce', String(nonce), '--chain', '1', '--gas-limit', '1500000', '--gas-price', '300gwei', '--priority-gas-price', '1gwei', '--private-key', D.key, '--create', code], { encoding: 'utf8' }).trim();
  const rc: any = await node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [rawDeploy])); const feeRouter = String(rc.contractAddress).toLowerCase();
  facts.push(`FeeRouter ${feeRouter} compiled with Foundry from packages/evm/contracts/FeeRouter.sol (UNAUDITED), ${FEE_BPS} bps, treasury ${treasury}, wrapping the real Uniswap V2 router; local fork, fake ETH`);
  check('F0 the deployed contract reports the router, treasury and fee it was built with', String(decodeParams(['address'], await call(feeRouter, encodeCall('router()', [])))[0]).toLowerCase() === router.toLowerCase() && String(decodeParams(['address'], await call(feeRouter, encodeCall('treasury()', [])))[0]).toLowerCase() === treasury && Number(big(await call(feeRouter, encodeCall('feeBps()', [])))) === FEE_BPS);

  const policy: WalletPolicy = { userId: 'u-' + w.address, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 20n * ETH1, [usdc]: 10n ** 14n }, dailyLimit: { [NATIVE]: 100n * ETH1, [usdc]: 10n ** 15n }, destinations: [], deviceSecret: 'dev' };
  const mk = (feeBps: number, withRouter = true) => {
    const rpc = new FaultRpc(node), store = new Store(), chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDC', pair }], finalityDepth: 3, feeRouter: withRouter ? { address: feeRouter, bps: FEE_BPS } : undefined }, rpc, signer);
    return { rpc, store, chain, engine: new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'x']]), new Map([[w.address, policy]])), router: new Router(chain), platformFeeBps: feeBps }) };
  };
  const intent = (s: ReturnType<typeof mk>, key: string, o: Partial<Intent>): Intent => ({ idempotencyKey: key, userId: 'u-' + w.address, walletId: w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: usdc, amountIn: ETH1, minOut: 0n,
    slippageBps: 100, deadline: s.chain.time + 900, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual', ...o });
  const run = async (s: ReturnType<typeof mk>, i: Intent): Promise<TxRecord> => { await s.chain.refresh('venues'); await s.engine.submit(i); let r = await s.engine.advance(i.idempotencyKey); for (let n = 0; n < 40 && !TERMINAL.has(r.state); n++) { await node.call('anvil_mine', ['0x1']); r = await s.engine.advance(i.idempotencyKey); } return r; };

  // ---- buy
  const s = mk(FEE_BPS); await s.chain.refresh('head'); const tBuy0 = await eth(treasury), w0 = await eth(w.address);
  const buy = await run(s, intent(s, 'fee-buy', {})); const held = await bal(usdc, w.address), want = ETH1 * BigInt(FEE_BPS) / 10_000n;
  check('F1 buy with a 50 bps platform fee finalized through the engine, via the FeeRouter', buy.state === 'finalized' && buy.tx?.hash !== undefined, `${buy.state} ${buy.failure ?? ''}`);
  check('F1 the treasury received exactly 0.5% of the input in the same transaction, and the fill reports that platform fee', (await eth(treasury)) - tBuy0 === want && buy.fill?.platformFee === want, `treasury +${(await eth(treasury)) - tBuy0}, fill ${buy.fill?.platformFee}, want ${want}`);
  check('F1 the wallet\'s USDC equals the fill and the engine\'s quote (which already deducted the fee); ETH out == 1 ETH + gas', buy.fill?.received === held && held === buy.quote!.amountOut && w0 - (await eth(w.address)) === ETH1 + buy.fill!.networkFee, `received ${buy.fill?.received} quote ${buy.quote?.amountOut} balance ${held}`);
  check('F1 the FeeRouter keeps nothing: zero ETH and zero USDC left in it', (await eth(feeRouter)) === 0n && (await bal(usdc, feeRouter)) === 0n);

  // ---- sell
  const tSell0 = await bal(usdc, treasury), wSell0 = await eth(w.address);
  const sell = await run(s, intent(s, 'fee-sell', { tokenIn: usdc, tokenOut: NATIVE, amountIn: held })); const feeTok = held * BigInt(FEE_BPS) / 10_000n;
  const child = s.store.records.get('fee-sell:approve');
  check('F2 sell finalized; the approval was for the FeeRouter (the spender), exactly the sold amount', sell.state === 'finalized' && child?.state === 'finalized' && child.intent.amountIn === held, `${sell.state} ${sell.failure ?? ''}`);
  check('F2 the treasury received exactly 0.5% of the USDC input; the fill reports it; ETH came back to the wallet', (await bal(usdc, treasury)) - tSell0 === feeTok && sell.fill?.platformFee === feeTok && (await eth(w.address)) > wSell0 && (await bal(usdc, w.address)) === 0n, `treasury +${(await bal(usdc, treasury)) - tSell0}, fill ${sell.fill?.platformFee}, want ${feeTok}`);
  check('F2 nothing stays approved or stuck: allowances to the FeeRouter and the router are 0 and the FeeRouter holds nothing', (await allow(w.address, feeRouter)) === 0n && (await allow(feeRouter, router)) === 0n && (await bal(usdc, feeRouter)) === 0n && (await eth(feeRouter)) === 0n);

  // ---- refusals
  const bad = mk(100); await bad.chain.refresh('head'); const mism = await run(bad, intent(bad, 'fee-mismatch', {}));
  check('F3 a fee that differs from the contract\'s immutable fee is refused before anything is sent', mism.state === 'failed' && /differs from the fee router/.test(JSON.stringify(mism.history) + (mism.failure ?? '')) && bad.rpc.sends === 0, `${mism.state} ${mism.failure ?? ''}`);
  const none = mk(FEE_BPS, false); await none.chain.refresh('head'); const nr = await run(none, intent(none, 'fee-norouter', {}));
  check('F3 a fee with no fee router configured is refused, never booked as collected', nr.state === 'failed' && /no on-chain fee router/.test(JSON.stringify(nr.history) + (nr.failure ?? '')) && none.rpc.sends === 0, `${nr.state} ${nr.failure ?? ''}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# On-chain platform fee on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- The FeeRouter is an UNAUDITED reference implementation: no independent review, no formal verification, no upgrade or pause mechanism, a fixed fee set at deployment. Do not deploy it with real funds without an audit.', '- Native <-> token trades through Uniswap-V2-style routers only; token <-> token fees, fee-on-transfer tokens through the fee router, and per-user fee tiers (the contract fee is one number) are not covered.',
    '- Fee accounting, treasury custody, tax treatment and reconciliation against the engine\'s fee ledger are not part of this check. Solana has no fee collection.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT); const r = await runFeeFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-fee-fork.md`; writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('feefork.ts')) main();
