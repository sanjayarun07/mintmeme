import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWalletTrades, validAddress, MAX_TRADES } from '../src/wallettrades.ts';
import { ETH, SOL_POOL } from '../src/config.ts';
import { DevSolSigner } from '../../sol/src/index.ts';

const WHO = '0x1111111111111111111111111111111111111111', TOK = '0x2222222222222222222222222222222222222222', TOK2 = '0x3333333333333333333333333333333333333333', WETH = '0x4444444444444444444444444444444444444444';
const ROUTER_OTHER = '0x5555555555555555555555555555555555555555', USDC = ETH.usdc.address.toLowerCase();
const hx = (n: bigint | number) => '0x' + BigInt(n).toString(16), pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
type T = { blockNum: string; hash: string; from: string; to: string; asset: string; category: string; rawContract: { value: string; address: string | null; decimal: string | null }; metadata: { blockTimestamp: string }; uniqueId: string };
let uid = 0;
const tr = (block: number, hash: string, from: string, to: string, kind: 'eth' | 'internal' | { token: string; sym: string; dec: number }, raw: bigint): T => ({ blockNum: hx(block), hash, from, to, asset: kind === 'eth' || kind === 'internal' ? 'ETH' : kind.sym, category: kind === 'eth' ? 'external' : kind === 'internal' ? 'internal' : 'erc20',
  rawContract: { value: hx(raw), address: typeof kind === 'object' ? kind.token : null, decimal: typeof kind === 'object' ? hx(kind.dec) : null }, metadata: { blockTimestamp: new Date(1_800_000_000_000 + block * 1000).toISOString() }, uniqueId: `u${++uid}` });
const tok = (token: string, sym = 'MEME', dec = 18) => ({ token, sym, dec });

/** scripted EVM node: transfers by direction, WETH() answer, block number, balanceOf by block */
function evmRpc(all: T[], o: { refuse?: string; refuseInternal?: boolean; balances?: (token: string, block: number) => bigint; noWeth?: boolean; head?: number } = {}) {
  const calls: any[] = [];
  return { calls, async call(method: string, params: any[] = []): Promise<any> {
    calls.push([method, params]);
    if (method === 'alchemy_getAssetTransfers') {
      const q = params[0]; if (o.refuse) throw new Error(o.refuse);
      if (o.refuseInternal && q.category.includes('internal')) throw new Error('Invalid category: internal');
      const dir = q.fromAddress ? 'from' : 'to', who = (q.fromAddress ?? q.toAddress).toLowerCase();
      const list = all.filter(t => (dir === 'from' ? t.from : t.to).toLowerCase() === who && q.category.includes(t.category)).sort((a, b) => Number(BigInt(b.blockNum) - BigInt(a.blockNum)));
      return { transfers: list.slice(0, 100) };
    }
    if (method === 'eth_call') {
      if (params[0].data === '0xad5c4648') { if (o.noWeth) throw new Error('call failed'); return pad(WETH); }
      if (!o.balances) throw new Error('missing trie node'); const blk = Number(BigInt(params[1])); return '0x' + o.balances('0x' + params[0].data.slice(34, 74), blk).toString(16).padStart(64, '0');
    }
    if (method === 'eth_blockNumber') return hx(o.head ?? 1000);
    throw new Error(`unscripted ${method}`);
  } };
}
const deps = (rpc: any, extra: any = {}) => ({ rpcFor: () => rpc, now: () => 5, ...extra });

