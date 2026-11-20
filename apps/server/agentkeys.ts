/** Agent keys: a signed-in user lets an AI agent trade their own (self-custodial, Privy-delegated) wallet by itself, within caps the user sets per key.
 *
 *  - Made only from a Privy sign-in session (the person, not a bot): POST /v1/auth/agent-keys. The token (mta_ + 32 random bytes) is shown once; Redis keeps only its
 *    SHA-256 hash with the account, the caps and an expiry. Revoke with DELETE /v1/auth/agent-keys/:id; it stops working on the next request.
 *  - What an agent key may do: every read route, and market buys and sells. Nothing else (no standing orders, TWAP, bulk, copy, wallet linking, cancels, kill switch).
 *  - Caps, checked by the server before the trade is built (the agent cannot skip them): chains it may trade, the most native coin per buy and per UTC day per chain,
 *    the highest slippage. Buys must name the amount in the chain's plain units (sol, eth, bnb). A buy that fails gives its amount back to the day's budget.
 *    `allowRiskyToken` is refused. The chain's own server caps (e.g. BASE_MAX_TRADE_ETH) and the user's Privy policy still apply on top.
 *  - The wallet stays the user's: trades are signed by their Privy wallet under the policy they granted; the server never holds the key. */
import { createHash, randomBytes } from 'node:crypto';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import { CHAIN_SPECS } from './chains.ts';

type Redis = { cmd: (...a: (string | number)[]) => unknown };
export interface AgentCap { perTrade: string; daily: string }
export interface AgentKey { id: string; userId: string; label: string; caps: Record<string, AgentCap>; maxSlippagePct: number; createdAt: string; expiresAt: string }

