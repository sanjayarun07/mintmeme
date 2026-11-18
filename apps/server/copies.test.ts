/** Copy trading on the server's real Solana accounts, offline: the RPC and Jupiter are stand-ins (a stubbed global fetch), Privy is the stand-in from packages/sol/test.
 *  Covers body validation against the account caps, create / list / delete over the HTTP API, that configs and leader cursors come back after a restart (and history is
 *  never copied), and that a copied buy passes the manual-buy checks first: token safety, the stock switch and the stock fill price. Copies here are track-only or refused,
 *  so nothing is signed or sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NATIVE } from '../../packages/core/src/index.ts';
import type { LeaderEvent, LeaderSource } from '../../packages/core/src/index.ts';
import { DevSolSigner } from '../../packages/sol/src/signer.ts';
import { XSTOCKS_KEYS, JupiterStockPrices } from '../../packages/sol/src/index.ts';
import { fakePrivy } from '../../packages/sol/test/fakeprivy.ts';
import { createApi } from '../api/server.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';
import { solanaAccounts } from './solaccount.ts';
import { parseCopyBody, GatedLeaderSource, intendedLamports } from './solcopy.ts';

const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', WSOL = 'So11111111111111111111111111111111111111112', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const sg = new DevSolSigner(), LEADER = sg.add(randomBytes(32)), SAFE = sg.add(randomBytes(32)), FROZEN = sg.add(randomBytes(32));
const mem = () => { const m = new Map<string, string>(); const f = (n: string) => ({ read: () => m.get(n), write: (d: string) => { m.set(n, d); }, describe: () => n }); return Object.assign(f, { m }); };
const CAPS = { maxTradeLamports: 50_000_000n, dailyCapLamports: 250_000_000n };
const code = (re: string) => (e: any) => { assert.equal(e.code, re, e.message); return true; };

/** The world: SOL at $100, TSLA at $400 a share; SAFE is a plain token with both authorities revoked, FROZEN has a freeze authority (token safety blocks it).
 *  The leader's transactions are a list, oldest first, served like getSignaturesForAddress / getTransaction / getSignatureStatuses. */