test('EVM: a buy with native ETH, a sell paid back as an internal ETH transfer, and a plain transfer are grouped by transaction', async () => {
  const rpc = evmRpc([
    tr(900, '0xbuy', WHO, ROUTER_OTHER, 'eth', 10n ** 18n), tr(900, '0xbuy', ROUTER_OTHER, WHO, tok(TOK), 5000n * 10n ** 18n),
    tr(950, '0xsell', WHO, ROUTER_OTHER, tok(TOK), 2000n * 10n ** 18n), tr(950, '0xsell', ROUTER_OTHER, WHO, 'internal', 4n * 10n ** 17n),
    tr(980, '0xgift', ROUTER_OTHER, WHO, tok(TOK2, 'GIFT', 6), 77n),
  ], { balances: (_t, b) => (b < 900 ? 0n : b < 950 ? 5000n * 10n ** 18n : 3000n * 10n ** 18n) });
  const r = await loadWalletTrades(deps(rpc), { chain: 'ethereum', address: WHO.toUpperCase().replace('0X', '0x') });
  assert.equal(r.address, WHO); assert.deepEqual(r.events.map(e => e.txHash), ['0xgift', '0xsell', '0xbuy'], 'newest first');
  const [gift, sell, buy] = r.events;
  assert.equal(gift.kind, 'transfer'); assert.equal(gift.side, 'buy'); assert.equal(gift.token, TOK2); assert.equal(gift.quoteAmount, 0n);
  assert.equal(buy.kind, 'swap'); assert.equal(buy.side, 'buy'); assert.equal(buy.token, TOK); assert.equal(buy.quoteAmount, 10n ** 18n); assert.equal(buy.tokenAmount, 5000n * 10n ** 18n);
  assert.equal(buy.leaderPriceE18, 10n ** 18n * 10n ** 18n / (5000n * 10n ** 18n)); assert.equal(buy.provider, 'rpc'); assert.equal(buy.chain, 'ethereum'); assert.equal(buy.leader, WHO); assert.equal(buy.logIndex, 0);
  assert.equal(buy.leaderBalanceBefore, 0n); assert.equal(buy.leaderBalanceAfter, 5000n * 10n ** 18n); assert.equal(buy.confirmations, 101);
  assert.equal(sell.kind, 'swap'); assert.equal(sell.side, 'sell'); assert.equal(sell.quoteAmount, 4n * 10n ** 17n); assert.equal(sell.tokenAmount, 2000n * 10n ** 18n);
  assert.equal(sell.leaderBalanceBefore, 5000n * 10n ** 18n); assert.equal(sell.leaderBalanceAfter, 3000n * 10n ** 18n);
  assert.deepEqual(r.extras['0xbuy'], { ts: 1_800_000_900, quoteSym: 'ETH', quoteToken: 'NATIVE' }); assert.equal(r.tokens[TOK].sym, 'MEME'); assert.equal(r.tokens[TOK].decimals, 18); assert.equal(r.tokens[TOK2].decimals, 6);
  assert.ok(r.notes.some(n => /inferred from token and coin transfers/.test(n))); assert.equal(r.at, 5);
});

test('EVM: WETH and native ETH are one quote asset; USDC is a quote asset; the router WETH() is read on chain, never hard-coded', async () => {
  const rpc = evmRpc([
    tr(900, '0xw', WHO, ROUTER_OTHER, { token: WETH, sym: 'WETH', dec: 18 }, 10n ** 18n), tr(900, '0xw', ROUTER_OTHER, WHO, tok(TOK), 10n),
    tr(910, '0xu', WHO, ROUTER_OTHER, { token: USDC, sym: 'USDC', dec: 6 }, 50_000_000n), tr(910, '0xu', ROUTER_OTHER, WHO, tok(TOK), 20n),
  ], { balances: () => 0n });
  const r = await loadWalletTrades(deps(rpc), { chain: 'ethereum', address: WHO });
  assert.equal(r.events.length, 2); const [u, w] = r.events;
  assert.equal(w.kind, 'swap'); assert.equal(w.quoteAmount, 10n ** 18n); assert.equal(r.extras['0xw'].quoteSym, 'ETH'); assert.equal(r.tokens[WETH], undefined, 'wrapped native is not listed as a traded token');
  assert.equal(u.kind, 'swap'); assert.equal(u.quoteAmount, 50_000_000n); assert.deepEqual([r.extras['0xu'].quoteSym, r.extras['0xu'].quoteToken], ['USDC', USDC]);
  assert.ok(rpc.calls.some(c => c[0] === 'eth_call' && c[1][0].data === '0xad5c4648' && c[1][0].to === ETH.uniswapV2Router02.address));
});

test('EVM: two unrelated tokens in one transaction is a transfer, not a swap; a pure ETH movement is not a token trade at all', async () => {
  const rpc = evmRpc([
    tr(900, '0xtwo', WHO, ROUTER_OTHER, tok(TOK), 5n), tr(900, '0xtwo', ROUTER_OTHER, WHO, tok(TOK2, 'B', 6), 9n),
    tr(910, '0xeth', WHO, ROUTER_OTHER, 'eth', 10n ** 17n),
    tr(920, '0xnoquote', WHO, ROUTER_OTHER, tok(TOK), 5n),
  ], { balances: () => 0n });
  const r = await loadWalletTrades(deps(rpc), { chain: 'ethereum', address: WHO });
  assert.deepEqual(r.events.map(e => [e.txHash, e.kind]), [['0xnoquote', 'transfer'], ['0xtwo', 'transfer']]); assert.equal(r.events[0].side, 'sell');
});

