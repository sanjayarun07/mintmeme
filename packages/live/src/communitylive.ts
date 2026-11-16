/** READ-ONLY live check of the Wallet Bot's real lookups (apps/telegram/community.ts): native balance of public addresses by JSON-RPC, and native and token prices from DexScreener.
 *  Nothing is signed, sent or posted. Uses only public addresses. usage: npm run verify:community (needs ALCHEMY_API_KEY in .env). Writes a report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { realLookups } from '../../../apps/telegram/community.ts';
import { makeRpc, checkChainIds } from './realmarkets.ts';
import { ETH, BSC } from './config.ts';
import { encodeCall, decodeParams } from '../../evm/src/index.ts';
import type { Check } from './localrun.ts';

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const redact = (s: string) => s.split(key).join('***'); const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  try {
    const rpc = await makeRpc(key); await checkChainIds(rpc);
    const wrapped = async (r: typeof rpc.ethereum, router: string) => String(decodeParams(['address'], await r.call<string>('eth_call', [{ to: router, data: encodeCall('WETH()', []) }, 'latest']))[0]).toLowerCase();
    const wrappedNative = { ethereum: await wrapped(rpc.ethereum, ETH.uniswapV2Router02.address), bsc: await wrapped(rpc.bsc, BSC.pancakeV2Router.address) };
    facts.push(`wrapped-native contracts read on-chain from the official routers: Ethereum ${wrappedNative.ethereum}, BSC ${wrappedNative.bsc}`);
    const L = realLookups({ rpc: { ethereum: rpc.ethereum, bsc: rpc.bsc }, wrappedNative });
    const pe = await L.priceOf('ethereum', 'native'), pb = await L.priceOf('bsc', 'native'), pa = await L.priceOf('arbitrum', 'native'), pu = await L.priceOf('ethereum', ETH.usdc.address);
    facts.push(`prices (DexScreener, third party): ETH ${pe}, BNB ${pb}, USDC ${pu}`);
    check('V1 ETH and BNB prices are sensible positive numbers from the deepest pool on the right chain', !!pe && pe > 100 && pe < 100_000 && !!pb && pb > 10 && pb < 10_000, `ETH ${pe}, BNB ${pb}`);
    check('V1 Arbitrum native price equals the Ethereum one (same coin), and USDC prices near one dollar', pa === pe && !!pu && Math.abs(pu - 1) < 0.05, `ARB-ETH ${pa}, USDC ${pu}`);
    // public addresses only: each chain's wrapped-native contract holds a large public balance of native coin
    const be = await L.balanceOf('ethereum', wrappedNative.ethereum), bb = await L.balanceOf('bsc', wrappedNative.bsc), ba = await L.balanceOf('arbitrum', wrappedNative.ethereum);
    facts.push(`public balances: Ethereum WETH contract holds ${be} ETH; BSC WBNB contract holds ${bb} BNB`);
    check('V2 native balances of public contract addresses are read from the real nodes as whole-coin numbers', typeof be === 'number' && be > 0 && typeof bb === 'number' && bb > 0, `ETH ${be}, BNB ${bb}`);
    check('V2 a chain with no node configured (Arbitrum) answers "unavailable" instead of guessing an endpoint', ba === null);
  } catch (e) { check('V0 the run completed without an error', false, redact((e as Error).message)); }
  const pass = checks.every(c => c.pass);
  const text = ['# Wallet Bot lookups: read-only live check', '', `Run: ${new Date().toISOString()}`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: the real lookups behind the Wallet Bot (balance by `eth_getBalance`, prices from DexScreener) return sensible values on Ethereum and BNB Smart Chain mainnet. Read-only, public addresses only, nothing signed or sent, nothing posted to Telegram.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${redact(c.detail).replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Telegram itself: no bot token exists in this repo, so no message was sent or received.', '- Arbitrum balances were not read from a real node (no endpoint is configured by default).', '- Prices are a third party\'s numbers for the deepest pool, not an oracle; they can lag or be moved by a thin pool.', ''].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-wallet-bot-lookups.md`; writeFileSync(file, text);
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
