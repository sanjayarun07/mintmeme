/** The RFQ desk inside /app (apps/web/rfqdesk.ts) and trade times from the chain (market.ts txTimes). Network is faked; the real desk is never called. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskConfig, deskQuote, deskEvmQuote } from '../rfqdesk.ts';
import { txTimes, clearMarketCache } from '../market.ts';

const env = { RFQ_DESK_URL: 'http://desk.test/' } as NodeJS.ProcessEnv;
const MINT = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

test('only the desk\'s quote routes are called, a quote\'s stages come back as a list, and a trade stage loses its transaction', async () => {
  const seen: string[] = [];
  const f = (async (url: string, init: any) => { seen.push(init.method + ' ' + url);
    if (url.endsWith('/api/config')) return new Response(JSON.stringify({ privyAppId: 'secret-ish', defaultTaker: 'W', maxUsd: 1500, stocks: [{ symbol: 'TSLAx', mint: MINT, issuer: 'Backed', extra: 1 }], evmStocks: { robinhood: { label: 'Robinhood Chain', native: 'ETH', symbols: ['TSLA'] } } }));
    return new Response(['{"stage":"context","usd":1000}', '{"stage":"trade","tradable":true,"transaction":"AAAA"}', '{"stage":"done"}', ''].join('\n'));
  }) as any;
  const c = await deskConfig({}, { fetch: f, env });
  assert.deepEqual(c.stocks, [{ symbol: 'TSLAx', mint: MINT, issuer: 'Backed' }]); assert.equal('privyAppId' in c, false, 'no Privy or wallet details are passed on');
  assert.deepEqual(c.evm.robinhood.symbols, ['TSLA']);
  const q = await deskQuote({ mint: MINT, side: 'buy', pay: 'USDC', amount: '1000000000', transaction: 'x', taker: 'someone' }, { fetch: f, env });
  assert.deepEqual(q.stages.map(s => s.stage), ['context', 'trade', 'done']); assert.equal(q.stages[1].transaction, undefined, 'nothing to sign leaves this tab');
  const sent = JSON.parse((await (async () => { let b = ''; await deskQuote({ mint: MINT, amount: '1', taker: 'X' }, { fetch: (async (_u: string, i: any) => { b = i.body; return new Response(''); }) as any, env }); return b; })()));
  assert.deepEqual(Object.keys(sent).sort(), ['amount', 'mint'], 'only quote fields are forwarded (no taker, no transaction)');
  assert.deepEqual(seen, ['GET http://desk.test/api/config', 'POST http://desk.test/api/quote']);
});

test('bad input and a stopped desk are plain refusals', async () => {
  await assert.rejects(deskQuote({ mint: 'nope', amount: '1' }, { env }), /Pick a stock/);
  await assert.rejects(deskQuote({ mint: MINT, amount: '1.5' }, { env }), /Set an amount/);
  await assert.rejects(deskEvmQuote({ chain: 'solana', amount: 1 }, { env }), /Base, Robinhood Chain or BNB Chain/);
  await assert.rejects(deskConfig({}, { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as any, env }), /RFQ desk is not running/);
});

test('trade times come from the chain: Solana blockTime, EVM receipt block timestamp; unknown stays null and is asked again', async () => {
  clearMarketCache();
  const SIG = '5'.repeat(88), TX = '0x' + 'a'.repeat(64);
  let calls = 0;
  const f = (async (_u: string, init: any) => { calls++; const b = JSON.parse(init.body);
    if (b.method === 'getTransaction') return new Response(JSON.stringify({ result: b.params[0] === SIG ? { blockTime: 1795091936 } : null }));
    if (b.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ result: { blockNumber: '0x10' } }));
    if (b.method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: { timestamp: '0x6a' } }));
    throw new Error(b.method); }) as any;
  const e = { ALCHEMY_API_KEY: 'k' } as any;
  const s = await txTimes({ chain: 'solana', hashes: [SIG, '4'.repeat(88), 'junk'] }, { fetch: f, env: e });
  assert.equal(s.times[SIG], 1795091936); assert.equal(s.times['4'.repeat(88)], null); assert.equal('junk' in s.times, false);
  const before = calls; await txTimes({ chain: 'solana', hashes: [SIG] }, { fetch: f, env: e }); assert.equal(calls, before, 'a found time is cached');
  const v = await txTimes({ chain: 'robinhood', hashes: [TX] }, { fetch: f, env: e }); assert.equal(v.times[TX], 0x6a);
});
