import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenSafety } from '../src/tokensafety.ts';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** A stand-in RPC answering getAccountInfo (jsonParsed, as Solana RPC decodes mints and Token-2022 extensions) and getTokenLargestAccounts. */
const rpc = (info: any, owner = TOKEN, holders: [string, bigint][] = [], calls: string[] = []) => ({ call: async (m: string) => { calls.push(m);
  if (m === 'getAccountInfo') return { value: { owner, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000', ...info } } } } };
  if (m === 'getTokenLargestAccounts') return { value: holders.map(([address, a]) => ({ address, amount: a.toString() })) };
  throw new Error(m); } });
const codes = (r: any) => r.risks.map((x: any) => `${x.code}:${x.level}`);

test('a plain token with both authorities revoked, spread holders and a sell route is ok', async () => {
  const r = await new TokenSafety(rpc({}, TOKEN, [['A', 100_000n], ['B', 50_000n]]), { sellRoute: async () => true, buyImpactPct: async () => 2 }).check('M');
  assert.equal(r.verdict, 'ok'); assert.deepEqual(r.risks, []); assert.equal(r.facts.topHolderPct, 10); assert.equal(r.facts.top10Pct, 15); assert.equal(r.facts.sellRoute, true);
});

test('honeypot shapes are blocked: freeze authority, permanent delegate, transfer hook, non-transferable, frozen by default, pausable, a 10%+ transfer fee, no sell route', async () => {
  const one = async (info: any, owner = TOKEN, o: any = {}) => new TokenSafety(rpc(info, owner), o).check('M');
  assert.deepEqual(codes(await one({ freezeAuthority: 'F' })), ['freeze_authority:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'permanentDelegate', state: { delegate: 'D' } }] }, T22)), ['permanent_delegate:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'transferHook', state: { authority: 'A', programId: 'P' } }] }, T22)), ['transfer_hook:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'transferHook', state: { authority: 'A', programId: null } }] }, T22)), [], 'a hook extension with no program set is harmless');
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'nonTransferable' }] }, T22)), ['non_transferable:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }] }, T22)), ['default_frozen:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'pausableConfig', state: {} }] }, T22)), ['pausable:block']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 1500 } } }] }, T22)), ['transfer_fee:block']);
  assert.equal((await one({}, TOKEN, { sellRoute: async () => false })).verdict, 'block');
});

test('reasons for care are warnings: mint authority, a small or settable transfer fee, unknown extensions, concentration, thin liquidity', async () => {
  const one = async (info: any, owner = TOKEN, holders: [string, bigint][] = [], o: any = {}) => new TokenSafety(rpc(info, owner, holders), o).check('M');
  assert.deepEqual(codes(await one({ mintAuthority: 'M' })), ['mint_authority:warn']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 200 } } }] }, T22)), ['transfer_fee:warn']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 0 } } }] }, T22)), ['transfer_fee_settable:warn']);
  assert.deepEqual(codes(await one({ extensions: [{ extension: 'tokenMetadata', state: {} }, { extension: 'someFutureThing', state: {} }] }, T22)), ['unknown_extension:warn'], 'metadata is harmless; an unknown extension is not assumed safe');
  const r = await one({}, TOKEN, [['CURVE', 600_000n], ['W1', 300_000n], ['W2', 250_000n]], { liquidityAccounts: () => ['CURVE'], buyImpactPct: async () => 25 });
  assert.deepEqual(codes(r), ['concentrated_holder:warn', 'concentrated_top10:warn', 'thin_liquidity:warn']); assert.equal(r.facts.topHolderPct, 30, 'the bonding curve is not counted as a holder'); assert.deepEqual(r.facts.excludedHolders, ['CURVE']);
});

test('not a mint, a missing mint, and the cache', async () => {
  await assert.rejects(new TokenSafety({ call: async () => ({ value: null }) }).check('X'), /does not exist/);
  await assert.rejects(new TokenSafety({ call: async () => ({ value: { owner: '11111111111111111111111111111111', data: {} } }) }).check('X'), /not a token mint/);
  const calls: string[] = [], now = { t: 0 }, s = new TokenSafety(rpc({}, TOKEN, [], calls), { cacheMs: 1000, now: () => now.t });
  await s.check('M'); await s.check('M'); assert.equal(calls.filter(c => c === 'getAccountInfo').length, 1); now.t = 2000; await s.check('M'); assert.equal(calls.filter(c => c === 'getAccountInfo').length, 2);
});
