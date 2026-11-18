/** Several chains on one node (CHAINS=solana,base): config parsing, routing by /v1/<chain>/ prefix, per-chain wallet linking and state, forwarding and failover with
 *  both chains, the pinned default chain, one rate budget per key, and a chain that fails to start without taking the user's other chains down. The HTTP tests need the
 *  local Redis (skipped without one); Privy is the local stand-ins (fakeprivy.ts, fakeprivyevm.ts) and the RPCs point at closed ports (no trades here: npm run verify:server-multi). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SyncRedis } from '../../packages/core/src/index.ts';
import { DevSolSigner } from '../../packages/sol/src/signer.ts';
import { fakePrivy } from '../../packages/sol/test/fakeprivy.ts';
import { fakePrivyEvm } from '../../packages/evm/test/fakeprivyevm.ts';
import { personalSign } from '../../packages/evm/test/ecdsa.ts';
import { createNode, splitChain } from './node.ts';
import type { ChainAccounts } from './node.ts';
import { practiceAccount } from './accounts.ts';
import { solanaAccounts, linkRoutes } from './solaccount.ts';
import { baseAccounts, baseLinkRoutes, walletState } from './baseaccount.ts';
import { parseChains, checkSpecs, CHAIN_SPECS, stateName, RESERVED_SEGMENTS } from './chains.ts';
import { buildChains } from './main.ts';
import { EVM_NETWORKS } from '../../packages/sdk/src/base.ts';
import { MemeClient } from '../../packages/sdk/src/client.ts';

test('CHAINS: the list wins, MODE is a one-chain shorthand, nonsense is refused with the reason', () => {
  assert.deepEqual(parseChains({ CHAINS: 'solana, Base' }).map(s => s.id), ['solana', 'base']);
  assert.deepEqual(parseChains({ MODE: 'base-mainnet' }).map(s => s.id), ['base']);
  assert.deepEqual(parseChains({ MODE: 'solana-mainnet' }).map(s => s.id), ['solana']);
  assert.deepEqual(parseChains({}).map(s => s.id), ['practice']);
  assert.deepEqual(parseChains({ CHAINS: 'base,solana', MODE: 'solana-mainnet' }).map(s => s.id), ['base', 'solana'], 'a MODE that is in the list is fine');
  assert.throws(() => parseChains({ CHAINS: 'solana,dogechain' }), /dogechain is not a known chain/);
  assert.throws(() => parseChains({ CHAINS: 'solana,solana' }), /twice/);
  assert.throws(() => parseChains({ CHAINS: 'solana', MODE: 'base-mainnet' }), /disagree/);
  assert.throws(() => parseChains({ CHAINS: 'practice,solana' }), /practice/);
  assert.throws(() => parseChains({ MODE: 'eth-mainnet' }), /not built in/);
  assert.deepEqual(parseChains({ CHAINS: 'bnb,robinhood' }).map(s => s.evm!.chainId), [56, 4663]);
});

test('chain specs: ids are safe path segments, every EVM spec has SDK contracts, and state names keep the default chain unprefixed', () => {
  checkSpecs(CHAIN_SPECS);
  for (const s of Object.values(CHAIN_SPECS)) { assert.ok(!RESERVED_SEGMENTS.has(s.id)); if (s.evm) { const n = EVM_NETWORKS[s.evm.network]; assert.ok(n, `${s.id} has contracts`); assert.equal(n.chainId, s.evm.chainId, `${s.id} chain id`); } }
  assert.throws(() => checkSpecs({ trades: { id: 'trades', kind: 'evm', label: 'x', evm: CHAIN_SPECS.base.evm } }), /not allowed/);
  assert.equal(stateName('solana', true, 'engine'), 'engine'); assert.equal(stateName('base', false, 'engine'), '@base:engine');
  assert.equal(walletState('base'), 'basewallet', 'the name single-chain Base servers wrote');
  const served = new Set(['solana', 'base']);
  assert.deepEqual(splitChain('/v1/base/trades/buy', served, 'solana'), { chain: 'base', rest: '/v1/trades/buy' });
  assert.deepEqual(splitChain('/v1/trades/buy', served, 'solana'), { chain: 'solana' });
  assert.deepEqual(splitChain('/v1/solana/wallet', served, 'solana'), { chain: 'solana', rest: '/v1/wallet' });
  assert.deepEqual(splitChain('/v1/bnb/overview', served, 'solana'), { unknown: 'bnb' });
  assert.deepEqual(splitChain('/v1/orders/abc', served, 'solana'), { chain: 'solana' });
});

test('buildChains: each chain names the settings it is missing; EVM chains read their own RPC, policy and caps', () => {
  assert.throws(() => buildChains({ CHAINS: 'base,bnb' }), e => /base needs BASE_RPC_URL \(or ALCHEMY_API_KEY\)/.test((e as Error).message) && /bnb needs .*PRIVY_BNB_POLICY_ID/.test((e as Error).message));
  const env = { CHAINS: 'base,bnb,robinhood', ALCHEMY_API_KEY: 'k', PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 's', PRIVY_AUTH_KEY_ID: 'i', PRIVY_AUTH_PRIVATE_KEY: 'wallet-auth:x', PRIVY_BASE_POLICY_ID: 'p1', PRIVY_BNB_POLICY_ID: 'p2', PRIVY_ROBINHOOD_POLICY_ID: 'p3' };
  const b = buildChains(env);
  assert.deepEqual(b.chains.map(c => [c.id, c.legacyMarks]), [['base', ['basewallet']], ['bnb', ['bnbwallet']], ['robinhood', ['robinhoodwallet']]]);
  assert.deepEqual(b.statusChecks.map(c => c.name), ['Base mainnet RPC', 'Privy', 'BNB Chain RPC', 'Robinhood Chain RPC'], 'Privy is checked once');
  assert.throws(() => buildChains({ ...env, BNB_MAX_TRADE_ETH: '1', BNB_DAILY_CAP_ETH: '0.5' }), /BNB_DAILY_CAP_ETH must be at least/);
  assert.throws(() => buildChains({ ...env, BASE_AGGREGATOR: 'uniswap' }), /BASE_AGGREGATOR must be relay or kyberswap/);
});

let up = false; try { const c = new SyncRedis('redis://127.0.0.1:6379', 1500); up = c.cmd('PING') === 'PONG'; c.close(); } catch { up = false; }
const skip = up ? false : 'no local Redis on 127.0.0.1:6379';
const wipe = (n: string) => { const c = new SyncRedis(); try { const ks: string[] = c.cmd('KEYS', `${n}:*`) ?? []; for (const k of ks) c.cmd('DEL', k); } finally { c.close(); } };
const freePort = () => new Promise<number>(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const KA = 'alice-secret-key-0123456789abcdef', KB = 'bob---secret-key-0123456789abcdef', hash = (k: string) => createHash('sha256').update(k).digest('hex');
const keys = [{ keyHash: hash(KA), userId: 'alice' }, { keyHash: hash(KB), userId: 'bob' }];
const call = async (base: string, key: string, method: string, path: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any, node: r.headers.get('x-memedesk-node') }; };

test('one node group, two chains, one key: each chain has its own wallet link and state; forwarding and failover carry both', { skip }, async () => {
  const n = `memedesk-chains-test:${Date.now()}`, seed = randomBytes(32), sol = new DevSolSigner(), solAddr = sol.add(seed), fp = fakePrivy({ seed });
  const fe = fakePrivyEvm(), feSrv = await fe.listen();
  const sa = solanaAccounts({ rpcUrl: 'http://127.0.0.1:9', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, solUsd: async () => ({ price: 100, at: Date.now() }) });
  const ba = baseAccounts({ rpcUrl: 'http://127.0.0.1:9', privy: { ...fe.cfg, apiUrl: feSrv.url }, relay: false });
  const chains: ChainAccounts[] = [
    { id: 'solana', makeAccount: sa.make, extraRoutes: h => linkRoutes({ privy: sa.privy, status: sa.status, safety: sa.safety, ...h }), legacyMarks: ['solwallet'] },
    { id: 'base', makeAccount: ba.make, extraRoutes: h => baseLinkRoutes({ privy: ba.privy, status: ba.status, chain: 'base', ...h }), legacyMarks: ['basewallet'] }];
  const live: { nd: Awaited<ReturnType<typeof createNode>>; url: string }[] = [];
  const mk = async (cs = chains) => { const port = await freePort(), url = `http://127.0.0.1:${port}`; const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, chains: cs, leaseTtlMs: 3000, sweepMs: 60_000, requireAof: false, log: () => {} }); await nd.listen(port); const x = { nd, url }; live.push(x); return x; };
  try {
    const a = await mk(), b = await mk();
    const ch = await fetch(a.url + '/v1/chains').then(r => r.json()) as any;
    assert.equal(ch.default, 'solana'); assert.deepEqual(ch.chains.map((c: any) => c.prefix), ['/v1/solana/', '/v1/base/']);
    // the old paths are the default chain; /v1/base/... is Base
    let w = await call(a.url, KA, 'GET', '/v1/wallet'); assert.equal(w.status, 200); assert.equal(w.j.linked, false); assert.match(w.j.why, /Privy wallet/);
    let wb = await call(a.url, KA, 'GET', '/v1/base/wallet'); assert.equal(wb.j.chain, 'base'); assert.equal(wb.j.linked, false); assert.match(wb.j.why, /Ethereum wallet/);
    assert.equal((await call(a.url, KA, 'GET', '/v1/solana/wallet')).j.linked, false, 'the default chain also answers under its own prefix');
    assert.equal((await call(a.url, KA, 'GET', '/v1/bnb/overview')).j.error.code, 'chain_not_enabled');
    assert.equal((await call(a.url, KA, 'GET', '/v1/base/app/webhook')).status, 404);
    const o1 = await call(a.url, KA, 'GET', '/v1/overview'), o2 = await call(a.url, KA, 'GET', '/v1/base/overview');
    assert.equal(o1.status, 200); assert.equal(o2.status, 200); assert.notEqual(o1.j.chain, o2.j.chain, 'two accounts on two chains');
    const owner = w.node!, other = owner === a.url ? b.url : a.url;

    // link Base through the node that does NOT own alice (forwarded, prefix kept); Solana stays unlinked
    const st = await call(other, KA, 'POST', '/v1/base/wallet/link/start', { address: fe.address }); assert.match(st.j.message, /on Base\./);
    const fin = await call(other, KA, 'POST', '/v1/base/wallet/link/finish', { address: fe.address, signature: personalSign(fe.key, st.j.message) });
    assert.equal(fin.status, 200, JSON.stringify(fin.j)); assert.equal(fin.node, owner); assert.deepEqual([fin.j.chain, fin.j.linked, fin.j.active], ['base', true, true]);
    assert.equal((await call(other, KA, 'GET', '/v1/wallet')).j.linked, false, 'the Solana link is separate');
    // a Base address cannot be linked as the Solana wallet, and the Solana link start is its own flow
    assert.equal((await call(a.url, KA, 'POST', '/v1/wallet/link/start', { address: fe.address })).status, 400);
    const ss = await call(a.url, KA, 'POST', '/v1/solana/wallet/link/start', { address: solAddr });
    const sf = await call(a.url, KA, 'POST', '/v1/wallet/link/finish', { address: solAddr, signature: Buffer.from(sol.sign(solAddr, new TextEncoder().encode(ss.j.message))).toString('base64') });
    assert.equal(sf.status, 200, JSON.stringify(sf.j)); assert.equal(sf.j.address, solAddr);
    // state: Solana keeps the unprefixed names, Base is under base:
    const r = new SyncRedis(); try {
      assert.equal(Number(r.cmd('EXISTS', `${n}:u:alice:solwallet`)), 1); assert.equal(Number(r.cmd('EXISTS', `${n}:u:alice:@base:basewallet`)), 1);
      assert.equal(Number(r.cmd('EXISTS', `${n}:u:alice:basewallet`)), 0);
      assert.equal(r.cmd('GET', `${n}:chains:default`), 'solana');
    } finally { r.close(); }
    // trades: refused per chain with that chain's reason, not the other's
    assert.equal((await call(a.url, KB, 'POST', '/v1/base/trades/buy', { token: '0x9a26f5433671751c3276a065f57e5a02d2817973', eth: '0.001' })).j.error.code, 'wallet_not_active');

    // the owner shuts down: the other node takes alice over with BOTH links
    const o = live.find(x => x.url === owner)!; await o.nd.drain(); live.splice(live.indexOf(o), 1);
    wb = await call(other, KA, 'GET', '/v1/base/wallet'); assert.equal(wb.node, other); assert.deepEqual([wb.j.linked, wb.j.address, wb.j.active], [true, fe.address, true]);
    w = await call(other, KA, 'GET', '/v1/wallet'); assert.deepEqual([w.j.linked, w.j.address], [true, solAddr]);
    // unlinking Base leaves Solana
    assert.equal((await call(other, KA, 'DELETE', '/v1/base/wallet')).j.linked, false); assert.equal((await call(other, KA, 'GET', '/v1/wallet')).j.linked, true);
    // the SDK client: chain option prefixes every call
    const cb = new MemeClient({ baseUrl: other, apiKey: KA, chain: 'base' }); assert.equal((await cb.overview()).chain, o2.j.chain);

    // the namespace's default chain is pinned: listing base first now is refused
    await assert.rejects(mk([chains[1], chains[0]]), /started with solana as its default/);
  } finally { for (const x of live) await x.nd.drain().catch(() => {}); feSrv.close(); wipe(n); }
});

test('a namespace written by a single-chain Base server is not handed to Solana as its default chain', { skip }, async () => {
  const n = `memedesk-chains-legacy:${Date.now()}`, r = new SyncRedis();
  try {
    r.cmd('SADD', `${n}:users`, 'alice'); r.cmd('SET', `${n}:u:alice:basewallet`, '{}');
    const cs: ChainAccounts[] = [{ id: 'solana', makeAccount: practiceAccount, legacyMarks: ['solwallet'] }, { id: 'base', makeAccount: practiceAccount, legacyMarks: ['basewallet'] }];
    await assert.rejects(createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: 'http://127.0.0.1:1', keys, chains: cs, requireAof: false, log: () => {} }), /holds base accounts .* list base first/);
    // a chain that is not even listed: CHAINS=solana alone on a namespace a Base server wrote (main.ts passes every known chain's marks)
    await assert.rejects(createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: 'http://127.0.0.1:1', keys, chains: [cs[0]], otherLegacyMarks: [{ chain: 'base', mark: 'basewallet' }], requireAof: false, log: () => {} }), /holds base accounts .* add base first in CHAINS/);
    const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: 'http://127.0.0.1:1', keys, chains: [cs[1], cs[0]], requireAof: false, log: () => {} });
    assert.equal(nd.defaultChain, 'base'); await nd.drain();
  } finally { r.close(); wipe(n); }
});

test('overlapping reloads of one chain run one after the other and leave exactly one Trader running', { skip }, async () => {
  const n = `memedesk-chains-reload:${Date.now()}`, live = new Set<number>(); let seq = 0, reloadOf: ((u: string) => Promise<void>) | undefined;
  const mkAcct = async (u: string, st: (name: string) => import('../../packages/core/src/index.ts').Backend) => { const id = ++seq; await new Promise(r => setTimeout(r, 30)); const a = practiceAccount(u, st), stop = a.trader.stop.bind(a.trader);
    live.add(id); a.trader.stop = () => { live.delete(id); stop(); }; return a; };
  const cs: ChainAccounts[] = [{ id: 'solana', makeAccount: practiceAccount }, { id: 'base', makeAccount: mkAcct, extraRoutes: h => { reloadOf = h.reload; return []; } }];
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, chains: cs, sweepMs: 60_000, requireAof: false, log: () => {} });
  await nd.listen(port);
  try {
    assert.equal((await call(url, KA, 'GET', '/v1/base/overview')).status, 200); assert.equal(live.size, 1);
    await Promise.all([reloadOf!('alice'), reloadOf!('alice'), reloadOf!('alice')]);
    assert.equal(live.size, 1, 'one Trader for base after three overlapping reloads'); assert.equal(seq, 4);
  } finally { await nd.drain().catch(() => {}); wipe(n); }
});

test('a chain that cannot start for a user answers 503 for that chain only, is retried, and the rate budget is one per key across chains', { skip }, async () => {
  const n = `memedesk-chains-fail:${Date.now()}`; let failing = true;
  const cs: ChainAccounts[] = [{ id: 'solana', makeAccount: practiceAccount }, { id: 'base', makeAccount: (u, s) => { if (failing) throw new Error('base RPC is down'); return practiceAccount(u, s); } }];
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const nd = await createNode({ redisUrl: 'redis://127.0.0.1:6379', namespace: n, publicUrl: url, keys, chains: cs, chainRetryMs: 200, sweepMs: 60_000, requireAof: false, log: () => {}, rate: { perSecond: 0.001, burst: 5 } });
  await nd.listen(port);
  try {
    assert.equal((await call(url, KA, 'GET', '/v1/overview')).status, 200, 'Solana runs');
    const f = await call(url, KA, 'GET', '/v1/base/overview'); assert.equal(f.status, 503); assert.equal(f.j.error.code, 'chain_unavailable'); assert.match(f.j.error.message, /base RPC is down/);
    assert.match(await (await fetch(url + '/metrics')).text(), /memedesk_chain_accounts_unavailable 1/);
    failing = false; await new Promise(r => setTimeout(r, 250));
    assert.equal((await call(url, KA, 'GET', '/v1/base/overview')).status, 200, 'retried on the next request once due');
    // 5 tokens for the key in all: 2 used above (a 503 for an unavailable chain costs none), 3 more across both chains, then 429 on either
    assert.equal((await call(url, KA, 'GET', '/v1/overview')).status, 200); assert.equal((await call(url, KA, 'GET', '/v1/base/overview')).status, 200); assert.equal((await call(url, KA, 'GET', '/v1/solana/overview')).status, 200);
    assert.equal((await call(url, KA, 'GET', '/v1/base/overview')).status, 429); assert.equal((await call(url, KA, 'GET', '/v1/overview')).status, 429);
  } finally { await nd.drain().catch(() => {}); wipe(n); }
});
