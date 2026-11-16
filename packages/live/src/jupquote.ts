/** READ-ONLY: compares OUR Raydium AMM v4 constant-product quote for SOL -> USDC with Jupiter's aggregated quote, at the same moment. Nothing is signed or sent.
 *  usage: npm run verify:jupiter (needs ALCHEMY_API_KEY for the Solana pool read; Jupiter's public quote API needs no key). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Rpc } from './rpc.ts';
import { SOL, SOL_POOL, urls } from './config.ts';
import { loadPoolKeys, decodePoolState, quoteOut, fetchJupiterQuote, quoteGapBps } from '../../sol/src/index.ts';

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const rpc = new Rpc(urls(key).sol, key, fetch, 150), rows: string[] = [];
  try {
    const { keys, state } = await loadPoolKeys(rpc as any, SOL_POOL.id, SOL.programs[0].address);
    const bal = async (a: string) => { const r: any = await rpc.call('getAccountInfo', [a, { encoding: 'jsonParsed' }]); return BigInt(r.value.data.parsed.info.tokenAmount.amount); };
    const rBase = await bal(keys.baseVault) - state.baseNeedTakePnl, rQuote = await bal(keys.quoteVault) - state.quoteNeedTakePnl;
    for (const sol of [1n, 10n, 100n]) {
      const amt = sol * 10n ** 9n, ours = quoteOut(amt, rBase, rQuote, state.swapFeeNum, state.swapFeeDen), j = await fetchJupiterQuote({ inputMint: SOL_POOL.wsol.mint, outputMint: SOL_POOL.usdc.mint, amount: amt });
      rows.push(`| ${sol} SOL | ${ours} | ${j.outAmount} | ${quoteGapBps(ours, j)} bps | ${j.route.map(r => `${r.label} ${r.percent}%`).join(' + ')} | ${(j.priceImpactPct * 100).toFixed(4)}% |`);
    }
  } catch (e) { console.error((e as Error).message.split(key).join('***')); process.exit(1); }
  const text = ['# Our Raydium quote vs Jupiter (read-only)', '', `Run: ${new Date().toISOString()}`, 'Mainnet READ-ONLY. Nothing signed or sent. Jupiter may route over several pools, so a gap is expected: this is a sanity bound, not a pass/fail oracle.', '',
    '| Input | Our Raydium quote (micro-USDC) | Jupiter (micro-USDC) | Gap (positive = ours lower) | Jupiter route | Jupiter price impact |', '|---|---|---|---|---|---|', ...rows, '',
    'Not covered: executing a Jupiter route (needs /swap-instructions and versioned transactions) is NOT implemented; the engine can only trade the Raydium pool directly.'].join('\n') + '\n';
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-jupiter-quote.md`; writeFileSync(file, text); console.log(text); console.log('report:', file);
}
main();
