/** A stand-in for Privy's wallet API for an ETHEREUM wallet on Base, for tests and local forks. It checks the app credentials and the authorization signature as Privy
 *  documents them, applies the README's Base policy (eth_signTransaction only; chain id 8453; destination the Uniswap V2 router with value at most the cap, or an ERC-20
 *  approve whose spender is the router with no value; and the Relay rules (relay-buys, relay-sells, approve-relay): Relay's router with value at most the cap, its approval proxy with no value, approve of the proxy),
 *  and signs with a throwaway key. `mode` makes it misbehave on purpose (tests of our checks). */
import http from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonical } from '../../sol/src/privysigner.ts';
import { testKey, signTx } from './ecdsa.ts';
import type { TestKey } from './ecdsa.ts';

export const BASE_ROUTER = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24';
/** Relay's v3.2 router and approval proxy on Base (README → Base policy rules, relay-*). */
export const RELAY_ROUTER = '0x0729e2a4716d9f7dd17858d5d504426d228697f7', RELAY_PROXY = '0x5567954cd026cebfe486062cb75848e0f1c12e58';
/** KyberSwap's MetaAggregationRouterV2 on Base (README → Base policy rules, kyberswap-*). */
export const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
export function fakePrivyEvm(o: { key?: TestKey; base?: string; signerId?: string; policyId?: string; capWei?: bigint; chainId?: number; router?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cfg = { appId: 'app-test', appSecret: 'secret-test-0123456789abcdef0123456789abcdef', signerId: o.signerId ?? 'quorum-1', policyId: o.policyId ?? 'policy-base',
    authKey: 'wallet-auth:' + privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), apiUrl: o.base ?? 'https://privy.test', chainType: 'ethereum' as const };
  const key = o.key ?? testKey(), address = key.address, router = (o.router ?? BASE_ROUTER).toLowerCase(), chainId = o.chainId ?? 8453, cap = o.capWei ?? 10n ** 16n;
  const state = { delegated: true as boolean | 'other-policy', policyMethod: 'eth_signTransaction', mode: 'honest' as 'honest' | 'tamper' | 'wrong-key', signed: 0, refused: [] as string[] };
  const big = (v: unknown) => BigInt(v as any);
  function policy(t: any): string | undefined {
    if (Number(t.chain_id) !== chainId) return `chain ${t.chain_id} is not allowed`;
    const to = String(t.to ?? '').toLowerCase(), value = big(t.value ?? 0), data = String(t.data ?? '0x').toLowerCase();
    if (to === router) return value > cap ? 'value above the cap' : undefined;
    if (data.startsWith('0x095ea7b3') && value === 0n && '0x' + data.slice(34, 74) === router) return undefined;   // approve(router, amount)
    // the README's Relay rules (relay-buys, relay-sells, approve-relay): Relay's router (value capped), its approval proxy (no value), approve(approval proxy)
    if (to === RELAY_ROUTER) return value > cap ? 'value above the cap' : undefined;
    if (to === RELAY_PROXY) return value === 0n ? undefined : 'value must be 0';
    if (data.startsWith('0x095ea7b3') && value === 0n && '0x' + data.slice(34, 74) === RELAY_PROXY) return undefined;
    // the README's KyberSwap rules (kyberswap-swaps, approve-kyberswap): KyberSwap's router (value capped), approve(router)
    if (to === KYBER_ROUTER) return value > cap ? 'value above the cap' : undefined;
    if (data.startsWith('0x095ea7b3') && value === 0n && '0x' + data.slice(34, 74) === KYBER_ROUTER) return undefined;
    return `destination ${to} is not allowed`;
  }
  async function handle(method: string, url: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: unknown }> {
    if (headers.authorization !== 'Basic ' + Buffer.from(`${cfg.appId}:${cfg.appSecret}`).toString('base64') || headers['privy-app-id'] !== cfg.appId) return { status: 401, json: { error: 'Invalid app credentials' } };
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/v1/wallets') {
      const mine = (u.searchParams.get('address') ?? '').toLowerCase() === address && u.searchParams.get('chain_type') === 'ethereum';
      const signers = state.delegated ? [{ signer_id: cfg.signerId, override_policy_ids: [state.delegated === 'other-policy' ? 'policy-x' : cfg.policyId] }] : [];
      // Privy returns checksummed addresses: compare without case
      return { status: 200, json: { data: mine ? [{ id: 'evm-wallet-1', address: '0x' + address.slice(2).toUpperCase(), chain_type: 'ethereum', additional_signers: signers }] : [], next_cursor: null } };
    }
    if (method === 'GET' && u.pathname === `/v1/policies/${cfg.policyId}`) return { status: 200, json: { id: cfg.policyId, chain_type: 'ethereum', rules: [{ name: 'uniswap-router', method: state.policyMethod, action: 'ALLOW', conditions: [] }] } };
    if (method === 'POST' && u.pathname === '/v1/wallets/evm-wallet-1/rpc') {
      const b = JSON.parse(body), payload = Buffer.from(canonical({ version: 1, method: 'POST', url, body: b, headers: { 'privy-app-id': cfg.appId } }));
      if (!verify('sha256', payload, publicKey, Buffer.from(headers['privy-authorization-signature'] ?? '', 'base64'))) return { status: 401, json: { error: 'Invalid authorization signature' } };
      if (!state.delegated) return { status: 403, json: { error: 'No valid authorization for this wallet' } };
      if (b.method !== 'eth_signTransaction' || !b.params?.transaction) return { status: 400, json: { error: 'unsupported request' } };
      if (state.policyMethod !== 'eth_signTransaction') return { status: 400, json: { error: 'RPC request denied due to policy violation' } };
      const t = b.params.transaction, why = policy(t);
      if (why) { state.refused.push(why); return { status: 400, json: { error: `Policy violation: ${why}` } }; }
      const tx = { chainId: Number(t.chain_id), nonce: Number(t.nonce), maxPriorityFeePerGas: big(t.max_priority_fee_per_gas), maxFeePerGas: big(t.max_fee_per_gas), gasLimit: big(t.gas_limit), to: String(t.to), value: big(t.value ?? 0), data: String(t.data ?? '0x') };
      if (state.mode === 'tamper') tx.value += 1n;
      const raw = signTx(state.mode === 'wrong-key' ? testKey() : key, tx); state.signed++;
      return { status: 200, json: { method: 'eth_signTransaction', data: { signed_transaction: raw, encoding: 'rlp' } } };
    }
    return { status: 404, json: { error: 'not found' } };
  }
  const fetchFn = (async (input: any, init: any = {}) => {
    const r = await handle(init.method ?? 'GET', String(input), Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), String(init.body ?? ''));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const listen = (port = 0) => new Promise<{ url: string; close: () => void }>(res => {
    const srv = http.createServer(async (req, resp) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const base = `http://127.0.0.1:${(srv.address() as any).port}`, r = await handle(req.method ?? 'GET', base + (req.url ?? '/'), req.headers as Record<string, string>, Buffer.concat(chunks).toString());
      resp.writeHead(r.status, { 'content-type': 'application/json' }); resp.end(JSON.stringify(r.json)); });
    srv.listen(port, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() }));
  });
  return { cfg, key, address, state, fetchFn, listen };
}
