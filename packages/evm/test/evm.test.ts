import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccakHex, selector, sponge256, bytesToHex } from '../src/keccak.ts';
import { encodeCall, encodeParams, decodeParams } from '../src/abi.ts';
import { erc20, swapExactTokensForTokens, swapExactETHForTokens, swapExactTokensForETH } from '../src/calldata.ts';
import { create2, pairAddress, sortTokens } from '../src/pair.ts';
import { planApproval, MAX_UINT256 } from '../src/approval.ts';
import { getAmountOut, getAmountIn, decodeReserves, V2Venue, V2_FEE } from '../src/v2.ts';
import { CpAmm } from '../../core/src/venues.ts';
import { NATIVE } from '../../core/src/types.ts';
import * as F from './fixtures.ts';

test('keccak256 known vectors', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('allowance(address,address)'), '0xdd62ed3e');
  assert.equal(selector('getReserves()'), '0x0902f1ac');
  assert.equal(selector('token1()'), '0xd21220a7');
  assert.equal(selector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'), '0x38ed1739');
  assert.equal(selector('swapExactETHForTokens(uint256,address[],address,uint256)'), '0x7ff36ab5');
  assert.equal(selector('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'), '0x18cbafe5');
});

test('keccak permutation cross-checked via SHA3-256 padding on multi-block inputs', () => {
  for (const n of [0, 1, 55, 135, 136, 137, 272, 500, 1000]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
    assert.equal(bytesToHex(sponge256(data, 0x06)), '0x' + createHash('sha3-256').update(data).digest('hex'), `len ${n}`);
  }
});

test('abi encode/decode roundtrip incl. dynamic arrays', () => {
  const types = ['uint256', 'address[]', 'address', 'bool'];
  const vals = [123n, [F.A(1), F.A(2), F.A(3)], F.A(7), true];
  const dec = decodeParams(types, encodeParams(types, vals));
  assert.deepEqual(dec, vals);
  assert.throws(() => encodeParams(['uint8'], [256n]));
  assert.throws(() => decodeParams(['address'], '0x' + 'ff'.repeat(32)));
});

test('erc20 calldata layout', () => {
  const tx = erc20.approve(F.TOKEN0, F.ROUTER, 5n);
  assert.equal(tx.data, '0x095ea7b3' + F.ROUTER.slice(2).padStart(64, '0') + (5n).toString(16).padStart(64, '0'));
  assert.equal(erc20.balanceOf(F.TOKEN0, F.OWNER).data.slice(0, 10), '0x70a08231');
  assert.equal(erc20.decodeUint('0x' + (42n).toString(16).padStart(64, '0')), 42n);
});

test('router calldata: selectors, values, fee-on-transfer variants', () => {
  const base = { router: F.ROUTER, amountIn: 1000n, amountOutMin: 900n, path: [F.TOKEN0, F.TOKEN1], to: F.OWNER, deadline: 1_700_000_000 };
  assert.equal(swapExactTokensForTokens(base).data.slice(0, 10), '0x38ed1739');
  assert.equal(swapExactTokensForTokens({ ...base, feeOnTransfer: true }).data.slice(0, 10), '0x5c11d795');
  const eth = swapExactETHForTokens({ ...base, feeOnTransfer: true });
  assert.equal(eth.data.slice(0, 10), '0xb6f9de95'); assert.equal(eth.value, 1000n);
  assert.equal(swapExactETHForTokens(base).data.slice(0, 10), '0x7ff36ab5');
  assert.equal(swapExactTokensForETH(base).data.slice(0, 10), '0x18cbafe5');
  assert.equal(swapExactTokensForETH({ ...base, feeOnTransfer: true }).data.slice(0, 10), '0x791ac947');
  const [amt, min, path, to, dl] = decodeParams(['uint256', 'uint256', 'address[]', 'address', 'uint256'], '0x' + swapExactTokensForTokens(base).data.slice(10));
  assert.deepEqual([amt, min, path, to, dl], [1000n, 900n, [F.TOKEN0, F.TOKEN1], F.OWNER, 1_700_000_000n]);
  assert.throws(() => swapExactTokensForTokens({ ...base, path: [F.TOKEN0] }));
});

test('CREATE2: EIP-1014 spec vectors and pair derivation', () => {
  assert.equal(create2(F.A(0), '0x' + '00'.repeat(32), keccakHex(Uint8Array.of(0))), '0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38');
  assert.equal(create2('0x00000000000000000000000000000000deadbeef', '0x' + '00'.repeat(28) + 'cafebabe', keccakHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))),
    '0x60f3f640a8508fc6a86d45df051962668e1e8ac7');
  const p1 = pairAddress(F.FACTORY, F.INIT_CODE_HASH, F.TOKEN0, F.TOKEN1);
  assert.equal(p1, pairAddress(F.FACTORY, F.INIT_CODE_HASH, F.TOKEN1, F.TOKEN0)); // order-independent
  assert.match(p1, /^0x[0-9a-f]{40}$/);
  assert.notEqual(p1, pairAddress(F.A(1), F.INIT_CODE_HASH, F.TOKEN0, F.TOKEN1));
  assert.deepEqual(sortTokens(F.TOKEN1, F.TOKEN0), [F.TOKEN0, F.TOKEN1]);
  assert.throws(() => sortTokens(F.TOKEN0, F.TOKEN0));
});

