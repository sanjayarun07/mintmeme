import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import type { SimTx } from '../../core/src/index.ts';
import { DevSolSigner, verifySignature, SolanaChain, SolJsonRpcError, RaydiumVenue, decodePoolState, base58, b58decode, wireTx, compileLegacy, systemTransfer, closeAccount, setComputeUnitLimit, setComputeUnitPrice } from '../src/index.ts';

const signer = new DevSolSigner(), W = signer.add(), USDC = signer.add(), WSOL = signer.add();
const keysOf = () => { const k = () => signer.add(); return { programId: k(), id: k(), authority: k(), openOrders: k(), targetOrders: k(), baseVault: k(), quoteVault: k(), marketProgram: k(), market: k(), bids: k(), asks: k(), eventQueue: k(), marketBaseVault: k(), marketQuoteVault: k(), marketAuthority: k() }; };
class Script { calls: string[] = []; h: Record<string, (p: any[]) => any> = {}; async call(m: string, p: any[] = []) { this.calls.push(m); const f = this.h[m]; if (!f) throw new Error(`unscripted ${m}`); return f(p); } }
const mkChain = (s: Script, tradable = true) => {
  const c = new SolanaChain({ id: 'sol-test', wsol: WSOL, pools: [] }, s, signer); c.time = 1_800_000_000; c.block = 100;
  c.state.venues.set('pool1', new RaydiumVenue('pool1', keysOf(), WSOL, USDC, 1_000_000n * 10n ** 9n, 150_000_000n * 10n ** 6n, 25n, 10_000n, WSOL, tradable));
  return c;
};
const swapTx = (o: Partial<SimTx> = {}): SimTx => ({ hash: '', wallet: W, nonce: 0, venue: 'pool1', tokenIn: NATIVE, tokenOut: USDC, amountIn: 10n ** 9n, minOut: 1n, deadline: 1_800_000_600, platformFeeBps: 0, kind: 'swap', ...o } as SimTx);
const BH = base58(new Uint8Array(32).fill(7));

test('dev signer: base58 address, valid ed25519 signatures, unknown wallet refused', () => {
  assert.equal(b58decode(W).length, 32);
  const m = new TextEncoder().encode('hello'), sig = signer.sign(W, m);
  assert.equal(sig.length, 64); assert.ok(verifySignature(W, m, sig));
  assert.ok(!verifySignature(W, new TextEncoder().encode('hellO'), sig));
  assert.throws(() => signer.sign(base58(new Uint8Array(32).fill(9)), m), /no key/);
  assert.throws(() => wireTx(new Uint8Array([1, 0, 0]), []), /needs 1 signature/);
});

test('prepare builds a signed legacy transaction: one valid signature over the message, hash == base58(signature), carries the blockhash and the swap', async () => {
  const s = new Script(); s.h.getLatestBlockhash = () => ({ value: { blockhash: BH, lastValidBlockHeight: 200 } });
  const c = mkChain(s), p = await c.prepare(swapTx()), wire = Buffer.from(p.raw, 'base64');
  assert.equal(wire[0], 1); const sig = wire.subarray(1, 65), msg = wire.subarray(65);
  assert.equal(base58(sig), p.hash); assert.ok(verifySignature(W, msg, sig));
  assert.equal(msg[0], 1);   // one required signature (the wallet)
  assert.ok(Buffer.from(msg).includes(Buffer.from(b58decode(BH))), 'blockhash is inside the signed message');
  assert.ok(Buffer.from(msg).includes(Buffer.from(b58decode(USDC))), 'output token mint appears (account creation)');
});

test('a sell (token -> SOL) and a noop also build; approvals never requested; nonce is always 0', async () => {
  const s = new Script(); s.h.getLatestBlockhash = () => ({ value: { blockhash: BH, lastValidBlockHeight: 200 } }); const c = mkChain(s);
  const sell = await c.prepare(swapTx({ tokenIn: USDC, tokenOut: NATIVE })), noop = await c.prepare(swapTx({ kind: 'noop' } as any));
  assert.notEqual(sell.hash, noop.hash); assert.equal(await c.needsApproval(), undefined); assert.equal(await c.confirmedNonce(), 0);
  await assert.rejects(c.prepare(swapTx({ kind: 'approve' } as any)), /no token allowances/);
});