export const AGENT_PREFIX = 'mta_';
export const MAX_KEYS_PER_USER = 10;
const DEC = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/;
const recKey = (ns: string, h: string) => `${ns}:agentkey:${h}`;
const userSet = (ns: string, u: string) => `${ns}:agentkeys:${u}`;
const spendKey = (ns: string, h: string, chain: string, day: string) => `${ns}:agentspend:${h}:${chain}:${day}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Plain decimal units -> integer nano-units (9 decimals), exactly. */
export const nano = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i) * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9)); };
const fmt = (n: bigint) => { const i = n / 1_000_000_000n, f = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, ''); return f ? `${i}.${f}` : `${i}`; };
/** The plain-units field a chain's trades take for its native coin (sol, eth, bnb); undefined on a chain with none (practice). */
export const amountKeyOf = (chain: string) => { const sp = CHAIN_SPECS[chain]; const n = sp?.evm?.nativeSymbol ?? (sp?.kind === 'solana' ? 'SOL' : undefined); return n?.toLowerCase(); };
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const bad = (message: string, fix?: string) => new SdkError('bad_request', message, fix, 400);

/** Check and normalise a create request against the chains this server runs. */
export function parseAgentRequest(b: any, served: string[]): { label: string; caps: Record<string, AgentCap>; maxSlippagePct: number; ttlDays: number } {
  if (!b || typeof b !== 'object') throw bad('Send JSON: { label, caps: { <chain>: { perTrade, daily } }, maxSlippagePct?, ttlDays? }.');
  const label = String(b.label ?? 'agent').trim();
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(label)) throw bad('label: 1 to 40 letters, digits, spaces, dot, dash or underscore.');
  if (!b.caps || typeof b.caps !== 'object' || Array.isArray(b.caps) || !Object.keys(b.caps).length) throw bad('caps: name at least one chain, e.g. { "solana": { "perTrade": "0.05", "daily": "0.2" } }.');
  const caps: Record<string, AgentCap> = {};
  for (const [chain, c] of Object.entries<any>(b.caps)) {
    if (!served.includes(chain) || !amountKeyOf(chain)) throw bad(`caps.${chain}: not a real-funds chain this server runs (${served.filter(x => amountKeyOf(x)).join(', ')}).`);
    const perTrade = String(c?.perTrade ?? ''), daily = String(c?.daily ?? '');
    if (!DEC.test(perTrade) || !DEC.test(daily)) throw bad(`caps.${chain}: perTrade and daily are plain amounts of the native coin, e.g. "0.05".`);
    if (nano(perTrade) <= 0n || nano(daily) <= 0n) throw bad(`caps.${chain}: both must be above 0.`);
    if (nano(perTrade) > nano(daily)) throw bad(`caps.${chain}: perTrade cannot be more than daily.`);
    caps[chain] = { perTrade: fmt(nano(perTrade)), daily: fmt(nano(daily)) };
  }
  const maxSlippagePct = b.maxSlippagePct === undefined ? 5 : Number(b.maxSlippagePct);
  if (!Number.isFinite(maxSlippagePct) || maxSlippagePct < 0.1 || maxSlippagePct > 20) throw bad('maxSlippagePct: 0.1 to 20.');
  const ttlDays = b.ttlDays === undefined ? 30 : Number(b.ttlDays);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) throw bad('ttlDays: a whole number of days, 1 to 90.');
  return { label, caps, maxSlippagePct, ttlDays };
}

/** Make a key for `userId`. Returns the token once; Redis keeps its hash, with the record expiring with the key. */
export function createAgentKey(r: Redis, ns: string, userId: string, req: ReturnType<typeof parseAgentRequest>, now = Date.now()) {
  const live = listAgentKeys(r, ns, userId);
  if (live.length >= MAX_KEYS_PER_USER) throw new SdkError('too_many_keys', `You already have ${MAX_KEYS_PER_USER} agent keys.`, 'Revoke one you no longer use.', 409);
  const token = AGENT_PREFIX + randomBytes(32).toString('base64url'), h = sha(token), ttlS = req.ttlDays * 86_400;
  const rec: AgentKey = { id: h.slice(0, 16), userId, label: req.label, caps: req.caps, maxSlippagePct: req.maxSlippagePct, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlS * 1000).toISOString() };
  r.cmd('SET', recKey(ns, h), JSON.stringify(rec), 'EX', ttlS);
  r.cmd('SADD', userSet(ns, userId), h);
  return { token, key: rec };
}

/** The user's keys that still exist (expired ones are dropped from the index as they are seen). Never returns a token or a full hash. */
export function listAgentKeys(r: Redis, ns: string, userId: string): AgentKey[] {
  const hs = (r.cmd('SMEMBERS', userSet(ns, userId)) as string[] | null) ?? [], out: AgentKey[] = [];
  for (const h of hs) {
    const v = r.cmd('GET', recKey(ns, h)); if (typeof v !== 'string') { r.cmd('SREM', userSet(ns, userId), h); continue; }
    try { out.push(JSON.parse(v)); } catch { /* skip */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Revoke one of the user's keys by its id. False when the user has no such key. */
export function revokeAgentKey(r: Redis, ns: string, userId: string, id: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const hs = (r.cmd('SMEMBERS', userSet(ns, userId)) as string[] | null) ?? [], h = hs.find(x => x.startsWith(id)); if (!h) return false;
  r.cmd('DEL', recKey(ns, h)); r.cmd('SREM', userSet(ns, userId), h); return true;
}

/** The key a bearer hash belongs to, or undefined (unknown, revoked, expired, or Redis unreachable: refusing is the safe side). */
export function lookupAgentKey(r: Redis, ns: string, hash: Buffer, now = Date.now()): AgentKey | undefined {
  try {
    const v = r.cmd('GET', recKey(ns, hash.toString('hex'))); if (typeof v !== 'string') return undefined;
    const k: AgentKey = JSON.parse(v);
    if (typeof k?.userId !== 'string' || k.userId.includes(':') || Date.parse(k.expiresAt) <= now) return undefined;
    return k;
  } catch { return undefined; }
}

/** Routes an agent key may call: every read route, plus these. */
export const AGENT_TRADE_ROUTES = new Set(['POST /v1/trades/buy', 'POST /v1/trades/sell']);

/** The server-side check of one agent call on `chain`, before it runs. Throws to refuse; returns a function that gives a failed buy's amount back to the day's budget. */
export function agentGuard(r: Redis, ns: string, chain: string, now: () => number = Date.now) {
  return (k: AgentKey & { hash: string }, route: { method: string; path: string; scope: string }, body: any): (() => void) | undefined => {
    if (route.scope === 'read') return undefined;
    const id = `${route.method} ${route.path}`;
    if (!AGENT_TRADE_ROUTES.has(id)) throw new SdkError('agent_not_allowed', `An agent key may only read and make market buys and sells; ${id} is not allowed.`, 'Do this yourself in the app, signed in.', 403);
    const cap = k.caps[chain], ak = amountKeyOf(chain);
    if (!cap || !ak) throw new SdkError('agent_chain_not_allowed', `This agent key may not trade on ${chain}.`, `Its chains: ${Object.keys(k.caps).join(', ')}. Make a new key in the app to add one.`, 403);
    if (body?.allowRiskyToken === true) throw new SdkError('agent_not_allowed', 'An agent key cannot skip the token safety and price checks (allowRiskyToken).', 'Leave allowRiskyToken out.', 403);
    const slip = body?.slippagePct ?? (body?.slippageBps !== undefined ? Number(body.slippageBps) / 100 : undefined);
    if (slip !== undefined && !(Number(slip) <= k.maxSlippagePct)) throw new SdkError('agent_slippage', `Slippage ${slip}% is over this agent key's limit of ${k.maxSlippagePct}%.`, `Use at most ${k.maxSlippagePct}%.`, 403);
    if (route.path !== '/v1/trades/buy') return undefined;   // sells turn the user's tokens back into the native coin in the same wallet
    if (body?.amount !== undefined) throw new SdkError('agent_amount_units', `An agent buy names its amount in plain ${ak.toUpperCase()} as "${ak}", not raw "amount".`, `Send "${ak}": "0.01".`, 400);
    const amt = String(body?.[ak] ?? '');
    if (!DEC.test(amt) || nano(amt) <= 0n) throw new SdkError('bad_request', `Say how much ${ak.toUpperCase()} to spend: "${ak}": "0.01".`, undefined, 400);
    const n = nano(amt);
    if (n > nano(cap.perTrade)) throw new SdkError('agent_cap_trade', `${amt} ${ak.toUpperCase()} is over this agent key's limit of ${cap.perTrade} per buy on ${chain}.`, `Buy at most ${cap.perTrade} ${ak.toUpperCase()}.`, 403);
    const sk = spendKey(ns, k.hash, chain, day(now())), after = BigInt(String(r.cmd('INCRBY', sk, n.toString())));
    r.cmd('EXPIRE', sk, 2 * 86_400);
    if (after > nano(cap.daily)) {
      r.cmd('DECRBY', sk, n.toString());
      const left = nano(cap.daily) - (after - n);
      throw new SdkError('agent_cap_daily', `This buy would take today's agent spending on ${chain} over ${cap.daily} ${ak.toUpperCase()} (${fmt(left > 0n ? left : 0n)} left today, UTC).`, 'Wait for the next UTC day, or raise the limit with a new key in the app.', 403);
    }
    return () => { try { r.cmd('DECRBY', sk, n.toString()); } catch { /* keeping it counted is the safe side */ } };
  };
}

/** Today's spending per chain for a key, for the app's list. */
export function agentSpentToday(r: Redis, ns: string, k: AgentKey, now = Date.now()): Record<string, string> {
  const hs = (r.cmd('SMEMBERS', userSet(ns, k.userId)) as string[] | null) ?? [], h = hs.find(x => x.startsWith(k.id)); if (!h) return {};
  return Object.fromEntries(Object.keys(k.caps).map(c => [c, fmt(BigInt(String(r.cmd('GET', spendKey(ns, h, c, day(now))) ?? '0')))]));
}
