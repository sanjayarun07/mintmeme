/** Tokenized stocks on the server's real Solana accounts, offline: the RPC and Jupiter are stand-ins (a stubbed global fetch), Privy is the stand-in from packages/sol/test.
 *  Covers ticker lookup, the operator switch, the fill-price check against the share price, per-share amounts and prices, the issuer pause, and GET /v1/stocks/:symbol.
 *  `prepare` only builds and checks the request body: nothing is signed or sent here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DevSolSigner } from '../../packages/sol/src/signer.ts';
import { XSTOCKS_KEYS, JupiterStockPrices } from '../../packages/sol/src/index.ts';
import { fakePrivy } from '../../packages/sol/test/fakeprivy.ts';
import { solanaAccounts, linkRoutes } from './solaccount.ts';

const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', WSOL = 'So11111111111111111111111111111111111111112', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const mem = () => { const m = new Map<string, string>(); return (n: string) => ({ read: () => m.get(n), write: (d: string) => { m.set(n, d); }, describe: () => n }); };

/** The world: SOL at $100, TSLA at $400 a share. `perSol` raw TSLAx (8 decimals) per 1 SOL: 25_000_000 is the fair 0.25 share. */
function world(o: { perSol?: bigint; multiplier?: string; paused?: boolean; held?: bigint; stockPrice?: number | null } = {}) {
  const mint = { owner: T22, lamports: 1, data: { program: 'spl-token-2022', parsed: { type: 'mint', info: { decimals: 8, supply: '1000000000000', mintAuthority: 'MintAuth111', freezeAuthority: XSTOCKS_KEYS.freezeAuthority, isInitialized: true, extensions: [
    { extension: 'permanentDelegate', state: { delegate: XSTOCKS_KEYS.permanentDelegate } }, { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
    { extension: 'scaledUiAmountConfig', state: { multiplier: o.multiplier ?? '1', newMultiplier: o.multiplier ?? '1', newMultiplierEffectiveTimestamp: 0 } },
    { extension: 'pausableConfig', state: { authority: XSTOCKS_KEYS.pauseAuthority, paused: o.paused ?? false } }, { extension: 'transferHook', state: { programId: null } }, { extension: 'tokenMetadata', state: { symbol: 'TSLAx' } }] } } } };
  const perSol = o.perSol ?? 25_000_000n;
  const rpc = (m: string, p: any[]): any => {
    if (m === 'getSlot') return 100; if (m === 'getBlockTime') return Math.floor(Date.now() / 1000);
    if (m === 'getAccountInfo') return { value: p[0] === TSLAX ? mint : null };
    if (m === 'getMultipleAccounts') return { value: (p[0] as string[]).map(a => (a === TSLAX ? mint : null)) };
    if (m === 'getTokenLargestAccounts') return { value: [{ address: 'H1', amount: '10000000000' }, { address: 'H2', amount: '5000000000' }] };
    if (m === 'getTokenAccountsByOwner') return { value: o.held ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(o.held) } } } } } }] : [] };
    throw new Error(`unscripted ${m}`);
  };
  const quote = (u: URL) => { const i = u.searchParams.get('inputMint')!, out = u.searchParams.get('outputMint')!, amt = BigInt(u.searchParams.get('amount')!);
    const outAmount = i === WSOL ? amt * perSol / 1_000_000_000n : amt * 1_000_000_000n / perSol;
    return { inputMint: i, outputMint: out, inAmount: String(amt), outAmount: String(outAmount), otherAmountThreshold: String(outAmount * 99n / 100n), swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', contextSlot: 100, routePlan: [] }; };
  const fetchFn = (async (url: any, init?: any) => { const u = new URL(String(url));
    if (u.pathname.endsWith('/quote')) return new Response(JSON.stringify(quote(u)), { status: 200 });
    if (init?.method === 'POST') { const b = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: rpc(b.method, b.params ?? []) }), { status: 200 }); }
    throw new Error(`unscripted fetch ${u}`); }) as typeof fetch;
  const prices = new JupiterStockPrices({ fetchFn: (async () => new Response(JSON.stringify(o.stockPrice === null ? {} : { [TSLAX]: { usdPrice: 400, stockData: { price: o.stockPrice ?? 400 } } }))) as any });
  return { fetchFn, prices };
}

async function account(w: ReturnType<typeof world>, enabled: boolean) {
  const seed = randomBytes(32), addr = new DevSolSigner().add(seed), fp = fakePrivy({ seed });
  const real = globalThis.fetch; globalThis.fetch = w.fetchFn;   // the RPC client and Jupiter quotes inside createSolanaTrader use the global fetch
  const acc = solanaAccounts({ rpcUrl: 'http://rpc.test', privy: { ...fp.cfg, fetchFn: fp.fetchFn }, solUsd: async () => ({ price: 100, at: Date.now() }), stocks: { enabled, prices: w.prices } });
  const state = mem(); state('solwallet').write(JSON.stringify({ address: addr, walletId: 'wallet-1', linkedAt: 1 }));
  const a = await acc.make('alice', state);
  return { acc, a, addr, restore: () => { globalThis.fetch = real; } };
}
const code = (re: string) => (e: any) => { assert.equal(e.code, re, e.message); return true; };

