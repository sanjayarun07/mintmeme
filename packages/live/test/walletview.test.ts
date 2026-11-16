import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWalletView, validateAddress } from '../src/walletview.ts';
import type { RpcLike } from '../src/walletview.ts';
import { SOL_POOL } from '../src/config.ts';

// MOCK node and market data: these tests check this module's logic only. The real result is the live read-only check.
const ADDR = '0x' + 'ab'.repeat(20), WETH = '0x' + 'c0'.repeat(20), T1 = '0x' + '11'.repeat(20), T2 = '0x' + '22'.repeat(20), T3 = '0x' + '33'.repeat(20);
const rpcOf = (h: Record<string, (p: any[]) => any>): RpcLike & { calls: string[] } => ({ calls: [] as string[], async call(m: string, p: any[] = []) { (this as any).calls.push(m); const f = h[m]; if (!f) throw new Error(`method ${m} not allowed`); return f(p); } }) as any;
const pair = (addr: string, price: number, liq: number, sym = 'T', name = 'Token') => ({ baseToken: { address: addr, symbol: sym, name }, priceUsd: String(price), liquidity: { usd: liq } });
const fetchOf = (pairs: any[], urls: string[] = []): typeof fetch => (async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => pairs } as any; }) as any;
const hex = (n: bigint) => '0x' + n.toString(16);
const evmRpc = (o: { alchemy?: boolean } = {}) => rpcOf({
  eth_getBalance: () => hex(2n * 10n ** 18n), eth_call: () => '0x' + '0'.repeat(24) + 'c0'.repeat(20),
  ...(o.alchemy === false ? {} : {
    alchemy_getTokenBalances: () => ({ tokenBalances: [{ contractAddress: T1, tokenBalance: hex(1500n * 10n ** 6n) }, { contractAddress: T2, tokenBalance: hex(0n) }, { contractAddress: T3, tokenBalance: hex(7n * 10n ** 18n) }, { contractAddress: '0x' + '44'.repeat(20), tokenBalance: '0x', error: 'x' }] }),
    alchemy_getTokenMetadata: (p: any[]) => (p[0] === T1 ? { decimals: 6, symbol: 'USDX', name: 'Dollar X' } : { decimals: 18, symbol: 'MEMEZ', name: 'Meme Z' }) }) });

test('address validation: strict per chain, with clear messages', () => {
  assert.equal(validateAddress('ethereum', '0xAB' + 'ab'.repeat(19)), '0xab' + 'ab'.repeat(19));
  for (const bad of ['', '0x123', ADDR + '00', 'ab'.repeat(20), '0x' + 'zz'.repeat(20)]) assert.throws(() => validateAddress('bnb', bad), /not a valid EVM address/);
  assert.equal(validateAddress('solana', SOL_POOL.wsol.mint), SOL_POOL.wsol.mint);
  for (const bad of ['', 'abc', '0x' + 'ab'.repeat(20), 'O'.repeat(44), '1'.repeat(30)]) assert.throws(() => validateAddress('solana', bad), /not a valid Solana address/);
  assert.throws(() => validateAddress('base' as any, ADDR), /unsupported chain/);
});

test('EVM: ordering is by USD descending and the numbers are exact', async () => {
  const v = await loadWalletView({ rpcFor: () => evmRpc(), fetchFn: fetchOf([pair(WETH, 3000, 9e9), pair(T1, 1.0, 5e6, 'USDX'), pair(T3, 10, 2e5, 'MEMEZ'), pair(T3, 99, 10, 'FAKE')]) }, { chain: 'ethereum', address: ADDR });
  assert.deepEqual(v.tokens.map(t => [t.contract, t.sym, t.name, t.decimals, t.amount, t.price, t.usd, t.source]), [
    [T1, 'USDX', 'Dollar X', 6, '1500000000', 1, 1500, 'dexscreener'], [T3, 'MEMEZ', 'Meme Z', 18, (7n * 10n ** 18n).toString(), 10, 70, 'dexscreener']]);
  assert.equal(v.totalUsd, 6000 + 1500 + 70); assert.ok(v.notes.some(n => /DexScreener.*third-party/.test(n)));
});

