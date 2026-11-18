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

// xStocks (Backed): Token-2022 with the issuer's freeze authority, permanent delegate and pause, read from the TSLAx mint on mainnet (2026-11-18). The allowance is pinned to those keys.
const XS_KEYS = { freezeAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs', permanentDelegate: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq', pauseAuthority: 'JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs' };
const xstockMint = (o: { freeze?: string; delegate?: string; pause?: string; paused?: boolean; hook?: string | null } = {}) => ({ decimals: 8, mintAuthority: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj', freezeAuthority: o.freeze ?? XS_KEYS.freezeAuthority, extensions: [
  { extension: 'metadataPointer', state: {} }, { extension: 'permanentDelegate', state: { delegate: o.delegate ?? XS_KEYS.permanentDelegate } }, { extension: 'defaultAccountState', state: { accountState: 'initialized' } },
  { extension: 'scaledUiAmountConfig', state: { multiplier: '1.0032690125398187' } }, { extension: 'pausableConfig', state: { authority: o.pause ?? XS_KEYS.pauseAuthority, paused: o.paused ?? false } },
  { extension: 'confidentialTransferMint', state: {} }, { extension: 'transferHook', state: { authority: XS_KEYS.permanentDelegate, programId: o.hook ?? null } }, { extension: 'tokenMetadata', state: { symbol: 'TSLAx' } }] });
const XS = [{ mint: 'XS1', symbol: 'TSLAx', issuer: 'Backed (xStocks)', keys: XS_KEYS }];

test('an xStock with the issuer\'s pinned keys is not blocked: freeze, pause and permanent delegate are reported as issuer controls (warnings)', async () => {
  const r = await new TokenSafety(rpc(xstockMint(), T22), { issuedAssets: XS, sellRoute: async () => true }).check('XS1');
  assert.equal(r.verdict, 'warn'); assert.deepEqual(codes(r), ['issuer_freeze:warn', 'mint_authority:warn', 'issuer_delegate:warn', 'issuer_pause:warn']);
  assert.deepEqual(r.facts.issuedAsset, { symbol: 'TSLAx', issuer: 'Backed (xStocks)' });
});

test('the xStock allowance does not weaken the check: unlisted lookalikes, changed keys, a paused token, a live transfer hook and no sell route are still blocked', async () => {
  const one = (info: any, mint = 'XS1', o: any = {}) => new TokenSafety(rpc(info, T22), { issuedAssets: XS, ...o }).check(mint);
  const look = await one(xstockMint(), 'FAKE'); assert.equal(look.verdict, 'block'); assert.deepEqual(codes(look).filter((c: string) => c.endsWith(':block')), ['freeze_authority:block', 'permanent_delegate:block', 'pausable:block']); assert.equal(look.facts.issuedAsset, null);
  for (const changed of [{ freeze: 'X' }, { delegate: 'X' }, { pause: 'X' }]) { const r = await one(xstockMint(changed)); assert.equal(r.verdict, 'block'); assert.ok(codes(r).includes('issuer_keys_changed:block'), JSON.stringify(changed)); assert.equal(r.facts.issuedAsset, null); }
  assert.ok(codes(await one(xstockMint({ paused: true }))).includes('paused:block'));
  assert.ok(codes(await one(xstockMint({ hook: 'HookProgram1111' }))).includes('transfer_hook:block'));
  assert.ok(codes(await one(xstockMint(), 'XS1', { sellRoute: async () => false })).includes('no_sell_route:block'));
  assert.equal((await new TokenSafety(rpc(xstockMint(), T22), { issuedAssets: [] }).check('XS1')).verdict, 'block', 'issuedAssets: [] turns the allowance off');
  assert.equal((await new TokenSafety(rpc(xstockMint(), TOKEN), { issuedAssets: XS }).check('XS1')).verdict, 'block', 'only a Token-2022 mint qualifies');
});

test('Ondo-style issued assets keep no permanent delegate: pinned as none, so a delegate appearing breaks the allowance; the real registry covers xStocks, Ondo and Backpack', async () => {
  const OK = { freezeAuthority: 'F1', permanentDelegate: null, pauseAuthority: 'P1' }, ONDO = [{ mint: 'ON1', symbol: 'TSLAon', issuer: 'Ondo Global Markets', keys: OK }];
  const mint = (delegate?: string) => ({ decimals: 9, mintAuthority: 'M', freezeAuthority: 'F1', extensions: [{ extension: 'pausableConfig', state: { authority: 'P1', paused: false } }, ...(delegate ? [{ extension: 'permanentDelegate', state: { delegate } }] : [])] });
  const ok = await new TokenSafety(rpc(mint(), T22), { issuedAssets: ONDO }).check('ON1'); assert.equal(ok.verdict, 'warn'); assert.deepEqual(codes(ok), ['issuer_freeze:warn', 'mint_authority:warn', 'issuer_pause:warn']);
  const bad = await new TokenSafety(rpc(mint('EVIL'), T22), { issuedAssets: ONDO }).check('ON1'); assert.equal(bad.verdict, 'block'); assert.ok(codes(bad).includes('permanent_delegate:block'));
  const { STOCKS_SOLANA, stockBySymbol } = await import('../src/xstocks.ts');
  assert.equal(new Set(STOCKS_SOLANA.map(a => a.mint)).size, STOCKS_SOLANA.length, 'no mint listed twice');
  assert.deepEqual(['TSLAx', 'TSLAon', 'TSLA'].map(s => stockBySymbol(s)?.issuer), ['Backed (xStocks)', 'Ondo Global Markets', 'Backpack Securities']);
});