function world(o: { perSol?: bigint } = {}) {
  const head = { slot: 1000 }, txs: { sig: string; slot: number; tx: any }[] = [];
  const parsedMint = (owner: string, info: any) => ({ owner, lamports: 1, data: { program: owner === T22 ? 'spl-token-2022' : 'spl-token', parsed: { type: 'mint', info } } });
  const mints: Record<string, any> = {
    [TSLAX]: parsedMint(T22, { decimals: 8, supply: '1000000000000', mintAuthority: 'MintAuth111', freezeAuthority: XSTOCKS_KEYS.freezeAuthority, isInitialized: true, extensions: [
      { extension: 'permanentDelegate', state: { delegate: XSTOCKS_KEYS.permanentDelegate } }, { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
      { extension: 'scaledUiAmountConfig', state: { multiplier: '1', newMultiplier: '1', newMultiplierEffectiveTimestamp: 0 } },
      { extension: 'pausableConfig', state: { authority: XSTOCKS_KEYS.pauseAuthority, paused: false } }, { extension: 'transferHook', state: { programId: null } }, { extension: 'tokenMetadata', state: { symbol: 'TSLAx' } }] }),
    [SAFE]: parsedMint(TOKEN, { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true }),
    [FROZEN]: parsedMint(TOKEN, { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: 'Freeze1111111111111111111111111111111111111', isInitialized: true }),
  };
  const perSol = (m: string) => (m === TSLAX ? o.perSol ?? 25_000_000n : 1_000_000_000n);   // TSLAx: 0.25 share per SOL is the fair price; others: 1000 tokens per SOL
  const rpc = (m: string, p: any[]): any => {
    if (m === 'getSlot') return head.slot; if (m === 'getBlockTime') return Math.floor(Date.now() / 1000); if (m === 'getMinimumBalanceForRentExemption') return 2_039_280;
    if (m === 'getAccountInfo') return { value: mints[p[0]] ?? null };
    if (m === 'getMultipleAccounts') return { value: (p[0] as string[]).map(a => mints[a] ?? null) };
    if (m === 'getTokenLargestAccounts') return { value: [{ address: 'H1', amount: '10000000000' }, { address: 'H2', amount: '5000000000' }] };
    if (m === 'getTokenAccountsByOwner') return { value: [] };
    if (m === 'getSignaturesForAddress') { const [who, q] = p; let list = txs.filter(() => who === LEADER).slice().reverse(); if (q.until) { const i = list.findIndex(t => t.sig === q.until); if (i >= 0) list = list.slice(0, i); } return list.slice(0, q.limit).map(t => ({ signature: t.sig, slot: t.slot, err: null })); }
    if (m === 'getTransaction') { const t = txs.find(x => x.sig === p[0]); return t ? { slot: t.slot, ...t.tx } : null; }
    if (m === 'getSignatureStatuses') { const t = txs.find(x => x.sig === p[0][0]); return { value: [t ? { slot: t.slot, err: null } : null] }; }
    throw new Error(`unscripted ${m}`);
  };
  const quote = (u: URL) => { const i = u.searchParams.get('inputMint')!, out = u.searchParams.get('outputMint')!, amt = BigInt(u.searchParams.get('amount')!);
    const outAmount = i === WSOL ? amt * perSol(out) / 1_000_000_000n : amt * 1_000_000_000n / perSol(i);
    return { inputMint: i, outputMint: out, inAmount: String(amt), outAmount: String(outAmount), otherAmountThreshold: String(outAmount * 99n / 100n), swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', contextSlot: head.slot, routePlan: [] }; };
  const real = globalThis.fetch;
  const fetchFn = (async (url: any, init?: any) => { const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return real(url, init);   // the API under test
    if (u.pathname.endsWith('/quote')) return new Response(JSON.stringify(quote(u)), { status: 200 });
    if (init?.method === 'POST') { const b = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: rpc(b.method, b.params ?? []) }), { status: 200 }); }
    throw new Error(`unscripted fetch ${u}`); }) as typeof fetch;
  const prices = new JupiterStockPrices({ fetchFn: (async () => new Response(JSON.stringify({ [TSLAX]: { usdPrice: 400, stockData: { price: 400 } } }))) as any });
  let n = 0;
  /** The leader spends `lamports` on `mint` (and receives `tokens`), `age` slots before the head. */
  const leaderBuys = (mint: string, lamports: bigint, tokens: bigint, age = 2) => { const sig = `leadersig${++n}`.padEnd(64, 'x');
    txs.push({ sig, slot: head.slot - age, tx: { transaction: { message: { accountKeys: [LEADER, 'Other1111111111111111111111111111111111111'], instructions: [] } }, meta: { err: null, fee: 5000,
      preBalances: [10_000_000_000, 1], postBalances: [Number(10_000_000_000n - lamports - 5000n - 2_039_280n), 1], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint, owner: LEADER, uiTokenAmount: { amount: String(tokens) } }] } } });
    return sig; };
  return { fetchFn, prices, head, leaderBuys, real };
}

async function account(w: ReturnType<typeof world>, o: { stocks?: boolean; state?: ReturnType<typeof mem>; seed?: Uint8Array } = {}) {
  const seed = o.seed ?? randomBytes(32), addr = new DevSolSigner().add(seed), fp = fakePrivy({ seed });
  globalThis.fetch = w.fetchFn;   // the RPC client and Jupiter quotes inside createSolanaTrader use the global fetch
  const acc = solanaAccounts({ rpcUrl: 'http://rpc.test', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, solUsd: async () => ({ price: 100, at: Date.now() }), caps: CAPS, stocks: { enabled: o.stocks ?? false, prices: w.prices } });
  const state = o.state ?? mem(); if (!o.state) state('solwallet').write(JSON.stringify({ address: addr, walletId: 'wallet-1', linkedAt: 1 }));
  const a = await acc.make('alice', state); await a.trader.resume();
  const errors: string[] = []; a.trader.on(e => { if (e.type === 'error') errors.push(`${e.where}: ${e.message}`); });
  return { acc, a, addr, seed, state, errors, restore: () => { globalThis.fetch = w.real; } };
}

