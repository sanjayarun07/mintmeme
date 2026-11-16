import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE } from '../../core/src/index.ts';
import { DevSolSigner, MintInspector, decodeMint, PROGRAMS, SolLeaderWatcher, RaydiumLaunchSource, SolanaChain, base58, b58decode, AMM_V4_LAYOUT } from '../src/index.ts';

const sg = new DevSolSigner(), addr = () => sg.add();
const LEADER = addr(), OTHER = addr(), WSOL = addr(), USDC = addr(), TOK = addr(), TOK2 = addr(), PROGRAM = addr();

/** Scripted chain: an ordered list of transactions (oldest first) that the mock serves like getSignaturesForAddress / getTransaction / getSignatureStatuses. */
class Net {
  txs: { sig: string; slot: number; err?: unknown; tx?: any; touches: string[] }[] = []; head = 1000; gone = new Set<string>(); missingTx = new Set<string>(); accounts = new Map<string, any>(); n = 0;
  calls: string[] = [];
  async call(m: string, p: any[] = []): Promise<any> {
    this.calls.push(m);
    if (m === 'getSlot') return this.head;
    if (m === 'getMinimumBalanceForRentExemption') return 2_039_280;
    if (m === 'getSignaturesForAddress') {
      const [who, o] = p as [string, { limit: number; until?: string; before?: string }]; let list = this.txs.filter(t => t.touches.includes(who) && !this.gone.has(t.sig)).reverse();   // newest first
      if (o.before) list = list.slice(list.findIndex(t => t.sig === o.before) + 1);
      if (o.until) { const i = list.findIndex(t => t.sig === o.until); if (i >= 0) list = list.slice(0, i); }
      return list.slice(0, o.limit).map(t => ({ signature: t.sig, slot: t.slot, err: t.err ?? null }));
    }
    if (m === 'getTransaction') { const t = this.txs.find(x => x.sig === p[0]); if (!t || this.missingTx.has(t.sig)) return null; return { slot: t.slot, ...t.tx }; }
    if (m === 'getSignatureStatuses') { const t = this.txs.find(x => x.sig === p[0][0]); return { value: [t && !this.gone.has(t.sig) ? { slot: t.slot, err: t.err ?? null } : null] }; }
    if (m === 'getMultipleAccounts') return { value: (p[0] as string[]).map(a => this.accounts.get(a) ?? null) };
    if (m === 'getTokenAccountBalance') return { value: { amount: '5000000000' } };
    throw new Error(`unscripted ${m}`);
  }
  add(touches: string[], tx: any, err?: unknown) { const sig = `sig${++this.n}`; this.txs.push({ sig, slot: this.head - 5 + this.n, err, tx, touches }); return sig; }
}
const FEE = 5000n;
const tb = (idx: number, mint: string, owner: string, amount: bigint) => ({ accountIndex: idx, mint, owner, uiTokenAmount: { amount: amount.toString() } });
/** leader swap: lamports/token change as given (fee is paid by the leader, account 0) */
function swapTx(o: { lamports: bigint; pre?: bigint; post?: bigint; mint?: string; extra?: any[]; rentAccounts?: number; fail?: boolean }) {
  const mint = o.mint ?? TOK;
  return { transaction: { message: { accountKeys: [LEADER, OTHER], instructions: [] } }, meta: { err: o.fail ? { InstructionError: [0, 'x'] } : null, fee: Number(FEE),
    preBalances: [10_000_000_000, 1], postBalances: [Number(10_000_000_000n + o.lamports - FEE - BigInt((o.rentAccounts ?? 0) * 2_039_280)), 1],
    preTokenBalances: o.pre ? [tb(1, mint, LEADER, o.pre)] : [], postTokenBalances: [...(o.post ? [tb(1, mint, LEADER, o.post)] : []), ...(o.extra ?? [])] } };
}
const mkWatch = (net: Net, o: { conf?: number } = {}) => new SolLeaderWatcher({ chain: 'sol', wsol: WSOL, leaders: [LEADER], quoteMints: [USDC], minConfirmations: o.conf ?? 0 }, net);

