/** SOLANA MAINNET, READ-ONLY CHECK: search a token, read its mint facts, let the SDK find its venues (pump.fun curve and/or Jupiter), print quotes, and SIMULATE a buy with `simulateTransaction`
 *  (no signature, nothing sent, nothing spent). The RPC wrapper below refuses every method that could change state, so this script cannot trade even by mistake.
 *  usage: npm run check:sol-mainnet -- <name|symbol|mint> [funded public wallet address to simulate as]   (needs ALCHEMY_API_KEY in .env). */
import { NATIVE } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc, searchSolTokens, mintFacts, looksLikeMint } from '../../sol/src/index.ts';
import { urls } from './config.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const READ_ONLY = new Set(['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSlot', 'getBlockHeight', 'getBalance', 'getTokenAccountsByOwner', 'getTokenLargestAccounts', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction', 'simulateTransaction', 'getMinimumBalanceForRentExemption', 'getGenesisHash', 'getHealth', 'getVersion', 'getRecentPrioritizationFees', 'getBlockTime', 'getEpochInfo']);
class GuardedRpc extends SolJsonRpc {
  override async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (!READ_ONLY.has(method)) throw new Error(`read-only check: RPC method "${method}" is refused`);
    return super.call<T>(method, params);
  }
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const query = process.argv[2] ?? 'bonk', redact = (s: string) => s.split(key).join('***'), rpc = new GuardedRpc(urls(key).sol);
  try {
    console.log(`search "${query}" (third-party data, unverified):`);
    const { hits, errors } = await searchSolTokens(query, { limit: 6 });
    for (const e of errors) console.log('  source problem:', e);
    for (const h of hits) console.log(`  ${h.symbol.padEnd(10)} ${h.mint}  liq $${Math.round(h.liquidityUsd ?? 0).toLocaleString()}  ${h.sources.join('+')}${h.pumpLike ? '  (pump-style address)' : ''}`);
    const pick = looksLikeMint(query) ? query : hits[0]?.mint;
    if (!pick) { console.log('no token found'); return; }
    const f = await mintFacts(rpc, pick);
    console.log(`\nmint ${pick}: program ${f.tokenProgram?.slice(0, 8)}, decimals ${f.decimals}, supply ${f.supply}, mint authority ${f.mintAuthority ? 'SET' : 'none'}, freeze authority ${f.freezeAuthority ? 'SET' : 'none'}`);
    for (const w of f.warnings) console.log('  warning:', w);
    const chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], pump: { mints: [] }, jupiter: { pairs: [] } }, rpc, new DevSolSigner());
    const r = await chain.addToken(pick);
    console.log(`\nroutes: pump.fun curve ${r.pump}, Jupiter ${r.jupiter}`);
    for (const n of r.notes) console.log('  note:', n);
    const venues = chain.venues().filter(v => v.supports(NATIVE, pick));
    if (!venues.length) { console.log('no venue can trade this token'); return; }
    for (const v of venues) { const q = v.quote(NATIVE, pick, 10_000_000n); console.log(`  ${v.id}: 0.01 SOL -> ${q.amountOut} raw units, impact ${q.priceImpactBps / 100}%`); }
    const as = process.argv[3];
    if (!as) { console.log('\n(pass a funded public wallet address as the 2nd argument to also simulate a buy)'); return; }
    const v = venues[0];
    const tx: any = { kind: 'swap', wallet: as, venue: v.id, tokenIn: NATIVE, tokenOut: pick, amountIn: 10_000_000n, minOut: 0n, platformFeeBps: 0, nonce: 0, hash: '', deadline: 0 };
    const b = await chain.simulate(tx);
    console.log(`\nsimulated BUY 0.01 SOL via ${v.id} as ${as.slice(0, 6)}...: ${b.receipt.status}${b.receipt.reason ? ' - ' + b.receipt.reason.slice(0, 220) : ''}`);
  } catch (e) { console.error(redact((e as Error).stack ?? (e as Error).message)); process.exit(1); }
}
main();
