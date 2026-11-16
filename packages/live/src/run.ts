import { writeFileSync, mkdirSync } from 'node:fs';
import { Rpc } from './rpc.ts';
import { urls, ETH, SOL, FETCHED } from './config.ts';
import { verifyEthereum, verifySolana } from './verify.ts';
import { verifyEthSwapDryRun } from './dryrun.ts';
import { simulateSolSwap } from './solswap.ts';
import { verifySolanaPool } from './solpool.ts';
import type { Check } from './verify.ts';

/** Usage: ALCHEMY_API_KEY=... npm run verify:live [-- --only eth|sol] [--dry-run] [--pools]. READ-ONLY: no signing, no transactions, no funds. */
export function render(date: string, sections: { name: string; at: string; checks: Check[]; calls: number }[]) {
  const icon = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIPPED' } as const;
  let md = `# Live read-only verification, ${date}\n\nProvider: Alchemy (JSON-RPC, read-only methods only). Address sources fetched ${FETCHED} from official pages (see packages/live/src/config.ts). A pass here means "readable and consistent on mainnet at that block", not "safe to trade".\n\n`;
  for (const s of sections) { md += `## ${s.name} (${s.at}, ${s.calls} RPC calls)\n\n| Result | Check | Detail |\n|---|---|---|\n` + s.checks.map(c => `| ${icon[c.status]} | ${c.id} | ${c.detail.replace(/\|/g, '/')} |`).join('\n') + '\n\n'; }
  return md;
}
export async function main(env = process.env, args = process.argv.slice(2), fetchFn: typeof fetch = fetch, out = (s: string) => console.log(s), outDir = 'docs/live-verification', pauseMs?: number) {
  const key = env.ALCHEMY_API_KEY;
  if (!key) { out('Set ALCHEMY_API_KEY in your shell first (never put it in a file in this repo). Example: export ALCHEMY_API_KEY=...'); return 2; }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : 'both'; const u = urls(key); const sections = [];
  if (only !== 'sol') { const r = new Rpc(u.eth, key, fetchFn, pauseMs); const e = await verifyEthereum(r); sections.push({ name: 'Ethereum mainnet', at: `block ${e.block ?? '?'}`, checks: e.checks, calls: r.calls }); }
  if (args.includes('--dry-run') && only !== 'sol') { const r = new Rpc(u.eth, key, fetchFn, pauseMs); const d = await verifyEthSwapDryRun(r); sections.push({ name: 'Ethereum swap dry-run (eth_call simulation, nothing sent)', at: `block ${d.block ?? '?'}`, checks: d.checks, calls: r.calls }); }
  if (only !== 'eth') { const r = new Rpc(u.sol, key, fetchFn, pauseMs); const s = await verifySolana(r); sections.push({ name: 'Solana mainnet', at: `slot ${s.slot ?? '?'}`, checks: s.checks, calls: r.calls }); }
  if (args.includes('--pools') && only !== 'eth') { const r = new Rpc(u.sol, key, fetchFn, pauseMs); const d = await verifySolanaPool(r, fetchFn); sections.push({ name: 'Solana pool reads (Raydium AMM v4 SOL/USDC)', at: `slot ${d.slot ?? '?'}`, checks: d.checks, calls: r.calls }); }
  if (args.includes('--swap-sim') && only !== 'eth') { const r = new Rpc(u.sol, key, fetchFn, pauseMs); const d = await simulateSolSwap(r, args[args.indexOf('--swap-sim') + 1]); sections.push({ name: 'Solana swap simulation (Raydium AMM v4 SOL->USDC, simulateTransaction, nothing signed or sent)', at: `slot ${d.slot ?? '?'}`, checks: d.checks, calls: r.calls }); }
  const stamp = new Date().toISOString(); const date = stamp.slice(0, 10); const scope = [only, args.includes('--dry-run') ? 'dry-run' : '', args.includes('--swap-sim') ? 'swap-sim' : ''].filter(Boolean).join('-'); const md = render(date, sections).split(key).join('***');
  // Unique file per run: reports are evidence and must never be overwritten.
  mkdirSync(outDir, { recursive: true }); writeFileSync(`${outDir}/${stamp.replace(/[:.]/g, '-')}-${scope}.md`, md); out(md);
  return sections.some(s => s.checks.some(c => c.status === 'fail')) ? 1 : 0;
}
if (process.argv[1]?.endsWith('run.ts')) main().then(c => process.exit(c));