test('EVM: several wallet transactions in one block, or a node without old state, give balance 0 and an explicit note; swaps are never dropped', async () => {
  const two = [tr(900, '0xa', WHO, ROUTER_OTHER, 'eth', 1n), tr(900, '0xa', ROUTER_OTHER, WHO, tok(TOK), 10n), tr(900, '0xb', WHO, ROUTER_OTHER, 'eth', 1n), tr(900, '0xb', ROUTER_OTHER, WHO, tok(TOK), 10n)];
  const a = await loadWalletTrades(deps(evmRpc(two, { balances: () => 99n })), { chain: 'ethereum', address: WHO });
  assert.equal(a.events.length, 2); assert.ok(a.events.every(e => e.kind === 'swap' && e.leaderBalanceBefore === 0n && e.leaderBalanceAfter === 0n)); assert.ok(a.notes.some(n => /share a block/.test(n)));
  const b = await loadWalletTrades(deps(evmRpc(two.slice(0, 2))), { chain: 'ethereum', address: WHO });                                      // eth_call for balances fails
  assert.equal(b.events[0].kind, 'swap'); assert.equal(b.events[0].leaderBalanceAfter, 0n); assert.ok(b.notes.some(n => /could not serve balances/.test(n) && /cannot be sized|share of the position/.test(n)));
});

test('EVM: a node that refuses alchemy_getAssetTransfers (public BSC node) returns no events and a clear note instead of throwing', async () => {
  const r = await loadWalletTrades(deps(evmRpc([], { refuse: 'method alchemy_getAssetTransfers is not supported' })), { chain: 'bnb', address: WHO });
  assert.deepEqual(r.events, []); assert.ok(r.notes.some(n => /trade history is not available from this node/.test(n) && /alchemy_getAssetTransfers/.test(n)));
  const allowlist = await loadWalletTrades({ rpcFor: () => ({ call: async (m: string) => { throw new Error(`method ${m} is not on the read-only allowlist`); } }) }, { chain: 'bnb', address: WHO });
  assert.deepEqual(allowlist.events, []);
});

test('EVM: when a node lacks the internal category the request is retried without it, with a note', async () => {
  const rpc = evmRpc([tr(900, '0xb', WHO, ROUTER_OTHER, 'eth', 1n), tr(900, '0xb', ROUTER_OTHER, WHO, tok(TOK), 10n)], { refuseInternal: true, balances: () => 0n });
  const r = await loadWalletTrades(deps(rpc), { chain: 'bnb', address: WHO });
  assert.equal(r.events.length, 1); assert.equal(r.extras['0xb'].quoteSym, 'BNB'); assert.ok(r.notes.some(n => /internal transfers/.test(n)));
  assert.ok(rpc.calls.filter(c => c[0] === 'alchemy_getAssetTransfers').some(c => !c[1][0].category.includes('internal')));
});

test('limit: default 20, clamped to 1..50; invalid addresses are refused before any call', async () => {
  const many: T[] = []; for (let i = 0; i < 60; i++) { many.push(tr(100 + i, `0x${i}`, WHO, ROUTER_OTHER, 'eth', 1n), tr(100 + i, `0x${i}`, ROUTER_OTHER, WHO, tok(TOK), 10n)); }
  const r0 = evmRpc(many, { balances: () => 0n }), def = await loadWalletTrades(deps(r0), { chain: 'ethereum', address: WHO }); assert.equal(def.events.length, 20); assert.equal(def.events[0].txHash, '0x59');
  assert.equal((await loadWalletTrades(deps(evmRpc(many, { balances: () => 0n })), { chain: 'ethereum', address: WHO, limit: 500 })).events.length, MAX_TRADES);
  assert.equal((await loadWalletTrades(deps(evmRpc(many, { balances: () => 0n })), { chain: 'ethereum', address: WHO, limit: 0 })).events.length, 1);
  const rpc = evmRpc([]); await assert.rejects(loadWalletTrades(deps(rpc), { chain: 'ethereum', address: '0x12' }), /not a valid ethereum address/); await assert.rejects(loadWalletTrades(deps(rpc), { chain: 'solana', address: WHO }), /not a valid solana address/); assert.equal(rpc.calls.length, 0);
  assert.ok(validAddress('solana', new DevSolSigner().add()) && !validAddress('solana', 'abc'));
});

test('EVM: a full page of 100 transfers in a direction drops the oldest block so no trade is shown half-read, and says so', async () => {
  const many: T[] = []; for (let i = 0; i < 100; i++) many.push(tr(100 + i, `0x${i}`, WHO, ROUTER_OTHER, tok(TOK), 1n));         // 100 sends, one per block => the "from" page is full
  many.push(tr(100, '0x0', ROUTER_OTHER, WHO, 'eth', 1n));
  const r = await loadWalletTrades(deps(evmRpc(many, { balances: () => 0n })), { chain: 'ethereum', address: WHO, limit: 50 });
  assert.ok(!r.events.some(e => e.txHash === '0x0')); assert.ok(r.notes.some(n => /more than 100 transfers/.test(n)));
});

