/** Create the Privy trading policy for one EVM chain of the execution server (README → Base policy rules, with that chain's chain id and V2 router).
 *  usage: npm run privy:evm-policy -- bnb             print the policy it would create (nothing sent)
 *         npm run privy:evm-policy -- bnb --create    create it in Privy and print its id (put it in .env as that chain's PRIVY_<CHAIN>_POLICY_ID)
 *  Rules (method eth_signTransaction, as the server has Privy sign and sends the transaction itself):
 *    <dex>-v2-swaps   chain_id eq <id>, to eq the V2 router, value lte the chain's per-trade cap (the server's default <CHAIN>_MAX_TRADE_ETH)
 *    approve-router   chain_id eq <id>, value eq 0, approve.spender eq the V2 router (a sell approves exactly the amount sold)
 *    kyberswap-*      only when the chain routes through KyberSwap (its aggregator setting defaults to kyberswap): the router 0x6131b5fa...37b5
 *  Anything else (a plain coin or token transfer, another contract) matches no rule and is denied. Owner: none (like the other policies). Secrets come from .env and
 *  are never printed. */
import { CHAIN_SPECS } from '../apps/server/chains.ts';
import { EVM_NETWORKS } from '../packages/sdk/src/base.ts';

const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const APPROVE_ABI = [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' }];
const chain = process.argv[2] ?? '', create = process.argv.includes('--create'), spec = CHAIN_SPECS[chain];
if (!spec?.evm) { console.error(`usage: npm run privy:evm-policy -- <${Object.values(CHAIN_SPECS).filter(s => s.evm).map(s => s.id).join('|')}> [--create]`); process.exit(2); }
const net = EVM_NETWORKS[spec.evm.network], id = String(spec.evm.chainId);
const capWei = (BigInt(Math.round(Number(process.env[`${spec.evm.capsPrefix}_MAX_TRADE_ETH`] ?? spec.evm.maxTradeDefault) * 1e9)) * 10n ** 9n).toString();
const tx = (field: string, operator: string, value: string) => ({ field_source: 'ethereum_transaction', field, operator, value });
const approve = (spender: string) => ({ field_source: 'ethereum_calldata', field: 'approve.spender', abi: APPROVE_ABI, operator: 'eq', value: spender });
const dex = net.dex.toLowerCase().replace(/\s*v2$/, '').replace(/[^a-z0-9]+/g, '-');
const rules = [
  { name: `${dex}-v2-swaps`, method: 'eth_signTransaction', conditions: [tx('chain_id', 'eq', id), tx('to', 'eq', net.router), tx('value', 'lte', capWei)], action: 'ALLOW' },
  { name: 'approve-router', method: 'eth_signTransaction', conditions: [tx('chain_id', 'eq', id), tx('value', 'eq', '0'), approve(net.router)], action: 'ALLOW' },
];
const agg = spec.evm.aggregatorEnv ? (process.env[spec.evm.aggregatorEnv]?.trim() || spec.evm.defaultAggregator) : undefined;
if (agg === 'kyberswap') rules.push(
  { name: 'kyberswap-swaps', method: 'eth_signTransaction', conditions: [tx('chain_id', 'eq', id), tx('to', 'eq', KYBER_ROUTER), tx('value', 'lte', capWei)], action: 'ALLOW' },
  { name: 'approve-kyberswap', method: 'eth_signTransaction', conditions: [tx('chain_id', 'eq', id), tx('value', 'eq', '0'), approve(KYBER_ROUTER)], action: 'ALLOW' });
const body = { version: '1.0', name: `memedesk-${chain}`, chain_type: 'ethereum', rules };

console.log(`Policy memedesk-${chain} for ${spec.label} (chain id ${id}), ${net.dex} router ${net.router}, cap ${Number(capWei) / 1e18} ${spec.evm.nativeSymbol} per transaction:`);
for (const r of rules) console.log(`  - ${r.name}: ${r.conditions.map((c: any) => `${c.field} ${c.operator} ${c.value}`).join(' AND ')}`);
if (!create) { console.log('\nNothing sent. Run again with --create to create it in Privy.'); process.exit(0); }

const need = (k: string) => { const v = process.env[k]?.trim(); if (!v) { console.error(`${k} is not set in .env`); process.exit(2); } return v; };
const appId = need('PRIVY_APP_ID'), secret = need('PRIVY_APP_SECRET'), api = (process.env.PRIVY_API_URL || 'https://api.privy.io').replace(/\/$/, '');
const auth = { authorization: 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64'), 'privy-app-id': appId };
const r = await fetch(`${api}/v1/policies`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
const j: any = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`Privy answered ${r.status}: ${String(j?.error ?? j?.message ?? '').slice(0, 300)}`); process.exit(1); }
// read it back: what Privy stored, not what was sent
const back: any = await (await fetch(`${api}/v1/policies/${encodeURIComponent(j.id)}`, { headers: auth, signal: AbortSignal.timeout(15_000) })).json();
console.log(`\nCreated. Privy has "${back.name}" (${back.chain_type}), ${back.rules?.length} rules, owner ${back.owner_id ?? 'none'}.`);
console.log(`Put this in .env: PRIVY_${spec.evm.capsPrefix}_POLICY_ID=${j.id}`);
