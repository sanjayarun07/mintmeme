/** Read or update the Solana trading policy in Privy (the policy the server's signer is limited by; README → Solana policy rules).
 *  usage: node --env-file=.env --experimental-transform-types --no-warnings scripts/privy-policy.ts                 show the policy (read-only)
 *         node --env-file=.env --experimental-transform-types --no-warnings scripts/privy-policy.ts --add-program <id>   add ONE program to the allowed-programs rule
 *  The update changes only the `programId` list of the ALLOW rule named `allowed-programs` (PATCH /v1/policies/{policy}/rules/{rule}, https://docs.privy.io/controls/policies/update-a-policy.md);
 *  every other rule and field is sent back exactly as Privy returned it. Secrets come from .env and are never printed. */
import { authorizationSignature } from '../packages/sol/src/privysigner.ts';
import { b58decode } from '../packages/sol/src/tx.ts';

const e = process.env, need = (k: string) => { const v = e[k]?.trim(); if (!v) { console.error(`${k} is not set in .env`); process.exit(2); } return v; };
const appId = need('PRIVY_APP_ID'), secret = need('PRIVY_APP_SECRET'), authKey = need('PRIVY_AUTH_PRIVATE_KEY'), policyId = need('PRIVY_SOLANA_POLICY_ID');
const base = (e.PRIVY_API_URL || 'https://api.privy.io').replace(/\/$/, '');
async function call(method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const url = base + path, headers: Record<string, string> = { authorization: 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64'), 'privy-app-id': appId };
  if (body !== undefined) { headers['content-type'] = 'application/json'; headers['privy-authorization-signature'] = authorizationSignature(authKey, appId, method as 'POST', url, body); }
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Privy ${method} ${path.replace(policyId, '<policy>')} answered ${r.status}: ${String(j?.error ?? j?.message ?? t).slice(0, 300)}`);
  return j;
}
const programsOf = (rule: any): string[] => { const c = (rule.conditions ?? []).find((c: any) => c.field === 'programId'); return Array.isArray(c?.value) ? c.value : c?.value ? [c.value] : []; };
function show(p: any) {
  console.log(`Policy "${p.name}" (${p.chain_type}), owner: ${p.owner_id ?? 'none'}, ${p.rules?.length ?? 0} rules`);
  for (const r of p.rules ?? []) console.log(`  - ${r.name} [${r.action}, ${r.method}]: ${(r.conditions ?? []).map((c: any) => `${c.field_source}.${c.field} ${c.operator} ${Array.isArray(c.value) ? `[${c.value.length} values]` : c.value}`).join(' AND ')}`);
  const allow = (p.rules ?? []).find((r: any) => r.name === 'allowed-programs'); if (allow) console.log(`  allowed programs: ${programsOf(allow).join(', ')}`);
}

const policy = await call('GET', `/v1/policies/${encodeURIComponent(policyId)}`);
show(policy);
const i = process.argv.indexOf('--add-program');
if (i > 0) {
  const prog = process.argv[i + 1] ?? ''; if (b58decode(prog).length !== 32) throw new Error('not a program id');
  const rule = (policy.rules ?? []).find((r: any) => r.name === 'allowed-programs' && r.action === 'ALLOW');
  if (!rule) throw new Error('no ALLOW rule named allowed-programs in this policy');
  const cond = (rule.conditions ?? []).find((c: any) => c.field === 'programId');
  if (!cond || (cond.operator !== 'in' && cond.operator !== 'eq')) throw new Error('the allowed-programs rule has no programId "in" condition: change it in the dashboard');
  if (programsOf(rule).includes(prog)) { console.log(`\n${prog} is already allowed. Nothing changed.`); process.exit(0); }
  const conditions = rule.conditions.map((c: any) => c === cond ? { ...c, operator: 'in', value: [...programsOf(rule), prog] } : c);
  const body = { name: rule.name, method: rule.method, conditions, action: rule.action };
  await call('PATCH', `/v1/policies/${encodeURIComponent(policyId)}/rules/${encodeURIComponent(rule.id)}`, body);
  console.log(`\nAdded ${prog} to allowed-programs. Read back:`);
  show(await call('GET', `/v1/policies/${encodeURIComponent(policyId)}`));
}
