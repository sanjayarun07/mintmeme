/** Merge single-chain namespaces into one multi-chain namespace (npm run server:merge). Before CHAINS, each chain ran its own server on its own NAMESPACE
 *  (say memedesk-sol for Solana, memedesk-base for Base). One CHAINS=solana,base server reads ONE namespace: its default chain keeps the unprefixed state names, and
 *  every other chain's state is under `@<chain>:` (chains.ts). This copies each source namespace's per-user state into the target under its chain's prefix:
 *
 *    <from>:u:<user>:<name>  ->  <into>:u:<user>:@<fromChain>:<name>      (engine, orders, ledger, basewallet, settings, ...; the lease `lock` is not copied)
 *    <from>:users            ->  added to <into>:users
 *    <from>:app:<app>:users  ->  added to <into>:app:<app>:users          (app end users)
 *    <from>:app:<app>:webhook / :fees  ->  copied when the target has none, refused when it has a different one
 *
 *  Safety: nothing is written unless every check passes. It refuses when a node is alive or a user's lease is held in any of the namespaces, so every server must be
 *  stopped first. It also refuses when a target key already exists (no overwrite), when two sources are the same chain, or when a source is the target's chain.
 *  Sources are not deleted: each one is marked merged (`<from>:chains:default` = `merged-into:<into>`), so a server started on it refuses to start instead of
 *  trading from a stale copy of the state. Delete a source by hand once the merged server has run well. */
import type { SyncRedis } from '../../packages/core/src/index.ts';
import { CHAIN_SPECS, defaultChainKey, stateName } from './chains.ts';
import { nodeKey, nodesKey } from './status.ts';
import { usersKey } from './lease.ts';

export const MERGED_PREFIX = 'merged-into:';
export interface MergeSource { ns: string; chain?: string }
export interface MergePlan {
  into: string; intoChain: string;
  sources: { ns: string; chain: string; users: number; keys: number }[];
  /** Every write, in order: copy a string key, add members to a set, or mark a source merged. */
  ops: ({ op: 'copy'; from: string; to: string; ttlMs?: number } | { op: 'sadd'; key: string; members: string[] } | { op: 'mark'; ns: string })[];
  /** Keys of a source that are not copied, and why (node heartbeats, the source's own bookkeeping, keys of users not in its users set). */
  skipped: { key: string; why: string }[];
  /** Reasons the merge cannot run. Empty means it can. */
  problems: string[];
}

const scan = (r: SyncRedis, pattern: string): string[] => {
  const out: string[] = []; let cur = '0';
  do { const [next, keys] = r.cmd('SCAN', cur, 'MATCH', pattern, 'COUNT', 1000) as [string, string[]]; out.push(...keys); cur = next; } while (cur !== '0');
  return out;
};
/** A namespace's chain: its pinned default (chains:default), else the wallet link a single-chain server wrote (solwallet is Solana, <chain>wallet an EVM chain). */
function chainOf(r: SyncRedis, ns: string, users: string[]): string | undefined {
  const pinned = r.cmd('GET', defaultChainKey(ns)) as string | null; if (pinned) return pinned;
  for (const u of users) for (const [mark, chain] of [['solwallet', 'solana'], ...Object.keys(CHAIN_SPECS).map(c => [`${c}wallet`, c])])
    if (Number(r.cmd('EXISTS', `${ns}:u:${u}:${mark}`)) === 1) return chain;
  return undefined;
}