test('approval planning', () => {
  assert.deepEqual(planApproval(F.TOKEN0, F.ROUTER, 100n, 100n), []);
  assert.deepEqual(planApproval(F.TOKEN0, F.ROUTER, 100n, 500n), []);
  const [tx, ...rest] = planApproval(F.TOKEN0, F.ROUTER, 100n, 99n);
  assert.equal(rest.length, 0);
  assert.deepEqual(decodeParams(['address', 'uint256'], '0x' + tx.data.slice(10)), [F.ROUTER, 100n]); // exact, not unlimited
  assert.equal(planApproval(F.TOKEN0, F.ROUTER, 100n, 50n, { resetFirst: true }).length, 2);
  assert.equal(planApproval(F.TOKEN0, F.ROUTER, 100n, 0n, { resetFirst: true }).length, 1);
  assert.throws(() => planApproval(F.TOKEN0, F.ROUTER, MAX_UINT256, 0n));
  assert.equal(planApproval(F.TOKEN0, F.ROUTER, MAX_UINT256, 0n, { allowUnlimited: true }).length, 1);
  assert.throws(() => planApproval(F.TOKEN0, F.ROUTER, 0n, 0n));
});

test('getAmountOut exact math', () => {
  assert.equal(getAmountOut(1000n, 10000n, 10000n), 906n);
  assert.equal(getAmountOut(1000n, 10000n, 10000n, { num: 9975n, den: 10000n }), 907n);
  assert.throws(() => getAmountOut(0n, 1n, 1n));
  assert.throws(() => getAmountOut(1n, 0n, 1n));
  // getAmountIn inverts: output at computed input >= requested
  for (const out of [1n, 100n, 5000n]) assert.ok(getAmountOut(getAmountIn(out, 10000n, 20000n), 10000n, 20000n) >= out);
});

test('property: V2 getAmountOut vs core CpAmm (equal reserves, 30bps)', () => {
  let seed = 12345n;
  const rnd = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed % max; };
  for (let i = 0; i < 500; i++) {
    const r = 1_000n + rnd(10n ** 24n);
    const amt = 1n + rnd(r * 2n);
    const cp = new CpAmm('x', 'evm', 'T', 'Q', r, r, 30n).quote('T', 'Q', amt).amountOut;
    const v2 = getAmountOut(amt, r, r);
    assert.ok(v2 >= cp && v2 - cp <= 1n, `r=${r} amt=${amt} v2=${v2} cp=${cp}`);
  }
});

test('V2Venue from recorded fixtures (no network)', async () => {
  const log: string[] = [];
  const v = await V2Venue.load(F.recordedCall(log), { id: 'v2-test', pair: F.PAIR, wrappedNative: F.WRAPPED, block: 777 });
  assert.equal(log.length, 3); assert.ok(log.every(l => l.endsWith('@777')));
  assert.deepEqual([v.token0, v.token1, v.reserve0, v.reserve1], [F.TOKEN0, F.TOKEN1, 10_000n, 20_000n]);
  const q = v.quote(F.TOKEN0, F.TOKEN1, 1000n);
  assert.equal(q.amountOut, getAmountOut(1000n, 10_000n, 20_000n));
  assert.equal(q.amountOut, 1813n);
  assert.equal(q.venueFee, 3n);
  assert.equal(q.family, 'evm');
  assert.ok(v.supports(NATIVE, F.TOKEN1)); assert.ok(!v.supports(F.TOKEN1, F.A(5)));
  const c = v.clone(); c.swap(F.TOKEN0, F.TOKEN1, 1000n);
  assert.equal(c.reserve0, 11_000n); assert.equal(c.reserve1, 20_000n - 1813n);
  assert.equal(v.reserve0, 10_000n); // clone isolated
  assert.deepEqual(decodeReserves(F.RESERVES_HEX), { reserve0: 10_000n, reserve1: 20_000n, blockTimestampLast: 0x65n });
  await assert.rejects(V2Venue.load(F.recordedCall(), { id: 'x', pair: F.A(1) }), /unrecorded/);
});

test('V2Venue matches CpAmm shape and invariant k non-decreasing', () => {
  const v = new V2Venue({ id: 'v', pair: F.PAIR, token0: F.TOKEN0, token1: F.TOKEN1, reserve0: 50_000n, reserve1: 80_000n });
  const k0 = v.reserve0 * v.reserve1;
  v.swap(F.TOKEN1, F.TOKEN0, 7_000n);
  assert.ok(v.reserve0 * v.reserve1 >= k0);
  const q = v.quote(F.TOKEN0, F.TOKEN1, 100n);
  assert.deepEqual(Object.keys(q).sort(), ['amountOut', 'family', 'liquidity', 'priceImpactBps', 'venue', 'venueFee']);
  assert.equal(V2_FEE.num, 997n);
});
