/** MODE=solana-mainnet on real nodes sharing the local Redis (skipped without one), with the Privy stand-in (packages/sol/test/fakeprivy.ts) and no chain: the RPC points at
 *  a closed port, so these tests cover linking, refusal and failover of the account, not trades (the validator run does trades: npm run verify:server-sol). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { DevSolSigner } from '../../packages/sol/src/signer.ts';
import { fakePrivy } from '../../packages/sol/test/fakeprivy.ts';
import { createNode } from './node.ts';
import { solanaAccounts, linkRoutes } from './solaccount.ts';

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const wipe = (n: string) => { const c = new SyncRedis(); try { const ks: string[] = c.cmd('KEYS', `${n}:*`) ?? []; for (const k of ks) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const KA = 'alice-secret-key-0123456789abcdef', KB = 'bob---secret-key-0123456789abcdef', hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(KA), userId: 'alice' }, { keyHash: hash(KB), userId: 'bob' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('real Solana accounts: linking proves the wallet and its Privy permission, trades are refused until then, and every new owner node asks Privy again', { skip }, async () => {
  const n = `memedesk-realmode-test:${Date.now()}`, seed = randomBytes(32), wallet = new DevSolSigner(), addr = wallet.add(seed), fp = fakePrivy({ seed, delegated: false });
  const acc = solanaAccounts({ rpcUrl: 'http://127.0.0.1:9', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, solUsd: async () => ({ price: 100, at: Date.now() }) });
  const mk = async () => { const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, makeAccount: acc.make, extraRoutes: h => linkRoutes({ privy: acc.privy, status: acc.status, safety: acc.safety, ...h }), leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {} });
    await nd.listen(port); return { nd, url }; };
  const a = await mk(), b = await mk(), live = [a, b];
  const call = async (base: string, key: string, method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any, node: r.headers.get('x-memedesk-node') }; };
  const sign = (msg: string, s = wallet, who = addr) => Buffer.from(s.sign(who, new TextEncoder().encode(msg))).toString('base64');
  try {
    let w = await call(a.url, KA, 'GET', '/v1/wallet'); assert.equal(w.status, 200); assert.equal(w.j.linked, false); assert.match(w.j.why, /No wallet is linked/);
    const buy = await call(a.url, KA, 'POST', '/v1/trades/buy', { walletId: addr, token: 'So11111111111111111111111111111111111111112', amount: '1000' });
    assert.equal(buy.status, 409); assert.equal(buy.j.error.code, 'wallet_not_active', 'nothing can trade before a wallet is linked');

    // a signature from a different key does not prove control of the address
    let st = await call(a.url, KA, 'POST', '/v1/wallet/link/start', { address: addr }); const stranger = new DevSolSigner(), sAddr = stranger.add();
    assert.equal((await call(a.url, KA, 'POST', '/v1/wallet/link/finish', { address: addr, signature: sign(st.j.message, stranger, sAddr) })).status, 401);
    // proved, but the wallet has not allowed this server in Privy
    st = await call(a.url, KA, 'POST', '/v1/wallet/link/start', { address: addr });
    const nd = await call(a.url, KA, 'POST', '/v1/wallet/link/finish', { address: addr, signature: sign(st.j.message) }); assert.equal(nd.status, 409); assert.equal(nd.j.error.code, 'not_delegated');
    assert.equal((await call(a.url, KA, 'POST', '/v1/wallet/link/finish', { address: addr, signature: sign(st.j.message) })).status, 410, 'a message is used once');
    // proved and allowed: linked and active, also when asked through the other node (forwarded to the owner)
    fp.state.delegated = true; st = await call(b.url, KA, 'POST', '/v1/wallet/link/start', { address: addr });
    const ok = await call(b.url, KA, 'POST', '/v1/wallet/link/finish', { address: addr, signature: sign(st.j.message) });
    assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.deepEqual([ok.j.linked, ok.j.address, ok.j.active], [true, addr, true]);
    w = await call(b.url, KA, 'GET', '/v1/wallet'); assert.equal(w.j.active, true); const owner = w.node!;
    assert.equal((await call(owner === a.url ? b.url : a.url, KB, 'GET', '/v1/wallet')).j.linked, false, 'bob does not see alice\'s wallet');

    // revoked in Privy, then the owner shuts down: the next owner asks Privy and does not activate the wallet
    fp.state.delegated = false; const o = live.find(x => x.url === owner)!, other = live.find(x => x.url !== owner)!; await o.nd.drain(); live.splice(live.indexOf(o), 1);
    w = await call(other.url, KA, 'GET', '/v1/wallet'); assert.equal(w.node, other.url); assert.equal(w.j.linked, true); assert.equal(w.j.active, false); assert.match(w.j.why, /not allowed automatic trading/);
    assert.equal((await call(other.url, KA, 'POST', '/v1/trades/buy', { walletId: addr, token: 'So11111111111111111111111111111111111111112', amount: '1000' })).j.error.code, 'wallet_not_active');
    // settings: MEV protection off by default; turning it on is stored and validated
    const s0 = await call(other.url, KA, 'GET', '/v1/settings'); assert.deepEqual(s0.j, { mevProtection: false, maxTipSol: '0.0001', tokenSafety: 'block' });
    const s1 = await call(other.url, KA, 'PATCH', '/v1/settings', { mevProtection: true, maxTipSol: '0.0002' }); assert.deepEqual(s1.j, { mevProtection: true, maxTipSol: '0.0002', tokenSafety: 'block' });
    assert.equal((await call(other.url, KA, 'PATCH', '/v1/settings', { tokenSafety: 'warn' })).j.tokenSafety, 'warn'); assert.equal((await call(other.url, KA, 'PATCH', '/v1/settings', { tokenSafety: 'maybe' })).status, 400);
    assert.equal((await call(other.url, KA, 'PATCH', '/v1/settings', { maxTipSol: '0.5' })).j.error.code, 'bad_amount', 'a tip above 0.001 SOL is refused');
    assert.equal((await call(other.url, KA, 'PATCH', '/v1/settings', { mevProtection: 'yes' })).status, 400);
    assert.equal((await call(other.url, KB, 'GET', '/v1/settings')).j.mevProtection, false, 'per user');
    // unlink removes it
    const un = await call(other.url, KA, 'DELETE', '/v1/wallet'); assert.deepEqual([un.j.linked, un.j.active], [false, false]);
    await sleep(10);
  } finally { for (const x of live) await x.nd.drain().catch(() => {}); wipe(n); }
});