// ---------------------------------------------------------------- Solana
const sg = new DevSolSigner(), SW = sg.add(), SOTHER = sg.add(), SMINT = sg.add(), SWSOL = SOL_POOL.wsol.mint;
const stx = (sig: string, slot: number, lamports: bigint, post: bigint, fail = false) => ({ sig, slot, tx: { slot, transaction: { message: { accountKeys: [SW, SOTHER], instructions: [] } },
  meta: { err: fail ? { x: 1 } : null, fee: 5000, preBalances: [10 ** 10, 1], postBalances: [Number(10n ** 10n + lamports - 5000n - 2_039_280n), 1], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: SMINT, owner: SW, uiTokenAmount: { amount: post.toString() } }] } } });
function solRpc(list: ReturnType<typeof stx>[]) {
  const calls: string[] = [];
  return { calls, async call(m: string, p: any[] = []): Promise<any> {
    calls.push(m);
    if (m === 'getSlot') return 500; if (m === 'getMinimumBalanceForRentExemption') return 2_039_280; if (m === 'getBlockTime') return 1_800_000_000 + p[0];
    if (m === 'getSignaturesForAddress') return [...list].reverse().map(t => ({ signature: t.sig, slot: t.slot, err: t.tx.meta.err }));
    if (m === 'getTransaction') return list.find(t => t.sig === p[0])!.tx;
    throw new Error(`unscripted ${m}`);
  } };
}

test('Solana: recent swaps come from the wallet\'s own balance changes, newest first, with block times and the quote asset; nothing outside the allowlisted reads is called', async () => {
  const rpc = solRpc([stx('s1', 100, -1_000_000_000n, 1000n), stx('s2', 110, -2_000_000_000n, 2500n), stx('s3', 120, 0n, 9n, true)]);
  const r = await loadWalletTrades(deps(rpc), { chain: 'solana', address: SW });
  assert.deepEqual(r.events.map(e => e.txHash), ['s2', 's1']); assert.equal(r.events[0].kind, 'swap'); assert.equal(r.events[0].side, 'buy'); assert.equal(r.events[0].quoteAmount, 2_000_000_000n); assert.equal(r.events[0].token, SMINT);
  assert.deepEqual(r.extras.s2, { quoteSym: 'SOL', quoteToken: 'NATIVE', ts: 1_800_000_110 }); assert.ok(r.tokens[SMINT]); assert.ok(r.notes.some(n => /latest 3 transactions of this wallet: 1 failed on chain \(skipped\), 2 succeeded, 2 moved a token and are listed/.test(n)));
  assert.ok(rpc.calls.every(m => ['getSlot', 'getSignaturesForAddress', 'getTransaction', 'getMinimumBalanceForRentExemption', 'getBlockTime'].includes(m)));
});

test('Solana: a wallet whose recent transactions all failed says so plainly instead of showing an unexplained empty list', async () => {
  const rpc = solRpc([stx('f1', 100, 0n, 0n, true), stx('f2', 101, 0n, 0n, true), stx('f3', 102, 0n, 0n, true)]);
  const r = await loadWalletTrades(deps(rpc), { chain: 'solana', address: SW });
  assert.equal(r.events.length, 0); assert.ok(r.notes.some(n => /3 failed on chain \(skipped\), 0 succeeded, 0 moved a token/.test(n))); assert.ok(r.notes.some(n => /Every recent transaction of this wallet failed on chain.*trading bot/.test(n)));
});

test('Solana: token names come from DexScreener when a fetch is supplied; a failure only adds a note', async () => {
  const rpc = solRpc([stx('s1', 100, -1_000_000_000n, 1000n)]);
  const ok = await loadWalletTrades(deps(rpc, { fetchFn: async (u: string) => { assert.ok(u.includes(`/solana/${SMINT}`)); return { ok: true, json: async () => [{ baseToken: { address: SMINT, symbol: 'MEME', name: 'Meme Coin' } }] } as any; } }), { chain: 'solana', address: SW });
  assert.deepEqual(ok.tokens[SMINT], { sym: 'MEME', name: 'Meme Coin' });
  const bad = await loadWalletTrades(deps(solRpc([stx('s1', 100, -1_000_000_000n, 1000n)]), { fetchFn: async () => ({ ok: false, status: 429 }) as any }), { chain: 'solana', address: SW });
  assert.equal(bad.events.length, 1); assert.ok(bad.notes.some(n => /token names unavailable/.test(n)));
});