test('platform fee is refused, unknown venue is refused; simulate reports both as a failed simulation, not an outage', async () => {
  const c = mkChain(new Script());
  await assert.rejects(c.prepare(swapTx({ platformFeeBps: 50 })), /platform fee/);
  assert.equal((await c.simulate(swapTx({ platformFeeBps: 50 }))).receipt.status, 'reverted');
  assert.match((await c.simulate(swapTx({ venue: 'nope' }))).receipt.reason!, /not loaded/);
});

test('simulate: program error -> reverted with the reason; success -> success; transport failure propagates (engine stays quoted and retries)', async () => {
  const s = new Script(); const c = mkChain(s);
  s.h.simulateTransaction = () => ({ value: { err: { InstructionError: [4, { Custom: 30 }] }, logs: ['x', 'Program log: exceeds desired slippage limit'] } });
  const bad = await c.simulate(swapTx()); assert.equal(bad.receipt.status, 'reverted'); assert.match(bad.receipt.reason!, /slippage/);
  s.h.simulateTransaction = () => ({ value: { err: null, logs: [] } }); assert.equal((await c.simulate(swapTx())).receipt.status, 'success');
  s.h.simulateTransaction = () => { throw new Error('ECONNREFUSED'); }; await assert.rejects(c.simulate(swapTx()), RpcError);
  s.h.simulateTransaction = () => { throw new SolJsonRpcError('invalid params'); }; assert.equal((await c.simulate(swapTx())).receipt.status, 'reverted');
});

test('submit: success, already-processed = success, unknown blockhash = permanent rejection, transport failure = RpcError (ack may be lost), wrong signature refused', async () => {
  const s = new Script(); const c = mkChain(s); const tx = { ...swapTx(), hash: 'SIG1', raw: 'AAAA' } as SimTx;
  s.h.sendTransaction = () => 'SIG1'; assert.equal(await c.submit(tx), 'SIG1');
  s.h.sendTransaction = () => { throw new SolJsonRpcError('Transaction simulation failed: This transaction has already been processed'); }; assert.equal(await c.submit(tx), 'SIG1');
  s.h.sendTransaction = () => { throw new SolJsonRpcError('Transaction simulation failed: Blockhash not found'); };
  await assert.rejects(c.submit(tx), (e: Error) => !(e instanceof RpcError) && /can never land/.test(e.message));
  s.h.sendTransaction = () => { throw new Error('socket hang up'); }; await assert.rejects(c.submit(tx), RpcError);
  s.h.sendTransaction = () => 'OTHER'; await assert.rejects(c.submit(tx), /refusing to track/);
  await assert.rejects(c.submit({ ...tx, raw: undefined } as SimTx), /not prepared/);
});

test('lookup: found -> included; just sent but not yet visible -> pending (no pointless resend); absent after the grace -> none', async () => {
  const s = new Script(); const c = mkChain(s); const tx = { ...swapTx(), hash: 'SIGX', raw: 'AAAA' } as SimTx;
  s.h.getSignatureStatuses = () => ({ value: [null] }); s.h.sendTransaction = () => 'SIGX';
  assert.equal(await c.lookup('SIGX'), 'none'); await c.submit(tx); assert.equal(await c.lookup('SIGX'), 'pending');
  SolanaChain.VISIBILITY_GRACE_MS = 0; try { assert.equal(await c.lookup('SIGX'), 'none'); } finally { SolanaChain.VISIBILITY_GRACE_MS = 4000; }
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 5, confirmations: 3, err: null, confirmationStatus: 'confirmed' }] }); assert.equal(await c.lookup('SIGX'), 'included');
});

test('confirmations follow Solana commitment: finalized/rooted = the finality depth, confirmed = node count capped below it, unseen = 0', async () => {
  const s = new Script(); const c = mkChain(s);
  s.h.getSignatureStatuses = () => ({ value: [null] }); assert.equal(await c.confirmations('a'), 0);
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 1, confirmations: 5, err: null, confirmationStatus: 'confirmed' }] }); assert.equal(await c.confirmations('a'), 6);
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 1, confirmations: 400, err: null, confirmationStatus: 'confirmed' }] }); assert.equal(await c.confirmations('a'), c.finalityDepth - 1);
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: 'finalized' }] }); assert.equal(await c.confirmations('a'), c.finalityDepth);
});

