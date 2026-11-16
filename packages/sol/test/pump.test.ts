import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buy, decodeFeeConfig, feeBpsAt, decodeCurve, decodeGlobal, pumpAddresses, quoteBuy, quoteSell, buyExactSolIn, sell, PumpVenue, untradableReason, DISC, PUMP_PROGRAM, PUMP_FEE_PROGRAM, TOKEN_2022, ataAddress2 } from '../src/pump.ts';
import { base58, pubkeyBytes, PROGRAMS } from '../src/tx.ts';
import type { CurveState } from '../src/pump.ts';

const MINT = 'GY6464bjrimNkjsDpb2uarjkpd6ev6RAveWigc2jpump', USER = '11111111111111111111111111111112', CREATOR = 'EjR5SBuqKq3Zq1pJ7yQmGJ2cNRWU9wMkQ9iJgsmCMk5E'.slice(0, 44);
const curveBuf = (o: Partial<{ vt: bigint; vs: bigint; rt: bigint; rs: bigint; supply: bigint; complete: number; mayhem: number; cashback: number; len: number; disc: readonly number[] }> = {}) => {
  const b = Buffer.alloc(o.len ?? 166); Buffer.from(o.disc ?? DISC.curve).copy(b, 0); b.writeBigUInt64LE(o.vt ?? 1_000_000_000_000_000n, 8); b.writeBigUInt64LE(o.vs ?? 30_000_000_000n, 16); b.writeBigUInt64LE(o.rt ?? 793_000_000_000_000n, 24);
  b.writeBigUInt64LE(o.rs ?? 0n, 32); b.writeBigUInt64LE(o.supply ?? 1_000_000_000_000_000n, 40); b[48] = o.complete ?? 0; Buffer.from(pubkeyBytes(PROGRAMS.system === USER ? USER : '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf')).copy(b, 49); b[81] = o.mayhem ?? 0; b[82] = o.cashback ?? 0; return b; };
const globalBuf = (feeBps = 95n, creatorBps = 5n) => { const b = Buffer.alloc(1096); Buffer.from(DISC.global).copy(b, 0); b[8] = 1; b.writeBigUInt64LE(feeBps, 105); b.writeBigUInt64LE(creatorBps, 154); Buffer.from(pubkeyBytes('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV')).copy(b, 41); return b; };