test('stocks: bought by ticker only when the operator enabled them; selling what you hold always works', async () => {
  const { a, restore } = await account(world(), false);
  try {
    await assert.rejects(a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy'), code('stocks_disabled'));
    const sell = await a.prepare({ token: 'TSLAx', amount: '1000000' }, '/v1/trades/sell'); assert.equal(sell.token, TSLAX, 'the ticker became the mint');
  } finally { restore(); }
});

test('stocks: a buy whose route fills near the share price passes; one far above it (the Ondo case) is refused unless the caller insists; no share price fails closed', async () => {
  const ok = await account(world(), true);
  try { const b = await ok.a.prepare({ stock: 'tslax', sol: '0.1' }, '/v1/trades/buy'); assert.equal(b.token, TSLAX); assert.equal(b.amount, '100000000'); } finally { ok.restore(); }
  const bad = await account(world({ perSol: 8_000_000n }), true);   // 0.08 share per SOL: $1,250 a share against $400
  try {
    await assert.rejects(bad.a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy'), (e: any) => { assert.equal(e.code, 'bad_price'); assert.match(e.message, /per share against a share price of \$400/); return true; });
    assert.equal((await bad.a.prepare({ token: 'TSLAx', sol: '0.1', allowRiskyToken: true }, '/v1/trades/buy')).token, TSLAX);
  } finally { bad.restore(); }
  const cheap = await account(world({ perSol: 80_000_000n }), true);   // the route pays only $125 a share: buying there is fine, selling there is refused
  try { assert.equal((await cheap.a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy')).token, TSLAX); await assert.rejects(cheap.a.prepare({ token: 'TSLAx', amount: '1000000' }, '/v1/trades/sell'), code('bad_price')); } finally { cheap.restore(); }
  const blind = await account(world({ stockPrice: null }), true);
  try { await assert.rejects(blind.a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy'), code('no_reference_price')); } finally { blind.restore(); }
});

test('stocks: perShare takes shares and USD per share, converted with the multiplier (one token = 1.25 shares here)', async () => {
  const { a, restore } = await account(world({ multiplier: '1.25', perSol: 20_000_000n }), true);   // 0.2 tokens = 0.25 shares per $100: $400 a share
  try {
    const s = await a.prepare({ token: 'TSLAx', perShare: true, shares: '1' }, '/v1/trades/sell'); assert.equal(s.amount, '80000000', '1 share is 0.8 tokens');
    const b = await a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy'); assert.equal(b.token, TSLAX, 'the price check counts the multiplier: $400 a share, not $500 a token');
    await assert.rejects(a.prepare({ token: 'TSLAx', perShare: true, shares: '1', tokens: '1' }, '/v1/trades/sell'), code('bad_request'));
    // a buy's amount is the SOL to spend: shares on any buy path is refused, not silently turned into a tiny lamport amount
    for (const [path, extra] of [['/v1/trades/buy', {}], ['/v1/orders/limit-buy', { priceUsd: '400' }], ['/v1/twap', { side: 'buy' }]] as const)
      await assert.rejects(a.prepare({ token: 'TSLAx', perShare: true, shares: '1', ...extra }, path), (e: any) => { assert.equal(e.code, 'bad_request', path); assert.match(e.message, /a buy is sized in SOL/); return true; });
    const lb = await a.prepare({ token: 'TSLAx', perShare: true, sol: '0.1', priceUsd: '400' }, '/v1/orders/limit-buy'); assert.equal(lb.amount, '100000000', 'a per-share limit buy is sized in SOL');
  } finally { restore(); }
});

test('stocks: an issuer pause blocks buys; GET /v1/stocks lists the registry and /v1/stocks/:symbol shows multiplier, price check and the holding in shares', async () => {
  const p = await account(world({ paused: true }), true);
  try { await assert.rejects(p.a.prepare({ token: 'TSLAx', sol: '0.1' }, '/v1/trades/buy'), code('unsafe_token')); } finally { p.restore(); }
  const { acc, restore } = await account(world({ multiplier: '1.25', perSol: 20_000_000n, held: 160_000_000n }), true);
  try {
    const routes = linkRoutes({ privy: acc.privy, status: acc.status, stock: acc.stock, stocksEnabled: acc.stocksEnabled, state: () => mem(), reload: async () => {} });
    const ls = (q: string): any => routes.find(r => r.path === '/v1/stocks')!.run({ userId: 'alice', params: {}, body: undefined, query: new URLSearchParams(q) } as any);
    const all = await ls('all=true&q=tsla'); assert.equal(all.buyEnabled, true); assert.ok(all.stocks.some((s: any) => s.symbol === 'TSLAon' && s.underlying === 'TSLA' && s.issuer === 'Ondo Global Markets'));
    const def = await ls(''); assert.ok(def.stocks.length > 0 && def.stocks.every((s: any) => s.tradable), 'by default only what traded near the share price at the last registry run');
    assert.ok(def.total < (await ls('all=true')).total); assert.equal((await ls('all=true&limit=5')).stocks.length, 5);
    assert.ok((await ls('all=true&issuer=ondo&q=nvda')).stocks.every((s: any) => s.issuer === 'Ondo Global Markets' && s.underlying === 'NVDA'));
    const one: any = await routes.find(r => r.path === '/v1/stocks/:symbol')!.run({ userId: 'alice', params: { symbol: 'TSLAx' }, body: undefined } as any);
    assert.equal(one.mint, TSLAX); assert.equal(one.multiplier, '1.25'); assert.equal(one.paused, false); assert.equal(one.sharePriceUsd, 400); assert.equal(one.routePerShareUsd, 400); assert.equal(one.priceOk, true);
    assert.deepEqual(one.held, { tokens: '1.60000000', shares: '2.000000' });
    await assert.rejects(Promise.resolve().then(() => routes.find(r => r.path === '/v1/stocks/:symbol')!.run({ userId: 'alice', params: { symbol: 'NOPE' } } as any)), code('not_found'));
  } finally { restore(); }
});
