/** USDT-STYLE APPROVALS ON A MAINNET FORK. Tether's USDT refuses approve(spender, n) while the current allowance is non-zero. This runs OUR engine over EvmRpcChain
 *  against the real USDT contract and Uniswap V2 on a LOCAL anvil fork: without `resetApprovalFirst` the sell fails visibly; with it the engine runs approve(0), approve(exact), then the swap.
 *  The USDT address is the well-known Tether deployment; this script VERIFIES it on the fork (name/symbol) and by its behaviour (the non-zero -> non-zero approve reverts).
 *  Local only: throwaway keys, fake ETH. usage: npm run verify:usdt (needs ALCHEMY_API_KEY in .env and Foundry). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { Intent, TxRecord, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, encodeCall, decodeParams, erc20 } from '../../evm/src/index.ts';
import { LocalNode, newWallet, signRaw, hex, big } from './localnode.ts';
import type { Wallet } from './localnode.ts';
import { startFork } from './forkenv.ts';
import { CastSigner, FaultRpc } from './enginefork.ts';
import { ETH } from './config.ts';
import type { Check } from './localrun.ts';

const PORT = 8659, ETH1 = 10n ** 18n, TERMINAL = new Set(['finalized', 'failed', 'expired']);
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

export async function runUsdtFork(node: LocalNode): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const router = ETH.uniswapV2Router02.address, factory = ETH.uniswapV2Factory.address;
  const call = async (to: string, data: string) => node.call<string>('eth_call', [{ to, data }, 'latest']);
  const weth = String(decodeParams(['address'], await call(router, encodeCall('WETH()', [])))[0]).toLowerCase();
  const pair = String(decodeParams(['address'], await call(factory, encodeCall('getPair(address,address)', [weth, USDT])))[0]);
  const str = (h: string) => { const len = Number(BigInt('0x' + h.slice(2 + 64, 2 + 128))); return Buffer.from(h.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8'); };
  const sym = str(await call(USDT, encodeCall('symbol()', []))), nm = str(await call(USDT, encodeCall('name()', [])));
  check('U0 the address holds a token named "Tether USD" with symbol USDT, and Uniswap V2 has a WETH/USDT pair', sym === 'USDT' && /Tether/i.test(nm) && /^0x[0-9a-f]{40}$/i.test(pair) && !/^0x0+$/.test(pair), `${nm} ${sym} pair ${pair}`);
  facts.push(`USDT ${USDT} (${nm}); Uniswap V2 pair ${pair}; local fork, fake ETH`);
  const bal = async (a: string) => { const q = erc20.balanceOf(USDT, a); return erc20.decodeUint(await call(q.to, q.data)); };
  const allowance = async (a: string) => { const q = erc20.allowance(USDT, a, router); return erc20.decodeUint(await call(q.to, q.data)); };
  const nonceOf = async (a: string) => Number(big(await node.call('eth_getTransactionCount', [a, 'latest'])));
  const policy = (a: string): WalletPolicy => ({ userId: 'u-' + a, chains: ['evm-fork'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 5n * ETH1, [USDT]: 10n ** 13n }, dailyLimit: { [NATIVE]: 100n * ETH1, [USDT]: 10n ** 14n }, destinations: [], deviceSecret: 'dev' });
  const mk = (signer: CastSigner, w: Wallet, reset: boolean) => {
    const chain = new EvmRpcChain({ id: 'evm-fork', chainId: 1, router, weth, pools: [{ id: 'uni:WETH-USDT', pair }], finalityDepth: 3, resetApprovalFirst: reset }, new FaultRpc(node), signer), store = new Store();
    return { chain, store, engine: new Engine({ store, chain, signer: new PolicySigner(new Map([[w.address, 'x']]), new Map([[w.address, policy(w.address)]])), router: new Router(chain), platformFeeBps: 0 }) };
  };
  const intent = (w: Wallet, key: string, chain: EvmRpcChain, o: Partial<Intent>): Intent => ({ idempotencyKey: key, userId: 'u-' + w.address, walletId: w.address, chain: 'evm-fork', tokenIn: NATIVE, tokenOut: USDT, amountIn: ETH1, minOut: 0n,
    slippageBps: 100, deadline: chain.time + 900, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual', ...o });
  const run = async (s: ReturnType<typeof mk>, i: Intent): Promise<TxRecord> => { await s.chain.refresh('venues'); await s.engine.submit(i); let r = await s.engine.advance(i.idempotencyKey); for (let n = 0; n < 40 && !TERMINAL.has(r.state); n++) { await node.call('anvil_mine', ['0x1']); r = await s.engine.advance(i.idempotencyKey); } return r; };
  const direct = async (w: Wallet, signer: CastSigner, to: string, data: string) => { const raw = signRaw(w, { to, data, valueWei: 0n, nonce: await nonceOf(w.address), chainId: 1, gasLimit: 200_000n, maxFeeGwei: '300', priorityGwei: '1' }); return node.waitReceipt(await node.call<string>('eth_sendRawTransaction', [raw])); };

  for (const mode of ['without', 'with'] as const) {
    const signer = new CastSigner(), w = signer.add(newWallet()); await node.call('anvil_setBalance', [w.address, hex(20n * ETH1)]);
    const s = mk(signer, w, mode === 'with'); await s.chain.refresh('head');
    const buy = await run(s, intent(w, `buy-${mode}`, s.chain, {})); const held = await bal(w.address);
    check(`U1 (${mode}) bought USDT through the engine; fill == the wallet's USDT balance`, buy.state === 'finalized' && buy.fill?.received === held && held > 0n, `${buy.state} ${held}`);
    await direct(w, signer, USDT, encodeCall('approve(address,uint256)', [router, 1000n]));            // leave a small non-zero allowance (e.g. from an older trade)
    const bad = await direct(w, signer, USDT, encodeCall('approve(address,uint256)', [router, held]));
    check(`U2 (${mode}) USDT really refuses non-zero -> non-zero approve (the direct approve reverts on-chain), allowance still 1000`, bad.status !== '0x1' && (await allowance(w.address)) === 1000n, `status ${bad.status}`);
    const sell = await run(s, intent(w, `sell-${mode}`, s.chain, { tokenIn: USDT, tokenOut: NATIVE, amountIn: held }));
    if (mode === 'without') {
      check('U3 without resetApprovalFirst the sell fails VISIBLY at the approval step and no swap is sent', sell.state === 'failed' && /approval failed/.test(sell.failure ?? '') && (await bal(w.address)) === held, `${sell.state} ${sell.failure}`);
    } else {
      const reset = s.store.records.get('sell-with:reset:approve'), exact = s.store.records.get('sell-with:approve');
      check('U4 with resetApprovalFirst the engine ran approve(0) then approve(exact), both finalized, then the swap', sell.state === 'finalized' && reset?.state === 'finalized' && reset.intent.amountIn === 0n && exact?.state === 'finalized' && exact.intent.amountIn === held, `${sell.state} reset ${reset?.state} exact ${exact?.state}`);
      check('U4 all USDT sold; ETH received; the allowance was consumed to 0 (nothing left approved)', (await bal(w.address)) === 0n && sell.fill!.received > 0n && (await allowance(w.address)) === 0n, `allowance ${await allowance(w.address)}`);
    }
  }
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# USDT-style approvals on a mainnet fork', '', `Run: ${new Date().toISOString()}`, `Node: local anvil fork (${url}); NOT mainnet. Throwaway keys, fake ETH, dev-only signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- `resetApprovalFirst` is a per-chain setting: the engine does not detect USDT-style tokens by itself. Other non-standard tokens (fee-on-transfer, rebasing, blacklisting) are not part of this check.', '- The USDT address was supplied from memory and verified on the fork by name, symbol and behaviour, not against a published source in this run.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let fork: Awaited<ReturnType<typeof startFork>> | undefined;
  try {
    fork = await startFork(key, PORT); const r = await runUsdtFork(fork.node), rep = report(fork.node.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-usdt-fork.md`; writeFileSync(file, fork.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + fork.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); fork.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(fork ? fork.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); fork?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('usdtfork.ts')) main();