test('leader watcher: the first poll only records "now" and never copies history', async () => {
  const net = new Net(); net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n }));
  const w = mkWatch(net); const r = await w.poll();
  assert.equal(r.events.length, 0);
  net.add([LEADER], swapTx({ lamports: -2_000_000_000n, post: 500n }));
  const r2 = await w.poll(); assert.equal(r2.events.length, 1);
});

test('leader watcher: a buy becomes a swap event from the leader\'s own balance changes (fee and token-account rent are not part of the price)', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  const sig = net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n, rentAccounts: 1 }));
  const [e] = (await w.poll()).events;
  assert.equal(e.kind, 'swap'); assert.equal(e.side, 'buy'); assert.equal(e.token, TOK); assert.equal(e.txHash, sig); assert.equal(e.leader, LEADER);
  assert.equal(e.quoteAmount, 1_000_000_000n); assert.equal(e.tokenAmount, 1000n); assert.equal(e.leaderBalanceBefore, 0n); assert.equal(e.leaderBalanceAfter, 1000n);
  assert.equal(e.leaderPriceE18, 1_000_000_000n * 10n ** 18n / 1000n);
});

test('leader watcher: a sell carries the balance before and after; failed transactions and repeats produce nothing', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  net.add([LEADER], swapTx({ lamports: 900_000_000n, pre: 1000n, post: 400n }));
  net.add([LEADER], swapTx({ lamports: 0n, fail: true, post: 5n }), { InstructionError: [0, 'x'] });
  const r = await w.poll(); assert.equal(r.events.length, 1);
  const e = r.events[0]; assert.equal(e.side, 'sell'); assert.equal(e.tokenAmount, 600n); assert.equal(e.quoteAmount, 900_000_000n); assert.equal(e.leaderBalanceBefore, 1000n); assert.equal(e.leaderBalanceAfter, 400n);
  assert.equal((await w.poll()).events.length, 0);
});

test('leader watcher: wrapped SOL is the same quote as native SOL; a stablecoin leg counts as quote when configured', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  net.add([LEADER], { transaction: { message: { accountKeys: [LEADER, OTHER], instructions: [] } }, meta: { err: null, fee: 5000, preBalances: [10_000_000_000, 1], postBalances: [9_999_995_000 - 2_039_280, 1],
    preTokenBalances: [tb(1, WSOL, LEADER, 2_000_000_000n)], postTokenBalances: [tb(2, TOK, LEADER, 77n), tb(1, WSOL, LEADER, 0n)] } });
  net.add([LEADER], { transaction: { message: { accountKeys: [LEADER, OTHER], instructions: [] } }, meta: { err: null, fee: 5000, preBalances: [10_000_000_000, 1], postBalances: [9_999_995_000 - 2_039_280, 1],
    preTokenBalances: [tb(1, USDC, LEADER, 50_000_000n)], postTokenBalances: [tb(2, TOK2, LEADER, 10n), tb(1, USDC, LEADER, 0n)] } });
  const ev = (await w.poll()).events;
  assert.equal(ev.length, 2); assert.equal(ev[0].quoteAmount, 2_000_000_000n); assert.equal(ev[0].side, 'buy');
  assert.equal(ev[1].token, TOK2); assert.equal(ev[1].quoteAmount, 50_000_000n);
});

test('leader watcher: two unrelated tokens moving is a transfer, not a swap (the copy rules ignore it)', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  net.add([LEADER], { transaction: { message: { accountKeys: [LEADER, OTHER], instructions: [] } }, meta: { err: null, fee: 5000, preBalances: [10_000_000_000, 1], postBalances: [9_999_995_000, 1],
    preTokenBalances: [tb(1, TOK, LEADER, 10n)], postTokenBalances: [tb(1, TOK, LEADER, 0n), tb(2, TOK2, LEADER, 3n)] } });
  const [e] = (await w.poll()).events; assert.equal(e.kind, 'transfer');
});