test('program addresses match values read from the real chain', () => {
  const a = pumpAddresses(MINT, '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', TOKEN_2022);
  assert.equal(a.global, '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', 'the Global PDA is the address the README documents');
  assert.equal(a.bondingCurve, 'AuLHoTZF7tXqiUfdYTsWXBaBmPrhFoeq6crRjdWrLwH1', 'the curve PDA for this mint is the account a real transaction used');
  assert.notEqual(a.associatedBondingCurve, ataAddress2(a.bondingCurve, MINT, PROGRAMS.token), 'the token program is part of the associated account address');
});
test('decodes a curve and refuses anything it does not recognise', () => {
  const c = decodeCurve(curveBuf({ rs: 5n })); assert.equal(c.virtualToken, 1_000_000_000_000_000n); assert.equal(c.realSol, 5n); assert.equal(c.complete, false); assert.equal(c.mayhem, false); assert.equal(c.cashback, false);
  assert.throws(() => decodeCurve(curveBuf({ disc: [1, 2, 3, 4, 5, 6, 7, 8] })), /discriminator/); assert.throws(() => decodeCurve(Buffer.alloc(40)), /at least 81/);
  assert.equal(decodeCurve(curveBuf({ len: 81 })).mayhem, undefined, 'an older layout is decoded but its flags are unknown');
});
test('decodes Global fees and recipients', () => {
  const g = decodeGlobal(globalBuf()); assert.equal(g.feeBps, 95n); assert.equal(g.creatorFeeBps, 5n); assert.equal(g.feeRecipient, '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV'); assert.equal(g.feeRecipients.length, 7);
  assert.throws(() => decodeGlobal(Buffer.alloc(100)), /at least 386/); assert.throws(() => decodeGlobal(Buffer.alloc(1096)), /discriminator/);
});
test('buy and sell maths: fees come out of the budget, output never exceeds what is left, a round trip loses at least the fees', () => {
  const c = decodeCurve(curveBuf()), b = quoteBuy(1_000_000_000n, c, 100n);
  assert.equal(b.net, 1_000_000_000n * 10_000n / 10_100n); assert.ok(b.tokens > 0n && b.net + b.fee === 1_000_000_000n);
  assert.equal(quoteBuy(10n ** 18n, { ...c, realToken: 5n }, 100n).tokens, 5n, 'cannot buy more than the curve still holds'); assert.equal(quoteBuy(1n, c, 100n).tokens, 0n);
  const s = quoteSell(b.tokens, { virtualToken: c.virtualToken - b.tokens, virtualSol: c.virtualSol + b.net }, 100n); assert.ok(s.net < 1_000_000_000n, 'selling straight back returns less than was spent');
  assert.ok(quoteBuy(2_000_000_000n, c, 100n).tokens > b.tokens, 'a bigger budget buys more'); assert.ok(quoteSell(2n * b.tokens, c, 100n).net > quoteSell(b.tokens, c, 100n).net);
});
test('instructions carry the IDL discriminators, argument bytes, account order, and signer flags', () => {
  const ctx = { user: USER, mint: MINT, tokenProgram: TOKEN_2022, curve: decodeCurve(curveBuf()) as CurveState, feeRecipient: '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', buybackRecipient: '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6' };
  const b = buyExactSolIn(ctx, 123n, 45n), s = sell(ctx, 678n, 9n), v1 = buy(ctx, 777n, 888n);
  assert.deepEqual([...v1.data.slice(0, 8)], [...DISC.buy]); assert.equal(v1.data.length, 25); assert.equal(Buffer.from(v1.data).readBigUInt64LE(8), 777n); assert.equal(Buffer.from(v1.data).readBigUInt64LE(16), 888n); assert.equal(v1.keys.length, 18); assert.equal(v1.keys[17].pubkey, '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6'); assert.equal(v1.keys.filter(k => k.signer).length, 1);
  assert.equal(b.program, PUMP_PROGRAM); assert.deepEqual([...b.data.slice(0, 8)], [...DISC.buyExactSolIn]); assert.equal(b.data.length, 25); assert.equal(Buffer.from(b.data).readBigUInt64LE(8), 123n); assert.equal(Buffer.from(b.data).readBigUInt64LE(16), 45n);
  assert.equal(b.keys.length, 18); assert.equal(b.keys[6].pubkey, USER); assert.ok(b.keys[6].signer && b.keys[6].writable); assert.equal(b.keys.filter(k => k.signer).length, 1); assert.equal(b.keys[15].pubkey, PUMP_FEE_PROGRAM); assert.equal(b.keys[8].pubkey, TOKEN_2022);
  assert.deepEqual([...s.data.slice(0, 8)], [...DISC.sell]); assert.equal(s.data.length, 24); assert.equal(Buffer.from(s.data).readBigUInt64LE(8), 678n); assert.equal(Buffer.from(s.data).readBigUInt64LE(16), 9n);
  assert.equal(s.keys.length, 16); assert.equal(s.keys[6].pubkey, USER); assert.equal(s.keys[9].pubkey, TOKEN_2022); assert.equal(s.keys.filter(k => k.signer).length, 1);
});
test('the venue quotes, steps its own state, and refuses coins it cannot trade', () => {
  const g = decodeGlobal(globalBuf()), c = decodeCurve(curveBuf()), v = new PumpVenue(`pump:${MINT}`, MINT, TOKEN_2022, c, g);
  assert.ok(v.supports('NATIVE', MINT) && v.supports(MINT, 'NATIVE') && !v.supports(MINT, 'OTHER')); const q = v.quote('NATIVE', MINT, 10n ** 9n); assert.equal(q.amountOut, quoteBuy(10n ** 9n, c, 100n).tokens);
  assert.ok(v.spotPriceE18('NATIVE', MINT) > 0n && v.spotPriceE18(MINT, 'NATIVE') > 0n);
  const w = v.clone(), before = w.curve.virtualSol; const r = w.swap('NATIVE', MINT, 10n ** 9n); assert.equal(r.amountOut, q.amountOut); assert.ok(w.curve.virtualSol > before); assert.equal(v.curve.virtualSol, before, 'the clone is independent');
  assert.equal(untradableReason(decodeCurve(curveBuf()), TOKEN_2022), undefined); assert.match(untradableReason(decodeCurve(curveBuf({ complete: 1 })), TOKEN_2022)!, /complete/);
  assert.match(untradableReason(decodeCurve(curveBuf({ mayhem: 1 })), TOKEN_2022)!, /mayhem/); assert.match(untradableReason(decodeCurve(curveBuf({ cashback: 1 })), TOKEN_2022)!, /cashback/);
  assert.match(untradableReason(decodeCurve(curveBuf({ len: 81 })), TOKEN_2022)!, /older curve layout/); assert.match(untradableReason(decodeCurve(curveBuf()), 'SomeOtherProgram1111111111111111111111111111')!, /not the SPL Token/);
  const bad = new PumpVenue('x', MINT, TOKEN_2022, decodeCurve(curveBuf({ complete: 1 })), g, 'complete'); assert.equal(bad.supports('NATIVE', MINT), false); assert.equal(bad.status, 'graduated');
});
test('a base58 sanity check on the fee program constant', () => { assert.equal(pubkeyBytes(PUMP_FEE_PROGRAM).length, 32); assert.equal(base58(pubkeyBytes(PUMP_FEE_PROGRAM)), PUMP_FEE_PROGRAM); });

test('fee config decodes flat fees and tiers, picks the tier by market cap, and refuses an unknown layout', () => {
  const d = Buffer.alloc(69 + 2 * 40); d.writeBigUInt64LE(0n, 41); d.writeBigUInt64LE(95n, 49); d.writeBigUInt64LE(30n, 57); d.writeUInt32LE(2, 65);
  d.writeBigUInt64LE(1000n, 69); d.writeBigUInt64LE(0n, 85); d.writeBigUInt64LE(90n, 93); d.writeBigUInt64LE(20n, 101);
  d.writeBigUInt64LE(5000n, 109); d.writeBigUInt64LE(0n, 125); d.writeBigUInt64LE(50n, 133); d.writeBigUInt64LE(10n, 141);
  const c = decodeFeeConfig(d); assert.equal(c.tiers.length, 2);
  assert.equal(feeBpsAt(c, 10n), 125n); assert.equal(feeBpsAt(c, 1000n), 110n); assert.equal(feeBpsAt(c, 9999n), 60n);
  d.writeUInt32LE(9999, 65); assert.throws(() => decodeFeeConfig(d), /not recognised/);
});