test('copy body: one sizing rule, caps no higher than the account caps, leaders are addresses and never the wallet itself, tickers in lists become mints', () => {
  const p = (b: any) => parseCopyBody(b, { caps: CAPS, follower: SAFE, now: 1 });
  const ok = p({ leader: LEADER, fixedSol: '0.01' });
  assert.deepEqual(ok.leaders, [LEADER]); assert.deepEqual(ok.sizing, { fixedLamports: '10000000' }); assert.equal(ok.maxPerTradeLamports, '50000000'); assert.equal(ok.dailyLamports, '250000000');
  assert.equal(ok.sides, 'both'); assert.equal(ok.exitMode, 'full-on-exit'); assert.equal(ok.slippageBps, 500); assert.match(ok.id, /^c-/);
  assert.throws(() => p({ leader: LEADER }), code('bad_request'));
  assert.throws(() => p({ leader: LEADER, fixedSol: '0.01', percent: 10 }), code('bad_request'));
  assert.throws(() => p({ leader: LEADER, percent: 10, maxPerTradeSol: '0.06' }), (e: any) => { assert.equal(e.code, 'above_cap'); assert.match(e.message, /0\.05 SOL/); return true; });
  assert.throws(() => p({ leader: LEADER, percent: 10, dailySol: '1' }), code('above_cap'));
  assert.throws(() => p({ leader: LEADER, fixedSol: '0.02', maxPerTradeSol: '0.01' }), code('above_cap'));
  assert.throws(() => p({ leader: SAFE, fixedSol: '0.01' }), code('bad_address'), 'the wallet cannot copy itself');
  assert.throws(() => p({ leader: 'not-an-address', fixedSol: '0.01' }), code('bad_address'));
  assert.throws(() => p({ leaders: [], fixedSol: '0.01' }), code('bad_request'));
  assert.throws(() => p({ leader: LEADER, fixedSol: '0.01', sol: '0.01' }), code('bad_request'), 'unknown fields are refused, not ignored');
  assert.throws(() => p({ leader: LEADER, percent: 0 }), code('bad_number'));
  const lists = p({ leaders: [LEADER, LEADER], percent: 25, maxPerTradeSol: '0.02', allow: ['TSLAx', SAFE], block: [FROZEN] });
  assert.deepEqual(lists.leaders, [LEADER]); assert.deepEqual(lists.allow, [TSLAX, SAFE]); assert.deepEqual(lists.block, [FROZEN]);
  const ev = { quoteAmount: 100_000_000n } as LeaderEvent;
  assert.equal(intendedLamports(lists, ev), 20_000_000n, '25% of 0.1 SOL is 0.025, capped at 0.02'); assert.equal(intendedLamports(ok, ev), 10_000_000n);
});

