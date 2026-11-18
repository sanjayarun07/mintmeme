import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NATIVE } from '../../core/src/index.ts';
import { PrivyApi } from '../../sol/src/index.ts';
import { createBaseTrader, BASE } from '../src/index.ts';
import { fakePrivyEvm } from '../../evm/test/fakeprivyevm.ts';

// A Base token with NO Uniswap V2 WETH pool (a Coinbase stock, NVDAc-style) is routed through Relay; the quote is a real one captured on Base (packages/evm/test/relayfixture.json).
const fx = JSON.parse(readFileSync(new URL('../../evm/test/relayfixture.json', import.meta.url), 'utf8')).quotes['buy-kyber'];
const TOKEN = String(fx.tokenOut).toLowerCase();
const mem = () => { const m = new Map<string, string>(); return (n: string) => ({ read: () => m.get(n), write: (d: string) => { m.set(n, d); }, describe: () => n }); };
const rpc = { call: async (m: string, p: any[] = []): Promise<any> => {
  if (m === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x6b49d200' };
  if (m === 'eth_call' && p[0].to === BASE.factory) return '0x' + '0'.repeat(64);                    // getPair(WETH, token): no V2 pool
  if (m === 'eth_call' && p[0].data === '0x313ce567') return '0x' + (8).toString(16).padStart(64, '0');   // decimals()
  if (m === 'eth_call' && p[0].to === BASE.wethUsdcPair) return '0x' + '0'.repeat(192);
  throw new Error(`unscripted ${m}`); } };
const quote = { amountOut: BigInt(fx.amountOut), minimumOut: BigInt(fx.minimumOut), relayerFeeWei: 0n, requestId: 'r', steps: [] };

test('Base trader: a token without a V2 pool gets Relay venues (both ways); with Relay off it is refused with the reason', async () => {
  const p = fakePrivyEvm(), privy = new PrivyApi({ ...p.cfg, fetchFn: p.fetchFn, chainType: 'ethereum' }), asked: string[] = [];
  const client = { quote: async (w: string, tin: string, tout: string) => { asked.push(`${w}:${tin}>${tout}`); return quote; } } as any;
  const t = await createBaseTrader({ userId: 'u', address: p.address, rpcUrl: 'http://rpc.test', privy, state: mem(), rpc, relay: { client } });
  await t.prepare(TOKEN);
  const vs = t.chain.venues(); assert.equal(vs.length, 2); assert.ok(vs.every(v => v.family === 'relay')); assert.ok(vs.some(v => v.supports(NATIVE, TOKEN)) && vs.some(v => v.supports(TOKEN, NATIVE)));
  assert.ok(asked.every(a => a.startsWith(p.address.toLowerCase())), 'reference quotes are asked for the user\'s own wallet');
  const off = await createBaseTrader({ userId: 'u', address: p.address, rpcUrl: 'http://rpc.test', privy, state: mem(), rpc, relay: false });
  await assert.rejects(off.prepare(TOKEN), (e: any) => e.code === 'no_route' && /Relay routing is off/.test(e.message));
  const none = await createBaseTrader({ userId: 'u', address: p.address, rpcUrl: 'http://rpc.test', privy, state: mem(), rpc, relay: { client: { quote: async () => { throw new Error('Relay quote failed: HTTP 400: no routes found'); } } as any } });
  await assert.rejects(none.prepare(TOKEN), (e: any) => e.code === 'no_route' && /no Relay route.*no routes found/.test(e.message));
});