const txJson = (o: any) => ({ slot: 77, transaction: { message: { accountKeys: [W, 'x', 'y'] } }, meta: { fee: 5000, err: null, logMessages: ['done'], preBalances: [10_000_000_000, 0, 0], postBalances: [8_997_955_720, 0, 0], preTokenBalances: [], postTokenBalances: [], ...o } });
test('receipt (buy): deltas from pre/post balances; network = fee + rent of the token account the tx left open; received is the token delta; venue fee derived', async () => {
  const s = new Script(); const c = mkChain(s);
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 77, confirmations: null, err: null, confirmationStatus: 'finalized' }] });
  s.h.getMinimumBalanceForRentExemption = () => 2_039_280;
  s.h.getTransaction = () => txJson({ postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: W, uiTokenAmount: { amount: '148000000' } }] });
  const r = (await c.receipt('SIG'))!;
  assert.equal(r.status, 'success'); assert.equal(r.deltas[USDC], 148_000_000n); assert.equal(r.deltas[NATIVE], 8_997_955_720n - 10_000_000_000n);
  assert.equal(r.network, 5000n + 2_039_280n);
  const spent = -r.deltas[NATIVE] - r.network; assert.equal(spent, 10n ** 9n); assert.equal(r.venueFee, 10n ** 9n * 25n / 10_000n);
});

test('receipt: failed program execution -> reverted with the error and last log, only the fee charged; unseen -> undefined', async () => {
  const s = new Script(); const c = mkChain(s);
  s.h.getSignatureStatuses = () => ({ value: [null] }); assert.equal(await c.receipt('SIG'), undefined);
  s.h.getSignatureStatuses = () => ({ value: [{ slot: 77, confirmations: 1, err: { InstructionError: [4, { Custom: 30 }] }, confirmationStatus: 'confirmed' }] });
  s.h.getTransaction = () => txJson({ err: { InstructionError: [4, { Custom: 30 }] }, postBalances: [9_999_995_000, 0, 0], logMessages: ['a', 'exceeds desired slippage limit'] });
  const r = (await c.receipt('SIG'))!; assert.equal(r.status, 'reverted'); assert.match(r.reason!, /slippage/); assert.equal(r.network, 5000n); assert.equal(r.deltas[NATIVE], -5000n);
});

test('Raydium venue: quote, impact, swap updates reserves, clone is independent, a not-open pool supports nothing', () => {
  const k = keysOf(), v = new RaydiumVenue('p', k, WSOL, USDC, 1000n * 10n ** 9n, 150_000n * 10n ** 6n, 25n, 10_000n, WSOL, true);
  const q = v.quote(NATIVE, USDC, 10n ** 9n); assert.ok(q.amountOut > 0n && q.amountOut < 150n * 10n ** 6n); assert.ok(q.priceImpactBps >= 0); assert.equal(q.liquidity, 1000n * 10n ** 9n);
  const c = v.clone(); v.swap(NATIVE, USDC, 10n ** 9n); assert.equal(c.baseReserve, 1000n * 10n ** 9n); assert.ok(v.baseReserve > c.baseReserve);
  assert.ok(v.spotPriceE18(USDC, NATIVE) < c.spotPriceE18(USDC, NATIVE) * 2n);
  assert.ok(!v.supports(NATIVE, W)); assert.ok(!new RaydiumVenue('p', k, WSOL, USDC, 1n, 1n, 25n, 10_000n, WSOL, false).supports(NATIVE, USDC));
  assert.throws(() => v.quote(NATIVE, W, 1n), /unsupported/);
});

test('pool decode refuses an account of the wrong size; instruction helpers have the documented discriminators', () => {
  assert.throws(() => decodePoolState(Buffer.alloc(100)), /layout mismatch/);
  assert.deepEqual([...setComputeUnitLimit(300_000).data.subarray(0, 1)], [2]); assert.deepEqual([...setComputeUnitPrice(5n).data.subarray(0, 1)], [3]);
  assert.deepEqual([...closeAccount(W, W, W).data], [9]); assert.equal(systemTransfer(W, USDC, 5n).data.length, 12);
  assert.ok(compileLegacy(W, [systemTransfer(W, USDC, 1n)]).length > 0);
});

test('balanceOf: native from getBalance, token = sum of the owner\'s token accounts', async () => {
  const s = new Script(); const c = mkChain(s);
  s.h.getBalance = () => ({ value: 42 }); assert.equal(await c.balanceOf(W, NATIVE), 42n);
  s.h.getTokenAccountsByOwner = () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '5' } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: '7' } } } } } }] });
  assert.equal(await c.balanceOf(W, USDC), 12n);
});