test('gated source: a buy that fails a check, or is too old, is dropped and noted; sells, filtered tokens and passing buys go through; an inactive wallet copies nothing', async () => {
  const ev = (o: Partial<LeaderEvent>): LeaderEvent => ({ provider: 'rpc', chain: 'sol-main', txHash: 'tx', logIndex: 0, leader: LEADER, kind: 'swap', side: 'buy', token: SAFE, quoteAmount: 10_000_000n, tokenAmount: 1n, leaderBalanceBefore: 0n, leaderBalanceAfter: 1n, leaderPriceE18: 1n, confirmations: 2, ...o });
  let queue: LeaderEvent[] = []; const inner: LeaderSource = { poll: async () => { const events = queue; queue = []; return { events, reorged: [] }; }, snapshot: () => ({ x: 1 }), load: () => {} };
  const s = parseCopyBody({ leader: LEADER, fixedSol: '0.01', block: [TSLAX] }, { caps: CAPS, follower: SAFE, now: 1 }); let active = true; const gated: [string, bigint][] = [], prepared: string[] = [];
  const g = new GatedLeaderSource(inner, s, { active: () => active, prepare: async m => { prepared.push(m); }, gate: async (m, l) => { gated.push([m, l]); if (m === FROZEN) throw new SdkError('unsafe_token', 'blocked by the safety check'); }, now: () => 5 });
  queue = [ev({ txHash: 'a' }), ev({ txHash: 'b', token: FROZEN }), ev({ txHash: 'c', confirmations: 151 }), ev({ txHash: 'd', side: 'sell', confirmations: 500 }), ev({ txHash: 'e', token: TSLAX }), ev({ txHash: 'f', kind: 'transfer' })];
  const r = await g.poll();
  assert.deepEqual(r.events.map(e => e.txHash), ['a', 'd', 'e', 'f']);
  assert.deepEqual(gated, [[SAFE, 10_000_000n], [FROZEN, 10_000_000n]], 'only buys that the copy rules could take are checked'); assert.ok(!prepared.includes(TSLAX), 'a blocked token is not even looked up');
  assert.deepEqual(g.notes.map(n => [n.txHash, n.why.slice(0, 30)]), [['b', 'unsafe_token: blocked by the s'], ['c', 'the leader\'s buy is 151 slots ']]);
  active = false; queue = [ev({ txHash: 'g' }), ev({ txHash: 'h', side: 'sell' })];
  assert.deepEqual((await g.poll()).events, []); assert.equal(g.notes.length, 4); assert.deepEqual(g.snapshot(), { x: 1 });
});

test('copies over the API: created, listed and deleted; history before creation is never copied; a track-only copy sizes the buy and the checks run first', async () => {
  const w = world(), { a, addr, restore, errors } = await account(w);
  const api = createApi({ keys: [{ key: 'alice-key-0123456789abcdef', userId: 'alice' }], traderFor: () => a.trader, prepare: (_u, b, p) => a.prepare!(b, p),
    makeCopy: (_t, b) => a.copies!.create(b), removeCopy: (_t, id) => a.copies!.remove(id), listCopies: () => a.copies!.list() });
  const port = await api.listen(0), call = async (method: string, path: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: 'Bearer alice-key-0123456789abcdef', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json() as any }; };
  try {
    w.leaderBuys(SAFE, 40_000_000n, 40_000_000n);   // before the copy exists: never copied
    const bad = await call('POST', '/v1/copies', { leader: LEADER, percent: 50, dailySol: '5' }); assert.equal(bad.status, 400); assert.equal(bad.j.error.code, 'above_cap');
    const c = await call('POST', '/v1/copies', { id: 'whale', leader: LEADER, percent: 50, maxPerTradeSol: '0.01', trackOnly: true });
    assert.equal(c.status, 200, JSON.stringify(c.j)); assert.equal(c.j.id, 'whale'); assert.equal(c.j.percent, 50); assert.equal(c.j.maxPerTradeSol, '0.01'); assert.equal(c.j.running, true);
    assert.equal((await call('POST', '/v1/copies', { id: 'whale', leader: LEADER, percent: 5 })).j.error.code, 'exists');
    await a.trader.tick(); assert.deepEqual((await call('GET', '/v1/copies')).j[0].decisions, [], 'the trade before creation is history');
    w.leaderBuys(SAFE, 40_000_000n, 40_000_000n); w.leaderBuys(FROZEN, 40_000_000n, 40_000_000n);
    await a.trader.tick();
    const [v] = (await call('GET', '/v1/copies')).j;
    assert.ok(v.decisions.some((d: any) => d.decision === `track-only: would buy 10000000 of ${SAFE}`), JSON.stringify({ v, errors }));   // 50% of 0.04 SOL is 0.02, capped at 0.01
    assert.equal(v.skippedByChecks.length, 1); assert.equal(v.skippedByChecks[0].token, FROZEN); assert.match(v.skippedByChecks[0].why, /safety check/);
    const del = await call('DELETE', '/v1/copies/whale'); assert.deepEqual(del.j, { id: 'whale', removed: true });
    assert.deepEqual((await call('GET', '/v1/copies')).j, []); assert.equal((await call('DELETE', '/v1/copies/whale')).status, 404);
    // the same id again starts from now: the earlier leader buys are not copied
    assert.equal((await call('POST', '/v1/copies', { id: 'whale', leader: LEADER, fixedSol: '0.005', trackOnly: true })).status, 200); await a.trader.tick();
    assert.deepEqual((await call('GET', '/v1/copies')).j[0].decisions, []);
    assert.equal(addr.length > 30, true);
  } finally { await api.close(); restore(); }
});

