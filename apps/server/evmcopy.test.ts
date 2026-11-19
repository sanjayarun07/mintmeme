/** EVM copy trading (evmcopy.ts): config parsing in the chain's coin, caps, the gate in front of the leader watcher, sizing. The leader watcher has its own tests
 *  (packages/evm/test/leaderwatch.test.ts); a full copy through a node runs in npm run verify:server-evmcopy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvmCopyBody, evmCopyCfgs, intendedWei, EvmGatedSource, toWei } from './evmcopy.ts';
import { SdkError } from '../../packages/sdk/src/wire.ts';

const ME = '0x3bf6d6283f13a9f3c78a3cb64ddb8662588fd967', LEAD = '0x' + 'ab'.repeat(20), TOK = '0x' + 'cd'.repeat(20), TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const caps = { maxTradeWei: 10n ** 16n, dailyCapWei: 5n * 10n ** 16n };
const eth = (b: any) => parseEvmCopyBody(b, { caps, follower: ME, now: 1, native: 'ETH', label: 'Robinhood Chain', findStock: t => t.toUpperCase() === 'TSLA' ? { address: TSLA } : undefined });

test('a config in ETH: fixed size, caps no higher than the account, stock tickers resolved, defaults', () => {
  const s = eth({ leader: LEAD.toUpperCase().replace('0X', '0x'), fixedEth: '0.002', dailyEth: '0.02', allow: ['TSLA', TOK] });
  assert.equal(s.leaders[0], LEAD); assert.deepEqual(s.sizing, { fixedWei: '2000000000000000' }); assert.equal(s.maxPerTradeWei, '10000000000000000'); assert.equal(s.dailyWei, '20000000000000000');
  assert.deepEqual(s.allow, [TSLA, TOK]); assert.equal(s.exitMode, 'full-on-exit'); assert.equal(s.maxAgeS, 60); assert.equal(s.trackOnly, false);
  const c = evmCopyCfgs(s, ME)[0]; assert.equal(c.fixed, 2_000_000_000_000_000n); assert.equal(c.leader, LEAD); assert.equal(c.followLeaderExit, true);
});

test('refusals say what is wrong', () => {
  const no = (b: any, re: RegExp) => assert.throws(() => eth(b), (e: any) => e instanceof SdkError && re.test(e.message));
  no({ leader: LEAD, fixedEth: '0.05' }, /above the per-trade cap/);
  no({ leader: LEAD, fixedEth: '0.001', maxPerTradeEth: '1' }, /above this account's limit/);
  no({ leader: LEAD }, /exactly one sizing rule: fixedEth/);
  no({ leader: LEAD, fixedEth: '0.001', percent: 10 }, /exactly one sizing rule/);
  no({ leader: ME, fixedEth: '0.001' }, /cannot copy itself/);
  no({ leader: 'So11111111111111111111111111111111111111112', fixedEth: '0.001' }, /not a 0x address/);
  no({ leader: LEAD, fixedSol: '0.1' }, /unknown field: fixedSol/);
  no({ leader: LEAD, fixedEth: '0.001', allow: ['AAPL'] }, /not a token address on Robinhood Chain/);
  no({ leader: LEAD, fixedEth: '0' }, /must be above 0/);
});

test('BNB Chain names its amounts in BNB', () => {
  const s = parseEvmCopyBody({ leader: LEAD, percent: 25, maxPerTradeBnb: '0.005' }, { caps, follower: ME, now: 1, native: 'BNB', label: 'BNB Chain' });
  assert.deepEqual(s.sizing, { percent: 25 }); assert.equal(s.maxPerTradeWei, toWei('0.005', 'x').toString());
  assert.throws(() => parseEvmCopyBody({ leader: LEAD, fixedEth: '0.001' }, { caps, follower: ME, now: 1, native: 'BNB', label: 'BNB Chain' }), /unknown field: fixedEth/);
});

test('sizing: a share of what the leader spent, never above the per-trade cap', () => {
  const s = eth({ leader: LEAD, percent: 50, maxPerTradeEth: '0.004' }), ev = (q: bigint) => ({ quoteAmount: q } as any);
  assert.equal(intendedWei(s, ev(4n * 10n ** 15n)), 2n * 10n ** 15n); assert.equal(intendedWei(s, ev(10n ** 18n)), 4n * 10n ** 15n);
});

test('the gate: inactive wallet, old buys and failed checks are skipped and noted; sells and passing buys go on; the cursor is the watcher\'s own', async () => {
  const s = eth({ leader: LEAD, fixedEth: '0.001', maxAgeS: 30 });
  const ev = (o: any) => ({ provider: 'rpc', chain: 'robinhood-main', txHash: '0x' + Math.random().toString(16).slice(2), logIndex: 0, leader: LEAD, kind: 'swap', side: 'buy', token: TOK, quoteAmount: 10n ** 15n, tokenAmount: 1n, leaderBalanceBefore: 0n, leaderBalanceAfter: 1n, leaderPriceE18: 1n, confirmations: 2, ...o });
  let events: any[] = [], active = true, gateFails = false; const prepared: string[] = [], gated: [string, bigint][] = [];
  const inner = { poll: async () => ({ events, reorged: [] }), snapshot: () => ({ cursor: 7 }), load: () => {} };
  const g = new EvmGatedSource(inner as any, s, { active: () => active, prepare: async t => { prepared.push(t); }, gate: async (t, w) => { gated.push([t, w]); if (gateFails) throw new SdkError('stocks_disabled', 'buying tokenized stocks is not enabled'); }, blockS: () => 0.1, now: () => 5 });
  events = [ev({}), ev({ confirmations: 400 }), ev({ side: 'sell', confirmations: 400 })];
  const r = await g.poll();
  assert.deepEqual(r.events.map(e => [e.side, e.confirmations]), [['buy', 2], ['sell', 400]], 'a 40 s old buy is not copied; a sell of what was copied still is');
  assert.match(g.notes[0].why, /about 40 s old/); assert.deepEqual(gated, [[TOK, 10n ** 15n]]); assert.deepEqual(g.snapshot(), { cursor: 7 });
  gateFails = true; events = [ev({})]; assert.equal((await g.poll()).events.length, 0); assert.match(g.notes.at(-1)!.why, /stocks_disabled/);
  active = false; events = [ev({})]; assert.equal((await g.poll()).events.length, 0); assert.match(g.notes.at(-1)!.why, /not active/);
});
