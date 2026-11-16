/** LIVE, READ-ONLY check of the launch stream against Solana mainnet: opens the public WebSocket, listens for DURATION seconds, decodes what arrives through the Alchemy HTTP node (key from .env, never printed),
 *  and writes a dated report. Nothing is signed or sent. usage: npm run verify:launch-stream [seconds] */
import { mkdirSync, writeFileSync } from 'node:fs';
import { RaydiumLaunchSource } from '../../sol/src/index.ts';
import { makeRpc } from './realmarkets.ts';
import { SOL, RAYDIUM_V4_POOL_CREATION_WATCH, PUMP_CREATE_WATCH, SOLANA_PUBLIC_WS } from './config.ts';
import { LaunchStream, solanaFeeds, mintEnricher } from './launchstream.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const secs = Number(process.argv[2]) || 60, rpc = await makeRpc(key), sol = rpc.sol, redact = (s: string) => s.split(key).join('***');
  const raydium: any = new RaydiumLaunchSource({ chain: 'solana', program: SOL.programs[0].address, wsol: WSOL, quoteMints: [WSOL] }, sol as any);
  const stream = new LaunchStream({ url: process.env.SOLANA_WS_URL || SOLANA_PUBLIC_WS, redact, feeds: solanaFeeds({ rpc: sol, raydium, raydiumWatch: RAYDIUM_V4_POOL_CREATION_WATCH, pumpWatch: PUMP_CREATE_WATCH }), enrich: mintEnricher(sol) });
  const rows: { sym: string; name: string; contract: string; venue: string; verdict: string; flags: string[]; lagS: number | null; sig: string }[] = [];
  stream.on(async it => {
    let lagS: number | null = null; try { const bt: number | null = await sol.call('getBlockTime', [it.slot]); if (bt && it.seenAt) lagS = Math.round((it.seenAt / 1000 - bt) * 10) / 10; } catch { /* block time not yet available */ }
    rows.push({ sym: it.sym, name: it.name, contract: it.contract, venue: it.venue, verdict: it.verdict, flags: it.flags, lagS, sig: it.sig! });
    console.log(`${it.venue.padEnd(15)} ${it.sym.padEnd(12)} ${it.verdict.padEnd(11)} lag ${lagS ?? '?'}s  ${it.contract}`);
  });
  const t0 = Date.now(); stream.start(); await new Promise(r => setTimeout(r, secs * 1000)); await new Promise(r => setTimeout(r, 8000)); const st = stream.status(); stream.stop();
  const lags = rows.map(r => r.lagS).filter((x): x is number => x !== null).sort((a, b) => a - b), med = lags.length ? lags[Math.floor(lags.length / 2)] : null;
  const named = rows.filter(r => r.sym !== `${r.contract.slice(0, 4)}…${r.contract.slice(-4)}`).length;
  const text = ['# Launch stream: live read-only check (Solana mainnet)', '', `Run: ${new Date().toISOString()}`, `Listened: ${secs} s (+8 s to finish decoding), endpoint ${process.env.SOLANA_WS_URL ? '(SOLANA_WS_URL, not printed)' : SOLANA_PUBLIC_WS}; decoding through the Alchemy HTTP node.`, '',
    'What this shows: new Pump.fun token creations and Raydium AMM v4 pool creations pushed over a WebSocket log subscription, decoded from the transaction, mint-checked, and dry-run against the example sniper rules. Nothing is signed or sent.', '',
    '## Observed', `- notifications received: ${st.received}; matched the creation filter: ${st.matched}; decoded into items: ${st.emitted}; failed to decode: ${st.failed}; reconnects: ${st.reconnects}`,
    `- feeds: ${st.feeds.map(f => `${f.name} subscribed=${f.subscribed}${f.error ? ' error=' + f.error : ''} received=${f.received}`).join('; ')}`,
    `- seen-to-block-time lag (seconds, our receive time minus the cluster's block time, whole-second resolution): ${lags.length ? `median ${med}, min ${lags[0]}, max ${lags[lags.length - 1]} over ${lags.length} items` : 'no items with a block time'}`,
    `- items whose name/symbol were read from the Token-2022 metadata extension: ${named} of ${rows.length}`, `- last error: ${st.lastError ?? 'none'}`, '',
    '## Items', '| Venue | Symbol | Name | Mint | Risk | Lag s |', '|---|---|---|---|---|---|', ...rows.slice(0, 40).map(r => `| ${r.venue} | ${r.sym.replace(/\|/g, '/')} | ${r.name.replace(/\|/g, '/')} | ${r.contract} | ${r.verdict} | ${r.lagS ?? '?'} |`), '',
    '## Not covered', '- Raydium v4 pool creations are rare (about one every few days): a short run usually sees none. The Raydium decode is covered by the polled-list mainnet check and unit tests, not by this run unless a row above says Raydium.',
    '- Confirmed commitment, not finalized. A dropped socket leaves a gap that is counted but not backfilled.', '- Public endpoint: rate limited, no SLA. No mempool and no pre-confirmation view: nothing here is faster than a mined transaction.'].join('\n') + '\n';
  mkdirSync('docs/live-verification', { recursive: true });
  const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-launch-stream-mainnet-readonly.md`; writeFileSync(file, redact(text));
  console.log(`\n${st.emitted} items from ${st.received} notifications in ${Math.round((Date.now() - t0) / 1000)} s; failed ${st.failed}; report: ${file}`);
  process.exit(st.emitted > 0 && st.failed === 0 ? 0 : 1);
}
main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
