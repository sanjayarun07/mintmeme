/** Merge single-chain namespaces into one for a CHAINS=... server (apps/server/merge.ts has the rules). Dry run unless --apply; never prints state values.
 *  usage: npm run server:merge -- --into <ns> [--into-chain solana] <fromNs>[=<chain>] ... [--apply]
 *  e.g.   npm run server:merge -- --into memedesk-sol memedesk-base memedesk-robinhood            (prints the plan)
 *         npm run server:merge -- --into memedesk-sol memedesk-base memedesk-robinhood --apply    (with every server on these namespaces stopped) */
import { SyncRedis } from '../packages/core/src/index.ts';
import { planMerge, applyMerge } from '../apps/server/merge.ts';

const a = process.argv.slice(2); let into = '', intoChain: string | undefined, apply = false; const from: { ns: string; chain?: string }[] = [];
for (let i = 0; i < a.length; i++) {
  if (a[i] === '--into') into = a[++i] ?? ''; else if (a[i] === '--into-chain') intoChain = a[++i]; else if (a[i] === '--apply') apply = true;
  else if (a[i].startsWith('--')) { console.error(`unknown option ${a[i]}`); process.exit(2); }
  else { const [ns, chain] = a[i].split('='); from.push({ ns, ...(chain ? { chain } : {}) }); }
}
if (!into || !from.length) { console.error('usage: npm run server:merge -- --into <ns> [--into-chain <chain>] <fromNs>[=<chain>] ... [--apply]'); process.exit(2); }
const r = new SyncRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', 5000);
try {
  const p = planMerge(r, into, from, intoChain);
  console.log(`into ${p.into} (default chain ${p.intoChain || '?'})`);
  for (const s of p.sources) console.log(`  from ${s.ns} (${s.chain}): ${s.users} user${s.users === 1 ? '' : 's'}, ${s.keys} state key${s.keys === 1 ? '' : 's'} -> ${p.into}:u:<user>:@${s.chain}:<name>`);
  for (const o of p.ops) console.log(o.op === 'copy' ? `    copy ${o.from} -> ${o.to}${o.ttlMs ? ` (ttl ${o.ttlMs} ms)` : ''}` : o.op === 'sadd' ? `    add ${o.members.length} member${o.members.length === 1 ? '' : 's'} to ${o.key}` : `    mark ${o.ns} merged (a server started on it refuses)`);
  for (const s of p.skipped) console.log(`  skip ${s.key}: ${s.why}`);
  if (p.problems.length) { console.log(`\nNOT MERGED, ${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}:`); for (const x of p.problems) console.log(`  - ${x}`); process.exitCode = 1; }
  else if (!apply) console.log('\nDry run: nothing written. Run again with --apply (every server on these namespaces stopped).');
  else { const { copied } = applyMerge(r, p); const chains = [p.intoChain, ...p.sources.map(s => s.chain)].join(',');
    console.log(`\nMerged: ${copied} keys copied. Sources are kept (marked merged). Start every node with NAMESPACE=${p.into} CHAINS=${chains}`); }
} finally { r.close(); }