test('copies survive a restart: the config comes back with its leader cursor, so trades made while the node was down are seen and older history is not', async () => {
  const w = world(), first = await account(w);
  try {
    w.leaderBuys(SAFE, 20_000_000n, 20_000_000n);
    await first.a.copies!.create({ id: 'k1', leader: LEADER, fixedSol: '0.003', trackOnly: true });
    w.leaderBuys(SAFE, 20_000_000n, 20_000_000n);   // after creation, while the node is "down"
    first.a.trader.stop();
    const again = await account(w, { state: first.state, seed: first.seed });
    const [v] = again.a.copies!.list() as any[]; assert.equal(v.id, 'k1'); assert.equal(v.fixedSol, '0.003'); assert.equal(v.running, true);
    await again.a.trader.tick();
    const [after] = again.a.copies!.list() as any[];
    assert.deepEqual(after.decisions.map((d: any) => d.decision), [`track-only: would buy 3000000 of ${SAFE}`], 'exactly the one trade after creation');
    again.a.copies!.remove('k1'); assert.equal(first.state.m.get('copy-k1'), '', 'deleting forgets the runner state'); assert.match(first.state.m.get('copies')!, /"copies":\[\]/);
  } finally { first.restore(); }
});

test('copied stock buys: refused while STOCKS_ENABLED is off, and when enabled the fill must be near the share price (same rules as a manual buy)', async () => {
  for (const [stocks, perSol, want] of [[false, 25_000_000n, /not enabled/], [true, 8_000_000n, /per share against a share price of \$400/], [true, 25_000_000n, null]] as const) {
    const w = world({ perSol }), { a, restore } = await account(w, { stocks });
    try {
      await a.copies!.create({ id: 's', leader: LEADER, fixedSol: '0.01', trackOnly: true });
      w.leaderBuys(TSLAX, 40_000_000n, 1_000_000n * perSol / 1_000_000n * 40n / 1000n);
      await a.trader.tick();
      const [v] = a.copies!.list() as any[];
      if (want) { assert.equal(v.skippedByChecks.length, 1, JSON.stringify(v)); assert.match(v.skippedByChecks[0].why, want); assert.deepEqual(v.decisions, []); }
      else { assert.deepEqual(v.skippedByChecks, [], JSON.stringify(v.skippedByChecks)); assert.deepEqual(v.decisions.map((d: any) => d.decision), [`track-only: would buy 10000000 of ${TSLAX}`]); }
    } finally { restore(); }
  }
});

test('copies need an active wallet: an account with no linked wallet refuses to create one', async () => {
  const w = world(), st = mem(); globalThis.fetch = w.fetchFn;
  try {
    const fp = fakePrivy({ seed: randomBytes(32) }), acc = solanaAccounts({ rpcUrl: 'http://rpc.test', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, solUsd: async () => ({ price: 100, at: Date.now() }), stocks: { prices: w.prices } });
    const a = await acc.make('bob', st); await assert.rejects(a.copies!.create({ leader: LEADER, fixedSol: '0.01' }), code('wallet_not_active'));
    void NATIVE;
  } finally { globalThis.fetch = w.real; }
});
