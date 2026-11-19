/** xSTOCKS ON SOLANA, READ-ONLY CHECK AGAINST MAINNET STATE. For each known tokenized-stock mint (packages/sol/src/xstocks.ts: xStocks, Ondo, Backpack):
 *   1. the mint is read on chain: Token-2022, its symbol, and the issuer keys we pin;
 *   2. TokenSafety reports it as an issued asset (warn), not a honeypot (block);
 *   3. the full Jupiter buy path is built and SIMULATED exactly as a trade would be (Jupiter /build, our compile, the safety gate with the Token-2022 account, the simulated balance check).
 *  Nothing is signed and nothing is sent: the RPC client refuses every method that can change state (GuardedRpc), and the signer holds no key.
 *  The simulation needs a fee payer with SOL, so a large public exchange wallet is used as the read-only "taker" (`XSTOCKS_SIM_TAKER` overrides it). A simulated SELL needs a wallet that holds
 *  the xStock, so sells are only checked for a route (quote), not simulated.
 *  usage: node --env-file-if-exists=.env --experimental-transform-types --no-warnings packages/live/src/xstocksread.ts   (SOL_RPC_URL optional; default the public mainnet RPC). Writes a report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { NATIVE } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, TokenSafety, STOCKS_SOLANA, PROGRAMS, JupiterStockPrices, stockStateOf, checkFillPrice } from '../../sol/src/index.ts';
import { fetchJupiterQuote } from '../../sol/src/jupiter.ts';
import { GuardedRpc } from './solreadonly.ts';

const WSOL = 'So11111111111111111111111111111111111111112', TAKER = process.env.XSTOCKS_SIM_TAKER ?? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const url = process.env.SOL_RPC_URL ?? 'https://api.mainnet-beta.solana.com', rpc = new GuardedRpc(url);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rows: string[] = [], fails: string[] = [], prices = new JupiterStockPrices(), priceRefused: string[] = [];
const solUsd = Number((await fetchJupiterQuote({ inputMint: WSOL, outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 1_000_000_000n })).outAmount) / 1e6;
const line = (s: string) => { console.log(s); rows.push(s); };

for (const a of STOCKS_SOLANA.filter(x => (process.env.XSTOCKS_ALL === '1' || x.market.pool) && (!process.env.XSTOCKS_ONLY || x.issuer.includes(process.env.XSTOCKS_ONLY)))) {   // default: the registry's tradable set
  const out: string[] = [];
  try {
    const m: any = await rpc.call('getAccountInfo', [a.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]); const v = m?.value, info = v?.data?.parsed?.info;
    const exts: string[] = (info?.extensions ?? []).map((e: any) => e.extension), sym = info?.extensions?.find((e: any) => e.extension === 'tokenMetadata')?.state?.symbol;
    const mult = info?.extensions?.find((e: any) => e.extension === 'scaledUiAmountConfig')?.state?.multiplier, paused = info?.extensions?.find((e: any) => e.extension === 'pausableConfig')?.state?.paused;
    const onchain = v?.owner === PROGRAMS.token2022 && sym === a.symbol && info?.freezeAuthority === a.keys.freezeAuthority;
    out.push(`mint ${onchain ? 'ok' : 'MISMATCH'} (symbol ${sym}, decimals ${info?.decimals}, multiplier ${mult}, paused ${paused}, extensions ${exts.join('+')})`); if (!onchain) fails.push(`${a.symbol} mint`);
    const safety = await new TokenSafety(rpc).check(a.mint);
    out.push(`safety ${safety.verdict} [${safety.risks.map(r => `${r.code}:${r.level}`).join(', ')}] issuedAsset=${safety.facts.issuedAsset?.symbol ?? 'none'}`); if (safety.verdict === 'block') fails.push(`${a.symbol} safety`);
    const chain = new SolanaChain({ id: 'sol-read', wsol: WSOL, pools: [], jupiter: { pairs: [] } }, rpc, new DevSolSigner());
    const added = await chain.addToken(a.mint, { refLamports: 50_000_000n }); await sleep(2500);
    if (!added.jupiter) { out.push(`jupiter: no route (${added.notes.join('; ')})`); fails.push(`${a.symbol} route`); }
    else {
      const venue = chain.venues().find(x => x.supports(NATIVE, a.mint))!, q = venue.quote(NATIVE, a.mint, 50_000_000n), sellV = chain.venues().some(x => x.supports(a.mint, NATIVE));
      const sim = await chain.simulate({ hash: '', wallet: TAKER, nonce: 0, venue: venue.id, tokenIn: NATIVE, tokenOut: a.mint, amountIn: 50_000_000n, minOut: q.amountOut * 97n / 100n, deadline: Math.floor(Date.now() / 1000) + 600, platformFeeBps: 0 });
      out.push(`buy 0.05 SOL: quote ${q.amountOut} raw (impact ${q.priceImpactBps} bps), simulation ${sim.receipt.status}${sim.receipt.reason ? `: ${sim.receipt.reason}` : ''}, simulated out ${sim.receipt.deltas[a.mint] ?? '-'}; sell route ${sellV ? 'yes' : 'no'}`);
      if (sim.receipt.status !== 'success') fails.push(`${a.symbol} buy simulation`);
      // the server's fill-price check (apps/server/solaccount.ts): price per share on this route against the underlying share price (Jupiter stockData)
      const st = stockStateOf(a.mint, v)!, ref = (await prices.get([a.mint])).get(a.mint)?.stockPrice ?? null, got = (sim.receipt.deltas[a.mint] as bigint | undefined) ?? q.amountOut;
      const fc = checkFillPrice({ side: 'buy', solLamports: 50_000_000n, tokensRaw: got, decimals: st.decimals, multiplier: st.multiplier, solUsd, referenceUsd: ref });
      out.push(`price check: $${fc.perShareUsd.toFixed(2)}/share vs share price ${ref === null ? 'none' : `$${ref}`} (${fc.deviationPct ?? '-'}%): ${!ref ? 'REFUSED (no reference)' : fc.ok ? 'pass' : 'REFUSED'}`);
      if (!ref || !fc.ok) priceRefused.push(a.symbol);
    }
  } catch (e) { out.push(`ERROR ${(e as Error).message}`); fails.push(`${a.symbol} error`); }
  line(`- **${a.symbol}** \`${a.mint}\`\n${out.map(s => `  - ${s}`).join('\n')}`);
  await sleep(2500);   // keyless Jupiter limit: 0.5 requests/s
}
const at = new Date().toISOString(), body = `# Tokenized stocks on Solana: read-only mainnet check (${at})\n\nRPC: ${url.includes('api-key') ? '(keyed RPC, redacted)' : url}. Simulation taker: \`${TAKER}\` (read-only fee payer; nothing signed or sent).\n\n${rows.join('\n')}\n\nResult: ${fails.length ? `FAIL: ${fails.join(', ')}` : 'all pass'}\n\nRefused by the fill-price check (buy, 3% limit, SOL at $${solUsd.toFixed(2)}): ${priceRefused.join(', ') || 'none'}\n`;
mkdirSync('docs/live-verification', { recursive: true }); writeFileSync(`docs/live-verification/${at.replace(/[:.]/g, '-')}-xstocks-sol.md`, body);
console.log(fails.length ? `\nFAIL: ${fails.join(', ')}` : '\nall pass'); console.log(`price check refused: ${priceRefused.join(', ') || 'none'}`); process.exit(fails.length ? 1 : 0);
