/** A stand-in for Privy's wallet API, for tests: it checks the app credentials and the authorization signature exactly as Privy documents them, applies the same rules as
 *  the README's Solana policy (allowed top-level programs, SOL transfer cap, no token transfers), and signs with a local key. Usable as a fetch function or an HTTP server. */
import http from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonical } from '../src/privysigner.ts';
import { DevSolSigner } from '../src/signer.ts';
import { parseMessage } from '../src/jupiterswap.ts';

export const POLICY_PROGRAMS = ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111'];

export function fakePrivy(o: { seed: Uint8Array; base?: string; signerId?: string; policyId?: string; delegated?: boolean | 'other-policy'; policyMethod?: string; /** Programs added to the allowed-programs rule (the proposed JupiterZ Order Engine rule). */ extraPrograms?: string[] }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cfg = { appId: 'app-test', appSecret: 'secret-test-0123456789abcdef0123456789abcdef', signerId: o.signerId ?? 'quorum-1', policyId: o.policyId ?? 'policy-1',
    authKey: 'wallet-auth:' + privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), apiUrl: o.base ?? 'https://privy.test' };
  const key = new DevSolSigner(), address = key.add(o.seed), pub = publicKey;
  const state = { delegated: o.delegated ?? true, policyMethod: o.policyMethod ?? 'signTransaction', signed: 0, refused: [] as string[], lastUrl: '' };
  async function handle(method: string, url: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: unknown }> {
    if (headers.authorization !== 'Basic ' + Buffer.from(`${cfg.appId}:${cfg.appSecret}`).toString('base64') || headers['privy-app-id'] !== cfg.appId) return { status: 401, json: { error: 'Invalid app credentials' } };
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/v1/wallets') {
      const mine = u.searchParams.get('address') === address && u.searchParams.get('chain_type') === 'solana';
      const signers = state.delegated ? [{ signer_id: cfg.signerId, override_policy_ids: [state.delegated === 'other-policy' ? 'policy-x' : cfg.policyId] }] : [];
      return { status: 200, json: { data: mine ? [{ id: 'wallet-1', address, chain_type: 'solana', additional_signers: signers, policy_ids: [] }] : [], next_cursor: null } };
    }
    if (method === 'GET' && u.pathname === `/v1/policies/${cfg.policyId}`) return { status: 200, json: { id: cfg.policyId, chain_type: 'solana', rules: [{ name: 'allowed-programs', method: state.policyMethod, action: 'ALLOW', conditions: [] }] } };
    if (method === 'POST' && u.pathname === '/v1/wallets/wallet-1/rpc') {
      state.lastUrl = url; const b = JSON.parse(body);
      const payload = Buffer.from(canonical({ version: 1, method: 'POST', url, body: b, headers: { 'privy-app-id': cfg.appId } }));
      if (!verify('sha256', payload, pub, Buffer.from(headers['privy-authorization-signature'] ?? '', 'base64'))) return { status: 401, json: { error: 'Invalid authorization signature' } };
      if (!state.delegated) return { status: 403, json: { error: 'No valid authorization for this wallet' } };
      if (b.method !== 'signTransaction' || b.params?.encoding !== 'base64') return { status: 400, json: { error: 'unsupported request' } };
      if (state.policyMethod !== 'signTransaction') return { status: 400, json: { error: 'RPC request denied due to policy violation' } };   // no rule for this method: denied by default
      const tx = Buffer.from(b.params.transaction, 'base64'), n = tx[0], message = tx.subarray(1 + 64 * n), why = policy(message);
      if (why) { state.refused.push(why); return { status: 400, json: { error: `Policy violation: ${why}` } }; }
      const slot = parseMessage(new Uint8Array(message)).staticKeys.slice(0, n).indexOf(address); if (slot < 0) return { status: 400, json: { error: 'wallet is not a signer' } };
      const out = Buffer.from(tx); out.set(key.sign(address, new Uint8Array(message)), 1 + 64 * slot); state.signed++;   // the wallet's own slot (slot 1 on an RFQ fill)
      return { status: 200, json: { method: 'signTransaction', data: { signed_transaction: out.toString('base64'), encoding: 'base64' } } };
    }
    return { status: 404, json: { error: 'not found' } };
  }
  /** The README policy: every top-level instruction must be an allowed program; a System transfer above 0.05 SOL and a token Transfer / TransferChecked are denied. */
  function policy(message: Buffer): string | undefined {
    const m = parseMessage(new Uint8Array(message));
    for (const ix of m.ixs) {
      const prog = m.staticKeys[ix.programIdIndex]; if (!POLICY_PROGRAMS.includes(prog) && !(o.extraPrograms ?? []).includes(prog)) return `program ${prog} is not allowed`;
      const d = Buffer.from(ix.data);
      if (prog === POLICY_PROGRAMS[3] && d.length >= 12 && d.readUInt32LE(0) === 2 && d.readBigUInt64LE(4) > 50_000_000n) return 'SOL transfer above the cap';
      if ((prog === POLICY_PROGRAMS[4] || prog === POLICY_PROGRAMS[5]) && (d[0] === 3 || d[0] === 12)) return 'token transfer';
    }
    return undefined;
  }
  const fetchFn = (async (input: any, init: any = {}) => {
    const r = await handle(init.method ?? 'GET', String(input), Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), String(init.body ?? ''));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  /** Serve it over HTTP on 127.0.0.1 (for code that reads PRIVY_API_URL). Resolves with the base URL; the URL Privy signs over is that base plus the path. */
  const listen = (port = 0) => new Promise<{ url: string; close: () => void }>(res => {
    const srv = http.createServer(async (req, resp) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const base = `http://127.0.0.1:${(srv.address() as any).port}`, r = await handle(req.method ?? 'GET', base + (req.url ?? '/'), req.headers as Record<string, string>, Buffer.concat(chunks).toString());
      resp.writeHead(r.status, { 'content-type': 'application/json' }); resp.end(JSON.stringify(r.json)); });
    srv.listen(port, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() }));
  });
  return { cfg, address, state, fetchFn, listen };
}