test('leader watcher: an event waits for its confirmations; a transaction that disappears afterwards is reported as reorged', async () => {
  const net = new Net(); const w = mkWatch(net, { conf: 30 }); await w.poll();
  const sig = net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n }));
  assert.equal((await w.poll()).events.length, 0);                                   // held: only ~6 slots deep
  net.head += 40; const r = await w.poll(); assert.equal(r.events.length, 1); assert.ok(r.events[0].confirmations >= 30);
  net.gone.add(sig); const r2 = await w.poll(); assert.deepEqual(r2.reorged, [{ chain: 'sol', txHash: sig }]);
});

test('leader watcher: a transaction dropped before release is silently discarded (nothing was acted on)', async () => {
  const net = new Net(); const w = mkWatch(net, { conf: 30 }); await w.poll();
  const sig = net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n }));
  await w.poll(); net.gone.add(sig); net.head += 40; const r = await w.poll(); assert.equal(r.events.length, 0); assert.equal(r.reorged.length, 0);
});

test('leader watcher: a node error loses no progress and the same signature is retried; state survives snapshot/load', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  const sig = net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n })); net.missingTx.add(sig);
  await assert.rejects(w.poll(), /not available/);
  net.missingTx.clear(); const w2 = mkWatch(net); w2.load(JSON.parse(JSON.stringify(w.snapshot())));
  const r = await w2.poll(); assert.equal(r.events.length, 1); assert.equal(r.events[0].txHash, sig);
  assert.equal((await w2.poll()).events.length, 0);                                  // exactly once
});

test('leader watcher: more than one page of new signatures is read in order', async () => {
  const net = new Net(); const w = mkWatch(net); await w.poll();
  for (let i = 0; i < 130; i++) net.add([LEADER], swapTx({ lamports: -1_000n, post: BigInt(i + 1) }));
  net.head += 200; const r = await w.poll(); assert.equal(r.events.length, 130); assert.equal(r.events[0].txHash, 'sig1'); assert.equal(r.events[129].txHash, 'sig130');
});

// ---------------------------------------------------------------- launch source
const poolData = (base: string, quote: string) => { const b = Buffer.alloc(AMM_V4_LAYOUT.size); b.writeBigUInt64LE(6n, AMM_V4_LAYOUT.status); b.writeBigUInt64LE(25n, AMM_V4_LAYOUT.swapFeeNumerator); b.writeBigUInt64LE(10000n, AMM_V4_LAYOUT.swapFeeDenominator);
  Buffer.from(b58decode(addr())).copy(b, AMM_V4_LAYOUT.baseVault); Buffer.from(b58decode(addr())).copy(b, AMM_V4_LAYOUT.quoteVault);
  Buffer.from(b58decode(base)).copy(b, AMM_V4_LAYOUT.baseMint); Buffer.from(b58decode(quote)).copy(b, AMM_V4_LAYOUT.quoteMint); return b; };