export function planMerge(r: SyncRedis, into: string, sources: MergeSource[], intoChainArg?: string): MergePlan {
  const problems: string[] = [], ops: MergePlan['ops'] = [], skipped: MergePlan['skipped'] = [], out: MergePlan['sources'] = [];
  const intoUsers = (r.cmd('SMEMBERS', usersKey(into)) as string[] | null) ?? [];
  const intoChain = intoChainArg ?? chainOf(r, into, intoUsers) ?? '';
  if (!intoChain) problems.push(`${into}: cannot tell its chain (no ${defaultChainKey(into)} and no wallet link): pass --into-chain <chain>`);
  else if (!CHAIN_SPECS[intoChain]) problems.push(`${into}: chain ${intoChain} is not a known chain`);
  const all = [into, ...sources.map(s => s.ns)];
  if (new Set(all).size !== all.length) problems.push('a namespace is listed twice');
  for (const ns of all) {
    const pinned = r.cmd('GET', defaultChainKey(ns)) as string | null;
    if (pinned?.startsWith(MERGED_PREFIX)) problems.push(`${ns} was already merged into ${pinned.slice(MERGED_PREFIX.length)}`);
    const live = ((r.cmd('SMEMBERS', nodesKey(ns)) as string[] | null) ?? []).filter(u => Number(r.cmd('EXISTS', nodeKey(ns, u))) === 1);
    if (live.length) problems.push(`${ns}: node${live.length > 1 ? 's' : ''} ${live.join(', ')} ${live.length > 1 ? 'are' : 'is'} running: stop every server on these namespaces first (and wait 15 s for the heartbeat to expire)`);
    const locks = scan(r, `${ns}:u:*:lock`); if (locks.length) problems.push(`${ns}: ${locks.length} user lease${locks.length > 1 ? 's are' : ' is'} still held (${locks.slice(0, 3).join(', ')}): stop the servers and wait for the leases to expire (15 s)`);
  }
  const seenChains = new Map<string, string>([[intoChain, into]]);
  const fresh = new Set<string>(), appVals = new Map<string, string | null>();   // target keys this plan writes: two sources may not write the same one
  for (const s of sources) {
    const users = (r.cmd('SMEMBERS', usersKey(s.ns)) as string[] | null) ?? [];
    const chain = s.chain ?? chainOf(r, s.ns, users);
    if (!chain) { problems.push(`${s.ns}: cannot tell its chain (no ${defaultChainKey(s.ns)} and no wallet link): pass it as ${s.ns}=<chain>`); continue; }
    if (chain.startsWith(MERGED_PREFIX)) continue;
    if (!CHAIN_SPECS[chain]) { problems.push(`${s.ns}: chain ${chain} is not a known chain`); continue; }
    if (seenChains.has(chain)) { problems.push(`${s.ns} and ${seenChains.get(chain)} are both ${chain}: one namespace per chain`); continue; }
    seenChains.set(chain, s.ns);
    // longest user first, so app end user shop:alice's keys are not read as user shop's state named alice:...
    const byLen = [...users].sort((a, b) => b.length - a.length); let keys = 0;
    for (const key of scan(r, `${s.ns}:*`)) {
      const rest = key.slice(s.ns.length + 1);
      if (rest === 'users' || rest === 'nodes' || rest === 'chains:default' || rest.startsWith('node:')) { skipped.push({ key, why: 'the source namespace\'s own bookkeeping' }); continue; }
      const app = /^app:(.+):(users|webhook|fees)$/.exec(rest);
      if (app) {
        const to = `${into}:${rest}`, type = r.cmd('TYPE', key) as string;
        if (app[2] === 'users') { if (type !== 'set') { problems.push(`${key} is a ${type}, expected a set`); continue; } ops.push({ op: 'sadd', key: to, members: (r.cmd('SMEMBERS', key) as string[]) ?? [] }); continue; }
        const mine = r.cmd('GET', key) as string | null, theirs = appVals.has(to) ? appVals.get(to)! : r.cmd('GET', to) as string | null;
        if (theirs == null) { appVals.set(to, mine); ops.push({ op: 'copy', from: key, to }); }
        else if (theirs !== mine) problems.push(`${to} already exists with a different ${app[2]} than ${key}: set the one you want on ${into} and delete the other, then run again`);
        continue;
      }
      if (!rest.startsWith('u:')) { skipped.push({ key, why: 'not per-user state' }); continue; }
      const ur = rest.slice(2), user = byLen.find(u => ur.startsWith(u + ':'));
      if (!user) { skipped.push({ key, why: 'its user is not in the source\'s users set' }); continue; }
      const name = ur.slice(user.length + 1);
      if (name === 'lock') continue;
      if (name.startsWith('@')) { problems.push(`${key}: ${s.ns} is already a multi-chain namespace (state ${name}); merge only single-chain namespaces`); continue; }
      const type = r.cmd('TYPE', key) as string;
      if (type !== 'string') { problems.push(`${key} is a ${type}: per-user state is expected to be strings`); continue; }
      const to = `${into}:u:${user}:${stateName(chain, false, name)}`;
      if (Number(r.cmd('EXISTS', to)) === 1 || fresh.has(to)) { problems.push(`${to} already exists: refusing to overwrite it`); continue; }
      fresh.add(to); const pttl = Number(r.cmd('PTTL', key));
      ops.push({ op: 'copy', from: key, to, ...(pttl > 0 ? { ttlMs: pttl } : {}) }); keys++;
    }
    if (users.length) ops.push({ op: 'sadd', key: usersKey(into), members: users });
    ops.push({ op: 'mark', ns: s.ns });
    out.push({ ns: s.ns, chain, users: users.length, keys });
  }
  if (!sources.length) problems.push('no source namespace given');
  return { into, intoChain, sources: out, ops, skipped, problems };
}

/** Run a plan with no problems. The target's default chain is pinned first, so a server started on it reads its unprefixed state as that chain. */
export function applyMerge(r: SyncRedis, p: MergePlan) {
  if (p.problems.length) throw new Error('the merge has problems: ' + p.problems.join('; '));
  const pinned = r.cmd('GET', defaultChainKey(p.into)) as string | null;
  if (pinned && pinned !== p.intoChain) throw new Error(`${p.into} has ${pinned} as its default chain, not ${p.intoChain}`);
  r.cmd('SET', defaultChainKey(p.into), p.intoChain, 'NX');
  let copied = 0;
  for (const o of p.ops) {
    if (o.op === 'copy') {
      const v = r.cmd('GET', o.from) as string | null; if (v == null) throw new Error(`${o.from} disappeared during the merge`);
      const ok = o.ttlMs ? r.cmd('SET', o.to, v, 'NX', 'PX', o.ttlMs) : r.cmd('SET', o.to, v, 'NX');
      if (ok !== 'OK') throw new Error(`${o.to} appeared during the merge: stopped (keys already copied stay; run again after checking)`);
      copied++;
    } else if (o.op === 'sadd') { if (o.members.length) r.cmd('SADD', o.key, ...o.members); }
    else r.cmd('SET', defaultChainKey(o.ns), MERGED_PREFIX + p.into);
  }
  return { copied };
}