test('prices are fetched in batches of at most 30 addresses and only the base-token pairs count', async () => {
  const many = Array.from({ length: 70 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0')), urls: string[] = [];
  const rpc = rpcOf({ eth_getBalance: () => '0x0', eth_call: () => '0x' + '0'.repeat(24) + 'c0'.repeat(20), alchemy_getTokenBalances: () => ({ tokenBalances: many.map(a => ({ contractAddress: a, tokenBalance: hex(10n ** 18n) })) }), alchemy_getTokenMetadata: () => ({ decimals: 18, symbol: 'X', name: 'X' }) });
  await loadWalletView({ rpcFor: () => rpc, fetchFn: fetchOf([], urls) }, { chain: 'ethereum', address: ADDR });
  assert.equal(urls.length, 3); for (const u of urls) assert.ok(u.split('/').pop()!.split(',').length <= 30); assert.ok(urls.every(u => u.startsWith('https://api.dexscreener.com/tokens/v1/ethereum/')));
});

test('Alchemy refusal (public BNB endpoint): native only, a note says why, the call does not fail', async () => {
  const v = await loadWalletView({ rpcFor: () => evmRpc({ alchemy: false }), fetchFn: fetchOf([pair(WETH, 600, 1e9)]) }, { chain: 'bnb', address: ADDR });
  assert.deepEqual(v.tokens, []); assert.equal(v.native.sym, 'BNB'); assert.equal(v.native.usd, 1200); assert.equal(v.totalUsd, 1200); assert.ok(v.notes.some(n => /Alchemy-enabled node/.test(n)));
});

test('missing price stays undefined (never 0); totalUsd counts only priced items and a note says how many are unpriced', async () => {
  const v = await loadWalletView({ rpcFor: () => evmRpc(), fetchFn: fetchOf([pair(WETH, 3000, 9e9), pair(T1, 1.0, 5e6, 'USDX')]) }, { chain: 'ethereum', address: ADDR });
  const t3 = v.tokens.find(t => t.contract === T3)!; assert.equal(t3.price, undefined); assert.equal(t3.usd, undefined); assert.equal(t3.source, 'none'); assert.equal('price' in t3, false);
  assert.equal(v.totalUsd, 6000 + 1500); assert.ok(v.notes.some(n => /1 holding has no market price and is not counted/.test(n)));
  assert.equal(v.tokens.at(-1)!.contract, T3, 'unpriced rows sort last');
});

test('no native price and a failing price service: balances still returned, no total invented', async () => {
  const bad: typeof fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
  const v = await loadWalletView({ rpcFor: () => evmRpc(), fetchFn: bad }, { chain: 'ethereum', address: ADDR });
  assert.equal(v.native.usd, undefined); assert.equal(v.totalUsd, undefined); assert.ok(v.notes.some(n => /price is not available/.test(n)) && v.notes.some(n => /price lookups failed/.test(n)));
  assert.equal(v.tokens.length, 2); assert.ok(v.tokens.every(t => t.usd === undefined));
});

const MINT_A = SOL_POOL.usdc.mint, MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', OWNER = SOL_POOL.wsol.mint;
const acct = (mint: string, amount: string, decimals: number) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });
test('Solana: SOL + token accounts merged per mint, zero balances dropped, Token-2022 gap noted, prices from DexScreener', async () => {
  const rpc = rpcOf({ getBalance: () => ({ value: 3_000_000_000 }), getTokenAccountsByOwner: () => ({ value: [acct(MINT_A, '1000000', 6), acct(MINT_A, '2500000', 6), acct(MINT_B, '0', 6), acct(MINT_B, '0', 6)] }) });
  const v = await loadWalletView({ rpcFor: () => rpc, fetchFn: fetchOf([pair(SOL_POOL.wsol.mint, 200, 9e9), pair(MINT_A, 1.001, 8e6, 'USDC', 'USD Coin')]) }, { chain: 'solana', address: OWNER });
  assert.deepEqual(v.native, { sym: 'SOL', amount: '3000000000', decimals: 9, usd: 600 }); assert.equal(v.tokens.length, 1);
  assert.deepEqual(v.tokens[0], { contract: MINT_A, sym: 'USDC', name: 'USD Coin', decimals: 6, amount: '3500000', price: 1.001, usd: 3.5035, source: 'dexscreener' });
  assert.equal(v.totalUsd, 603.5035); assert.ok(v.notes.some(n => /Token-2022/.test(n)));
  assert.deepEqual((rpc as any).calls.filter((m: string) => m === 'getTokenAccountsByOwner'), ['getTokenAccountsByOwner']);
});

test('Solana: an unpriced token still appears with a shortened mint as its symbol and decimals from the chain', async () => {
  const rpc = rpcOf({ getBalance: () => ({ value: 1 }), getTokenAccountsByOwner: () => ({ value: [acct(MINT_B, '42', 3)] }) });
  const v = await loadWalletView({ rpcFor: () => rpc, fetchFn: fetchOf([]) }, { chain: 'solana', address: OWNER });
  assert.equal(v.tokens[0].sym, MINT_B.slice(0, 4) + '…' + MINT_B.slice(-4)); assert.equal(v.tokens[0].decimals, 3); assert.equal(v.tokens[0].usd, undefined); assert.equal(v.totalUsd, undefined);
});

test('an invalid address is refused before any node call', async () => {
  const rpc = rpcOf({}); await assert.rejects(loadWalletView({ rpcFor: () => rpc }, { chain: 'solana', address: 'nope' }), /not a valid Solana address/); assert.deepEqual((rpc as any).calls, []);
});

test('Solana: a node error while listing token accounts (for example a wallet with millions of them) keeps the SOL balance and says why', async () => {
  const rpc = rpcOf({ getBalance: () => ({ value: 5_000_000_000 }), getTokenAccountsByOwner: () => { throw new Error('Cannot create a string longer than 0x1fffffe8 characters'); } });
  const v = await loadWalletView({ rpcFor: () => rpc, fetchFn: fetchOf([pair(SOL_POOL.wsol.mint, 100, 9e9)]) }, { chain: 'solana', address: OWNER });
  assert.deepEqual(v.tokens, []); assert.equal(v.native.usd, 500); assert.ok(v.notes.some(n => /Token accounts could not be read/.test(n)));
});