const acct = (data: Buffer, owner = PROGRAM) => ({ owner, lamports: 1, data: [data.toString('base64'), 'base64'] });
function initTx(net: Net, pool: string, tag = 1) {
  return net.add([PROGRAM], { transaction: { message: { accountKeys: [LEADER, pool, PROGRAM], instructions: [{ programIdIndex: 2, accounts: [1], data: base58(new Uint8Array([tag, 254, 1, 2])) }] } },
    meta: { err: null, fee: 5000, preBalances: [10 ** 10, 0, 1], postBalances: [10 ** 10 - 5000, 7_000_000, 1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [] } });
}
const mkSrc = (net: Net) => new RaydiumLaunchSource({ chain: 'sol', program: PROGRAM, wsol: WSOL, quoteMints: [] }, net);

test('launch source: a pool created in a transaction is found from the pool ACCOUNT (owner, size, mints), not from instruction layout', async () => {
  const net = new Net(); const src = mkSrc(net); await src.poll();
  const pool = addr(); net.accounts.set(pool, acct(poolData(TOK, WSOL))); const sig = initTx(net, pool);
  const r = await src.poll(); assert.equal(r.events.length, 1);
  const e = r.events[0]; assert.equal(e.type, 'pool-created'); assert.equal(e.token, TOK); assert.equal(e.venueId, pool); assert.equal(e.txHash, sig); assert.equal(e.quoteLiquidity, 5_000_000_000n);
  assert.deepEqual(src.pairs.get(TOK), { pair: pool, program: PROGRAM });
  assert.equal((await src.poll()).events.length, 0);
});

test('launch source: base/quote order does not matter; token/token, wrong owner, wrong size and non-initialize transactions are ignored; history is never replayed', async () => {
  const net = new Net(); const old = addr(); net.accounts.set(old, acct(poolData(TOK2, WSOL))); initTx(net, old);
  const src = mkSrc(net); assert.equal((await src.poll()).events.length, 0);        // pool existed before we started
  const a = addr(), b = addr(), c = addr(), d = addr(), f = addr();
  net.accounts.set(a, acct(poolData(WSOL, TOK))); net.accounts.set(b, acct(poolData(TOK, TOK2))); net.accounts.set(c, acct(poolData(TOK, WSOL), OTHER)); net.accounts.set(d, acct(Buffer.alloc(100))); net.accounts.set(f, acct(poolData(TOK, WSOL)));
  initTx(net, a); initTx(net, b); initTx(net, c); initTx(net, d); initTx(net, f, 9);
  const ev = (await src.poll()).events; assert.equal(ev.length, 1); assert.equal(ev[0].venueId, a); assert.equal(ev[0].token, TOK);
  assert.ok(src.ignored.some(x => x.startsWith(b)));
});

test('launch source: an account that already existed before the transaction is not a new pool; a vanished creation tx is revoked; a full page reports the gap', async () => {
  const net = new Net(); const src = mkSrc(net); await src.poll();
  const pool = addr(); net.accounts.set(pool, acct(poolData(TOK, WSOL)));
  const sig = net.add([PROGRAM], { transaction: { message: { accountKeys: [LEADER, pool, PROGRAM], instructions: [{ programIdIndex: 2, accounts: [1], data: base58(new Uint8Array([1])) }] } },
    meta: { err: null, fee: 5000, preBalances: [10 ** 10, 7_000_000, 1], postBalances: [10 ** 10 - 5000, 7_000_000, 1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [] } });
  assert.equal((await src.poll()).events.length, 0);
  const fresh = addr(); net.accounts.set(fresh, acct(poolData(TOK2, WSOL))); const sig2 = initTx(net, fresh);
  assert.equal((await src.poll()).events.length, 1); net.gone.add(sig2);
  assert.deepEqual((await src.poll()).reorged, [{ chain: 'sol', txHash: sig2 }]); void sig;
  const small = new RaydiumLaunchSource({ chain: 'sol', program: PROGRAM, wsol: WSOL, quoteMints: [], pageLimit: 3 }, net); await small.poll();
  for (let i = 0; i < 4; i++) net.add([PROGRAM], { transaction: { message: { accountKeys: [LEADER, PROGRAM], instructions: [] } }, meta: { err: null, fee: 5, preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [], postTokenBalances: [] } });
  await small.poll(); assert.ok(small.missed >= 3, 'a page filled before reaching the cursor must be visible');
});

test('SolanaChain.addPool accepts what SnipeRunner passes ({ id, pair }) and uses the configured program', () => {
  const c = new SolanaChain({ id: 'sol', wsol: WSOL, pools: [{ id: addr(), program: PROGRAM }] }, new Net(), sg);
  const id = addr(); c.addPool({ id, pair: id } as any); c.addPool({ id, pair: id } as any); assert.equal((c as any).cfg.pools.filter((p: any) => p.id === id).length, 1); assert.equal((c as any).cfg.pools.at(-1).program, PROGRAM);
  assert.throws(() => new SolanaChain({ id: 'sol', wsol: WSOL, pools: [] }, new Net(), sg).addPool({ id } as any), /no Raydium program/);
  void NATIVE;
});

// ---------------------------------------------------------------- mint risk
const mintData = (o: { mintAuth?: string; freeze?: string; supply?: bigint; init?: boolean } = {}) => { const b = Buffer.alloc(82);
  if (o.mintAuth) { b.writeUInt32LE(1, 0); Buffer.from(b58decode(o.mintAuth)).copy(b, 4); } b.writeBigUInt64LE(o.supply ?? 1_000_000n, 36); b[44] = 6; b[45] = o.init === false ? 0 : 1;
  if (o.freeze) { b.writeUInt32LE(1, 46); Buffer.from(b58decode(o.freeze)).copy(b, 50); } return b; };
const inspectWith = async (acc: any) => { const net = { call: async () => ({ value: acc }) }; const m = new MintInspector(net as any, () => 1); await m.inspect(TOK); return m; };
const A = (d: Buffer, owner = PROGRAMS.token) => ({ owner, data: [d.toString('base64'), 'base64'] });

test('mint risk: revoked authorities are only a warning (what we did not check is listed); a freeze authority blocks; a mint authority warns; Token-2022 is quarantined; un-inspected is quarantined', async () => {
  const clean = (await inspectWith(A(mintData()))).riskCheck({ token: TOK }, 1);
  assert.equal(clean.verdict, 'warn'); assert.ok(clean.notes.some(n => /both revoked/.test(n))); assert.ok(clean.flags.some(f => /not simulated/.test(f)));
  const fr = (await inspectWith(A(mintData({ freeze: OTHER })))).riskCheck({ token: TOK }, 1); assert.equal(fr.verdict, 'blocked'); assert.ok(fr.flags[0].includes(OTHER));
  const mt = (await inspectWith(A(mintData({ mintAuth: OTHER })))).riskCheck({ token: TOK }, 1); assert.equal(mt.verdict, 'warn'); assert.ok(mt.flags.some(f => /mint authority/.test(f)));
  const both = (await inspectWith(A(mintData({ mintAuth: OTHER, freeze: OTHER })))).riskCheck({ token: TOK }, 1); assert.equal(both.verdict, 'blocked');
  const t22 = (await inspectWith(A(Buffer.concat([mintData(), Buffer.alloc(40)]), addr()))).riskCheck({ token: TOK }, 1); assert.equal(t22.verdict, 'quarantined');
  assert.equal(new MintInspector({ call: async () => ({}) } as any).riskCheck({ token: TOK }, 1).verdict, 'quarantined');
});

test('mint risk: a missing, wrong-sized or uninitialised mint is refused rather than guessed', async () => {
  await assert.rejects(new MintInspector({ call: async () => ({ value: null }) } as any).inspect(TOK), /does not exist/);
  assert.throws(() => decodeMint(PROGRAMS.token, Buffer.alloc(40), TOK), /expected 82/);
  assert.throws(() => decodeMint(PROGRAMS.token, mintData({ init: false }), TOK), /not initialized/);
});

test('leader watcher history(): newest first, pure read (no cursor/known/holding change), failed and unservable transactions skipped, limit respected', async () => {
  const net = new Net(); const w = mkWatch(net);
  const a = net.add([LEADER], swapTx({ lamports: -1_000_000_000n, post: 1000n })), b = net.add([LEADER], swapTx({ lamports: 900_000_000n, pre: 1000n, post: 400n }));
  net.add([LEADER], swapTx({ lamports: 0n, fail: true, post: 5n }), { InstructionError: [0, 'x'] });
  const c = net.add([LEADER], swapTx({ lamports: -2_000_000_000n, post: 500n })); net.missingTx.add(c);
  const before = JSON.stringify(w.snapshot());
  const ev = await w.history(LEADER, 10);
  assert.deepEqual(ev.map(e => e.txHash), [b, a], 'newest first; the failed tx and the unservable tx produce nothing');
  assert.equal(ev[0].side, 'sell'); assert.equal(ev[1].side, 'buy'); assert.ok(!('slot' in ev[0]));
  assert.equal(JSON.stringify(w.snapshot()), before, 'cursors, known, holding, tracked untouched'); assert.ok(w.skipped.some(x => x.startsWith(c)));
  const one = await w.history(LEADER, 1); assert.equal(one.length, 0, 'limit counts signatures examined: the newest successful one (c) is unservable');
  net.missingTx.clear(); assert.deepEqual((await w.history(LEADER, 2)).map(e => e.txHash), [c, b]);
  assert.equal((await mkWatch(net).poll()).events.length, 0, 'a fresh watcher still starts from now afterwards');
});
