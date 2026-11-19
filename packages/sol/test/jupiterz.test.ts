/** JupiterZ RFQ gate and engine path, against a transaction recorded from Jupiter's live /order (jupiterzfixture.json: TSLAx, 1,343.8 SOL in, taker = a public exchange wallet,
 *  read-only, never signed). Engine tests re-address that same transaction to a local dev wallet (we hold no key for the recorded taker) and move its expiry forward. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gateRfq, decodeFill, fetchRfqOrder, encodeRfqRaw, decodeRfqRaw, rfqWire, splitWire, JUPITERZ } from '../src/jupiterz.ts';
import type { RfqGateCtx } from '../src/jupiterz.ts';
import { parseMessage, resolveMessage, compileV0, unsignedV0, JupiterRefused, JupiterVenue } from '../src/jupiterswap.ts';
import type { JIx } from '../src/jupiterswap.ts';
import { ataAddress, PROGRAMS, base58, systemTransfer, findProgramAddress, pubkeyBytes } from '../src/tx.ts';
import { DevSolSigner, verifySignature } from '../src/signer.ts';
import { SolanaChain } from '../src/solchain.ts';
import { PrivyApi, PrivySolSigner } from '../src/privysigner.ts';
import { SignRequestError } from '../src/remotesigner.ts';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import { fakePrivy } from './fakeprivy.ts';

const F = JSON.parse(readFileSync(new URL('./jupiterzfixture.json', import.meta.url), 'utf8'));
const WSOL = 'So11111111111111111111111111111111111111112', TSLA = F.outputMint as string, MAKER = F.maker as string, TAKER = F.taker as string;
const wire = () => Uint8Array.from(Buffer.from(F.transaction, 'base64'));
const prog = (m: string) => (m === TSLA ? PROGRAMS.token2022 : PROGRAMS.token);
const ctx = (o: Partial<RfqGateCtx> = {}): RfqGateCtx => ({ wallet: TAKER, maker: MAKER, wsol: WSOL, inMint: WSOL, outMint: TSLA, amountIn: BigInt(F.inAmount), minOut: BigInt(F.outAmount), tokenProgram: prog, nowSec: Number(F.expireAt) - 30, ...o });
const ixsOf = (w: Uint8Array) => resolveMessage(parseMessage(splitWire(w).message), []);
const rebuild = (ixs: JIx[], payer = MAKER) => unsignedV0(compileV0(payer, ixs, new Uint8Array(32).fill(7), []));
const fillIx = (ixs: JIx[]) => ixs.find(i => i.programId === JUPITERZ.orderEngine)!;
const setU64 = (d: Uint8Array, off: number, v: bigint) => { const c = Uint8Array.from(d); new DataView(c.buffer).setBigUint64(off, v, true); return c; };
const refused = (w: Uint8Array, re: RegExp, o: Partial<RfqGateCtx> = {}) => assert.throws(() => gateRfq(w, ctx(o)), (e: any) => e instanceof JupiterRefused && re.test(e.message));

test('the recorded RFQ transaction: maker pays and signs slot 0, the user slot 1, one Order Engine fill for exactly the quoted amounts', () => {
  const pm = parseMessage(splitWire(wire()).message);
  assert.equal(pm.signers, 2); assert.equal(pm.staticKeys[0], MAKER); assert.equal(pm.staticKeys[1], TAKER); assert.equal(F.signatureFeePayer, MAKER);
  const g = gateRfq(wire(), ctx());
  assert.equal(g.fill.inputAmount, BigInt(F.inAmount)); assert.equal(g.fill.outputAmount, BigInt(F.outAmount)); assert.equal(g.fill.expireAt, Number(F.expireAt)); assert.equal(g.fill.feeBps, F.feeBps);
  assert.deepEqual(g.createdTokenAccounts, [ataAddress(TAKER, TSLA, PROGRAMS.token2022)]);
  assert.deepEqual(g.ixs.map(i => i.programId), ['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', PROGRAMS.ata, JUPITERZ.orderEngine]);
  // the same instructions compiled by us gate the same way (the tampering tests below rely on this)
  assert.equal(gateRfq(rebuild(g.ixs), ctx()).fill.outputAmount, BigInt(F.outAmount));
});

test('the gate refuses wrong amounts, an expired or far-off quote, and a different wallet, maker or pair', () => {
  refused(wire(), /spends .* the trade is for/, { amountIn: BigInt(F.inAmount) - 1n });
  refused(wire(), /below the minimum/, { minOut: BigInt(F.outAmount) + 1n });
  refused(wire(), /expired/, { nowSec: Number(F.expireAt) });
  refused(wire(), /more than allowed/, { nowSec: Number(F.expireAt) - 600 });
  refused(wire(), /not the second signer/, { wallet: new DevSolSigner().add() });
  refused(wire(), /not the quote's maker/, { maker: new DevSolSigner().add() });
  refused(wire(), /different pair|not ours|only token account/, { outMint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' });
  refused(wire(), /token program|only token account/, { tokenProgram: () => PROGRAMS.token });
});

test('the gate refuses changed fill data, extra instructions, extra signers, a redirected output and a pre-signed transaction', () => {
  const base = () => ixsOf(wire());
  // the fill moves more SOL than the trade
  let x = base(); fillIx(x).data = setU64(fillIx(x).data, 8, BigInt(F.inAmount) + 1n); refused(rebuild(x), /spends/);
  // not a fill (wrong discriminator) / wrong length
  x = base(); fillIx(x).data = Uint8Array.from(fillIx(x).data); fillIx(x).data[0] ^= 1; refused(rebuild(x), /not a fill/);
  x = base(); fillIx(x).data = fillIx(x).data.subarray(0, 30); refused(rebuild(x), /bytes/);
  // a System transfer out of our wallet is added
  x = base(); const t = systemTransfer(TAKER, MAKER, 1n); x.splice(2, 0, { programId: t.program, data: t.data, accounts: t.keys.map(k => ({ pubkey: k.pubkey, isSigner: !!k.signer, isWritable: !!k.writable })) }); refused(rebuild(x), /not allowed in an RFQ/);
  // a second fill
  x = base(); x.push({ ...fillIx(x) }); refused(rebuild(x), /more than one fill/);
  // a third signer
  x = base(); const third = new DevSolSigner().add(); fillIx(x).accounts.push({ pubkey: third, isSigner: true, isWritable: false }); refused(rebuild(x), /exactly two signers/);
  // the output is paid to someone else's token account
  x = base(); const evil = ataAddress(MAKER, TSLA, PROGRAMS.token2022); fillIx(x).accounts[4] = { pubkey: evil, isSigner: false, isWritable: true }; refused(rebuild(x), /not ours/);
  // the input comes from our wrapped-SOL account instead of the wallet (a path we never use)
  x = base(); fillIx(x).accounts[2] = { pubkey: ataAddress(TAKER, WSOL), isSigner: false, isWritable: true }; refused(rebuild(x), /input from an account/);
  // our own account named as the maker's
  x = base(); fillIx(x).accounts[3] = { pubkey: ataAddress(TAKER, WSOL), isSigner: false, isWritable: true }; refused(rebuild(x), /maker's account/);
  // an extra account that is not the maker's temporary wSOL PDA, then the real PDA (accepted)
  x = base(); fillIx(x).accounts.push({ pubkey: new DevSolSigner().add(), isSigner: false, isWritable: true }); refused(rebuild(x), /extra account/);
  x = base(); fillIx(x).accounts.push({ pubkey: findProgramAddress([Buffer.from(JUPITERZ.tempWsolSeed), pubkeyBytes(MAKER)], JUPITERZ.orderEngine).address, isSigner: false, isWritable: true }); assert.ok(gateRfq(rebuild(x), ctx()).fill);
  // a token account created for another owner
  x = base(); const a = x.find(i => i.programId === PROGRAMS.ata)!; a.accounts[2] = { pubkey: MAKER, isSigner: false, isWritable: false }; refused(rebuild(x), /only token account allowed/);
  // the fee payer is our wallet, not the maker
  refused(rebuild(base(), TAKER), /fee payer/);
  // arrived already signed
  const w = wire(); w[5] = 1; refused(w, /already signed/);
});

test('fill decoding, the stored raw form and the user-slot wire', () => {
  const f = decodeFill(fillIx(ixsOf(wire())).data); assert.equal(f.inputAmount, 1343800556840n); assert.equal(f.outputAmount, 26025356053n); assert.equal(f.expireAt, 1795005396);
  const raw = encodeRfqRaw('req-1', 123, Uint8Array.of(1, 2, 3)); assert.deepEqual(decodeRfqRaw(raw), { requestId: 'req-1', expireAt: 123, wire: 'AQID' }); assert.equal(decodeRfqRaw('AQID'), undefined);
  const m = splitWire(wire()).message, sig = new Uint8Array(64).fill(9), out = rfqWire(Uint8Array.from(m), 1, sig), s = splitWire(out);
  assert.ok(s.sigs[0].every(b => b === 0)); assert.deepEqual(Array.from(s.sigs[1]), Array.from(sig)); assert.deepEqual(Array.from(s.message), Array.from(m));
});

test('fetchRfqOrder asks for JupiterZ only and returns none (not an error) when another router wins or no transaction is built', async () => {
  let url = '';
  const ok = await fetchRfqOrder({ inputMint: WSOL, outputMint: TSLA, amount: BigInt(F.inAmount), taker: TAKER, fetchFn: (async (u: string) => { url = u; return new Response(JSON.stringify(F)); }) as any });
  assert.match(url, /excludeRouters=metis%2Cdflow%2Cokx/); assert.ok(!('none' in ok) && ok.maker === MAKER && ok.outAmount === BigInt(F.outAmount));
  const metis = await fetchRfqOrder({ inputMint: WSOL, outputMint: TSLA, amount: 1n, taker: TAKER, fetchFn: (async () => new Response(JSON.stringify({ ...F, router: 'metis' }))) as any });
  assert.ok('none' in metis);
  const empty = await fetchRfqOrder({ inputMint: WSOL, outputMint: TSLA, amount: BigInt(F.inAmount), taker: TAKER, fetchFn: (async () => new Response(JSON.stringify({ ...F, transaction: '', errorCode: 1, errorMessage: 'Insufficient balance' }))) as any });
  assert.ok('none' in empty && /Insufficient balance/.test(empty.none));
  await assert.rejects(fetchRfqOrder({ inputMint: WSOL, outputMint: TSLA, amount: BigInt(F.inAmount), taker: MAKER, fetchFn: (async () => new Response(JSON.stringify(F))) as any }), /different taker/);
});

/* ---------------- engine path: SolanaChain with a fake node and a fake Jupiter ---------------- */
/** The recorded transaction re-addressed to `wallet` (and its token account), with the fill's expiry set to `expireAt`. */
function retarget(wallet: string, expireAt: number) {
  const oldAta = ataAddress(TAKER, TSLA, PROGRAMS.token2022), newAta = ataAddress(wallet, TSLA, PROGRAMS.token2022);
  const ixs = ixsOf(wire()).map(i => ({ ...i, accounts: i.accounts.map(a => ({ ...a, pubkey: a.pubkey === TAKER ? wallet : a.pubkey === oldAta ? newAta : a.pubkey })) }));
  const f = fillIx(ixs); const d = Uint8Array.from(f.data); new DataView(d.buffer).setBigInt64(24, BigInt(expireAt), true); f.data = d;
  return rebuild(ixs);
}
function world(o: { better?: boolean; execute?: (body: any) => any } = {}) {
  const signer = new DevSolSigner(), wallet = signer.add(randomBytes(32)), now = Math.floor(Date.now() / 1000), expireAt = now + 40;
  const tx = retarget(wallet, expireAt), outAta = ataAddress(wallet, TSLA, PROGRAMS.token2022), inAmount = BigInt(F.inAmount), out = BigInt(F.outAmount);
  const s = { executes: [] as any[], landed: new Map<string, any>(), sims: 0 };
  const fetchFn = (async (u: string, init?: any) => {
    if (u.includes('/swap/v2/build')) return new Response(JSON.stringify({ inputMint: WSOL, outputMint: TSLA, inAmount: inAmount.toString(), outAmount: (o.better === false ? out : out * 990n / 1000n).toString(), otherAmountThreshold: '1', slippageBps: 50, transactionVersion: 0, swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' } }));
    if (u.includes('/swap/v2/order')) return new Response(JSON.stringify({ ...F, taker: wallet, expireAt: String(expireAt), transaction: Buffer.from(tx).toString('base64') }));
    if (u.includes('/swap/v2/execute')) { const b = JSON.parse(init.body); s.executes.push(b); return new Response(JSON.stringify(o.execute ? o.execute(b) : land(b))); }
    throw new Error('unexpected url ' + u);
  }) as any;
  /** what Jupiter would do on success: the maker signs slot 0 and the transaction lands */
  const land = (b: any) => { const w = splitWire(Uint8Array.from(Buffer.from(b.signedTransaction, 'base64'))); const makerSig = base58(randomBytes(64)), userSig = base58(w.sigs[1]); s.landed.set(makerSig, { userSig, blockTime: now }); return { status: 'Success', code: 0, signature: makerSig }; };
  const acct = (owner: string, lamports: number, data = Buffer.alloc(0)) => ({ owner, lamports, data: [data.toString('base64'), 'base64'] });
  const tokenData = (amt: bigint) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(amt, 64); return d; };
  const rpc = { async call(method: string, p: any[] = []): Promise<any> {
    switch (method) {
      case 'getMultipleAccounts': return { value: (p[0] as string[]).map(k => p[1]?.encoding === 'jsonParsed' ? null : k === WSOL ? acct(PROGRAMS.token, 1) : k === TSLA ? acct(PROGRAMS.token2022, 1) : k === wallet ? acct(PROGRAMS.system, 2_000_000_000_000) : null) };
      case 'simulateTransaction': { s.sims++; const ok = parseMessage(splitWire(Buffer.from(p[0], 'base64')).message).staticKeys[1] === wallet; return { value: { err: ok ? null : 'x', unitsConsumed: 40_000, accounts: [acct(PROGRAMS.system, Number(2_000_000_000_000n - inAmount - 2_039_280n)), acct(PROGRAMS.token2022, 2_039_280, tokenData(out))] } }; }
      case 'getMinimumBalanceForRentExemption': return 2_039_280;
      case 'getSignatureStatuses': return { value: [s.landed.has(p[0][0]) ? { slot: 9, confirmations: null, err: null, confirmationStatus: 'finalized' } : null] };
      case 'getSignaturesForAddress': return [...s.landed].map(([signature, v]) => ({ signature, blockTime: v.blockTime }));
      case 'getTransaction': { const v = s.landed.get(p[0]); if (!v) return null;
        return { slot: 9, transaction: { signatures: [p[0], v.userSig], message: { accountKeys: [MAKER, wallet, outAta] } }, meta: { err: null, fee: 5000, preBalances: [1e9, 2_000_000_000_000, 0], postBalances: [1e9 - 5000, Number(2_000_000_000_000n - inAmount - 2_039_280n), 2_039_280], preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint: TSLA, owner: wallet, uiTokenAmount: { amount: out.toString() } }] } }; }
      default: throw new Error('unexpected rpc ' + method);
    }
  } };
  const chain = new SolanaChain({ id: 'sol', wsol: WSOL, pools: [], jupiter: { pairs: [], fetchFn }, jupiterz: { minLamports: 100_000_000_000n, marginBps: 20, fetchFn } }, rpc as any, signer);
  chain.time = now; chain.state.venues.set('jup:So1111>XsDoVf', new JupiterVenue('jup:So1111>XsDoVf', WSOL, TSLA, WSOL, inAmount, out, 10));
  const simtx = (amountIn = inAmount): any => ({ hash: '', wallet, nonce: 0, venue: 'jup:So1111>XsDoVf', tokenIn: NATIVE, tokenOut: TSLA, amountIn, minOut: out * 995n / 1000n, deadline: now + 600, platformFeeBps: 0, kind: 'swap' });
  return { chain, wallet, s, simtx, now, expireAt, out, tx };
}

test('engine: RFQ is chosen when it beats /build by the margin; the user signs slot 1; /execute lands it once; the receipt reads the wallet from slot 1', async () => {
  const w = world(), tx = w.simtx();
  const p = await w.chain.prepare(tx); tx.hash = p.hash; tx.raw = p.raw;
  assert.match(p.raw, /^jupz1:/); assert.match(w.chain.rfqNote ?? '', /JupiterZ used/);
  const z = decodeRfqRaw(p.raw)!, sw = splitWire(Uint8Array.from(Buffer.from(z.wire, 'base64')));
  assert.ok(sw.sigs[0].every(b => b === 0), 'the maker slot is left for the maker'); assert.ok(verifySignature(w.wallet, sw.message, sw.sigs[1])); assert.equal(base58(sw.sigs[1]), p.hash);
  assert.deepEqual(Array.from(sw.message), Array.from(splitWire(w.tx).message), 'the message is signed exactly as Jupiter sent it');
  assert.equal(await w.chain.lookup(tx.hash), 'none');   // prepared, not sent yet
  assert.equal(await w.chain.submit(tx), tx.hash); assert.equal(w.s.executes.length, 1); assert.equal(w.s.executes[0].requestId, F.requestId);
  assert.equal(await w.chain.lookup(tx.hash), 'included');
  const rc = (await w.chain.receipt(tx.hash))!;
  assert.equal(rc.status, 'success'); assert.equal(rc.hash, tx.hash); assert.equal(rc.deltas[TSLA], w.out); assert.equal(rc.deltas[NATIVE], -(BigInt(F.inAmount) + 2_039_280n));
  assert.equal(rc.network, 2_039_280n, 'the maker paid the network fee; only the new token account rent is ours');
  assert.equal(await w.chain.confirmations(tx.hash), w.chain.finalityDepth);
  // a resend after landing does not call /execute again
  assert.equal(await w.chain.submit(tx), tx.hash); assert.equal(w.s.executes.length, 1);
});

test('engine: below the threshold, not better by the margin, or with a platform fee, the normal /build path is used (no RFQ signature)', async () => {
  for (const [w, tx, re] of [[world(), undefined, /below the RFQ threshold/], [world({ better: false }), undefined, /not 20 bps better/]] as const) {
    const t = tx ?? (re.source.includes('threshold') ? w.simtx(1_000_000_000n) : w.simtx());
    await assert.rejects(w.chain.prepare(t));   // the /build fallback cannot build from the stub route: what matters is that RFQ was not taken
    assert.match(w.chain.rfqNote ?? '', re); assert.equal(w.s.executes.length, 0);
  }
  const w = world(), t = { ...w.simtx(), platformFeeBps: 50 };
  await assert.rejects(w.chain.prepare(t)); assert.match(w.chain.rfqNote ?? '', /platform fee|SOL on one side|fee/);
});

test('engine: a stock share-price refusal (checkFill) stops RFQ before anything is signed', async () => {
  const w = world(); (w.chain as any).cfg.jupiterz.checkFill = async () => 'this route pays $500 per share against a share price of $400';
  await assert.rejects(w.chain.prepare(w.simtx())); assert.match(w.chain.rfqNote ?? '', /per share/);
});

test('engine: a stock sell whose pool minOut is below the threshold is sized by the maker output when sizeByQuote says so', async () => {
  const sell = (w: ReturnType<typeof world>, minOut: bigint): any => { w.chain.state.venues.set('jup:XsDoVf>So1111', new JupiterVenue('jup:XsDoVf>So1111', TSLA, WSOL, WSOL, w.out, BigInt(F.inAmount), 10));
    return { ...w.simtx(), venue: 'jup:XsDoVf>So1111', tokenIn: TSLA, tokenOut: NATIVE, amountIn: w.out, minOut }; };
  // without sizeByQuote: the pool's low minOut keeps RFQ off, nothing asked
  const a = world(); await assert.rejects(a.chain.prepare(sell(a, 1_000_000n))); assert.match(a.chain.rfqNote ?? '', /below the RFQ threshold/);
  // with it: the maker is asked; a maker output below the threshold still keeps RFQ off
  const b = world(), asked: string[] = []; (b.chain as any).cfg.jupiterz.sizeByQuote = (t: any) => t.tokenIn === TSLA;
  const f = (async (u: string) => { asked.push(u);
    if (u.includes('/swap/v2/build')) return new Response(JSON.stringify({ inputMint: TSLA, outputMint: WSOL, inAmount: b.out.toString(), outAmount: '1000', otherAmountThreshold: '1', slippageBps: 50, transactionVersion: 0, swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' } }));
    return new Response(JSON.stringify({ ...F, inputMint: TSLA, outputMint: WSOL, inAmount: b.out.toString(), outAmount: '5000000000', taker: b.wallet, expireAt: String(b.expireAt), transaction: Buffer.from(b.tx).toString('base64') })); }) as any;
  (b.chain as any).cfg.jupiterz.fetchFn = f; (b.chain as any).cfg.jupiter.fetchFn = f;
  await assert.rejects(b.chain.prepare(sell(b, 1_000_000n))); assert.ok(asked.some(u => u.includes('/swap/v2/order')), 'the maker was asked');
  assert.match(b.chain.rfqNote ?? '', /the maker pays 5000000000 lamports, below the RFQ threshold 100000000000/); assert.equal(b.s.executes.length, 0);
  // not a stock sell (sizeByQuote false): unchanged
  (b.chain as any).cfg.jupiterz.sizeByQuote = () => false; asked.length = 0;
  await assert.rejects(b.chain.prepare(sell(b, 1_000_000n))); assert.equal(asked.filter(u => u.includes('/swap/v2/order')).length, 0); assert.match(b.chain.rfqNote ?? '', /below the RFQ threshold/);
});

test('engine: a failed /execute before the quote expires is an unknown outcome (RpcError, looked up again); after expiry and not on chain it is final', async () => {
  const w = world({ execute: () => ({ status: 'Failed', code: -2000, error: 'Failed to land' }) }), tx = w.simtx();
  const p = await w.chain.prepare(tx); tx.hash = p.hash; tx.raw = p.raw;
  await assert.rejects(w.chain.submit(tx), (e: any) => e instanceof RpcError && /may still land/.test(e.message));
  await assert.rejects(w.chain.submit(tx), (e: any) => e instanceof RpcError);
  assert.equal(w.s.executes.length, 2); assert.equal(w.s.executes[0].signedTransaction, w.s.executes[1].signedTransaction, 'identical bytes every time');
  w.chain.time = w.expireAt + 31;
  await assert.rejects(w.chain.submit(tx), (e: any) => !(e instanceof RpcError) && /can never land/.test(e.message));
});

test('engine: after a restart (no memory of the trade) a landed RFQ fill is found by the user signature and not sent again', async () => {
  const w = world(), tx = w.simtx();
  const p = await w.chain.prepare(tx); tx.hash = p.hash; tx.raw = p.raw; await w.chain.submit(tx);
  // a new SolanaChain over the same node: only the engine's stored raw and hash survive
  const fresh = new SolanaChain({ id: 'sol', wsol: WSOL, pools: [], jupiterz: { minLamports: 1n, marginBps: 0, fetchFn: (async () => { throw new Error('must not call Jupiter'); }) as any } }, (w.chain as any).rpc, new DevSolSigner());
  fresh.time = w.now;
  assert.equal(await fresh.submit(tx), tx.hash, 'found on chain: /execute is not called');
  assert.equal(await fresh.lookup(tx.hash), 'included'); assert.equal((await fresh.receipt(tx.hash))!.deltas[TSLA], w.out);
});

test('Privy signs the user slot of an RFQ transaction (slot 1), and refuses while the policy lacks the Order Engine program', async () => {
  const seed = randomBytes(32), refusing = fakePrivy({ seed }), allowing = fakePrivy({ seed, extraPrograms: [JUPITERZ.orderEngine] });
  const msg = Uint8Array.from(splitWire(retarget(allowing.address, Math.floor(Date.now() / 1000) + 40)).message);
  const sig = await new PrivySolSigner(new PrivyApi({ ...allowing.cfg, fetchFn: allowing.fetchFn }), new Map([[allowing.address, 'wallet-1']])).sign(allowing.address, msg);
  assert.ok(verifySignature(allowing.address, msg, sig));
  await assert.rejects(new PrivySolSigner(new PrivyApi({ ...refusing.cfg, fetchFn: refusing.fetchFn }), new Map([[refusing.address, 'wallet-1']])).sign(refusing.address, msg),
    (e: any) => e instanceof SignRequestError && /61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH is not allowed.*nothing was sent/.test(e.message));
  // a message that does not ask this wallet to sign is refused before Privy is asked
  const other = Uint8Array.from(splitWire(wire()).message);
  await assert.rejects(new PrivySolSigner(new PrivyApi({ ...allowing.cfg, fetchFn: allowing.fetchFn }), new Map([[allowing.address, 'wallet-1']])).sign(allowing.address, other), /does not ask this wallet/);
});

/* ---------------- USDC as the quote asset (market makers quote stocks closest against USDC) ---------------- */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const tp = (m: string) => (m === TSLA ? PROGRAMS.token2022 : PROGRAMS.token);
/** The recorded fill re-shaped as USDC -> TSLAx (`usdc-in`) or TSLAx -> USDC (`usdc-out`), for `wallet`, with these amounts and expiry. Same programs and layout. */
function usdcVariant(kind: 'usdc-in' | 'usdc-out', wallet: string, amountIn: bigint, amountOut: bigint, expireAt: number) {
  const [inM, outM] = kind === 'usdc-in' ? [USDC, TSLA] : [TSLA, USDC];
  const ixs = ixsOf(wire()).map(i => ({ ...i, accounts: i.accounts.map(a => ({ ...a, pubkey: a.pubkey === TAKER ? wallet : a.pubkey })) }));
  const ata = ixs.find(i => i.programId === PROGRAMS.ata)!;
  ata.accounts = [wallet, ataAddress(wallet, outM, tp(outM)), wallet, outM, PROGRAMS.system, tp(outM)].map((k, n) => ({ pubkey: k, isSigner: n === 0, isWritable: n < 2 }));
  const f = fillIx(ixs), k = (pubkey: string, w = true) => ({ pubkey, isSigner: false, isWritable: w });
  f.accounts.splice(2, 8, k(ataAddress(wallet, inM, tp(inM))), k(ataAddress(MAKER, inM, tp(inM))), k(ataAddress(wallet, outM, tp(outM))), k(ataAddress(MAKER, outM, tp(outM))),
    k(inM, false), k(tp(inM), false), k(outM, false), k(tp(outM), false));
  const d = Uint8Array.from(f.data), v = new DataView(d.buffer); v.setBigUint64(8, amountIn, true); v.setBigUint64(16, amountOut, true); v.setBigInt64(24, BigInt(expireAt), true); f.data = d;
  return { wire: rebuild(ixs), ixs, inM, outM };
}

test('the gate accepts a USDC-in and a stock-to-USDC fill, and refuses one that pays someone else or takes from another USDC account', () => {
  const exp = Number(F.expireAt), now = exp - 30;
  for (const kind of ['usdc-in', 'usdc-out'] as const) {
    const amtIn = kind === 'usdc-in' ? 100_000_000_000n : 26_000_000_000n, amtOut = kind === 'usdc-in' ? 26_000_000_000n : 99_000_000_000n;
    const v = usdcVariant(kind, TAKER, amtIn, amtOut, exp), c = { wallet: TAKER, maker: MAKER, wsol: WSOL, inMint: v.inM, outMint: v.outM, amountIn: amtIn, minOut: amtOut, tokenProgram: tp, nowSec: now };
    const g = gateRfq(v.wire, c); assert.equal(g.fill.inputAmount, amtIn); assert.deepEqual(g.createdTokenAccounts, [ataAddress(TAKER, v.outM, tp(v.outM))]);
    // output to the maker's account instead of ours
    const x1 = usdcVariant(kind, TAKER, amtIn, amtOut, exp); fillIx(x1.ixs).accounts[4] = { pubkey: ataAddress(MAKER, v.outM, tp(v.outM)), isSigner: false, isWritable: true };
    assert.throws(() => gateRfq(rebuild(x1.ixs), c), /not ours/);
    // input from a USDC/stock account that is not our own associated account
    const x2 = usdcVariant(kind, TAKER, amtIn, amtOut, exp); fillIx(x2.ixs).accounts[2] = { pubkey: new DevSolSigner().add(), isSigner: false, isWritable: true };
    assert.throws(() => gateRfq(rebuild(x2.ixs), c), /input from an account/);
    // the right shape but checked as if it were a SOL trade: refused
    assert.throws(() => gateRfq(v.wire, { ...c, inMint: kind === 'usdc-in' ? WSOL : v.inM, outMint: kind === 'usdc-in' ? v.outM : WSOL }));
  }
});

test('engine: USDC -> TSLAx through RFQ when USDC is a listed quote asset (threshold in USDC), and not when it is not listed', async () => {
  const signer = new DevSolSigner(), wallet = signer.add(randomBytes(32)), now = Math.floor(Date.now() / 1000), expireAt = now + 40;
  const amtIn = 100_000_000_000n, out = 26_000_000_000n, v = usdcVariant('usdc-in', wallet, amtIn, out, expireAt);
  const inAta = ataAddress(wallet, USDC), outAta = ataAddress(wallet, TSLA, PROGRAMS.token2022), rent = 2_039_280n, executes: any[] = [];
  const order = { ...F, inputMint: USDC, outputMint: TSLA, inAmount: amtIn.toString(), outAmount: out.toString(), taker: wallet, expireAt: String(expireAt), transaction: Buffer.from(v.wire).toString('base64') };
  const fetchFn = (async (u: string, init?: any) => {
    if (u.includes('/swap/v2/build')) return new Response(JSON.stringify({ inputMint: USDC, outputMint: TSLA, inAmount: amtIn.toString(), outAmount: (out * 990n / 1000n).toString(), otherAmountThreshold: '1', slippageBps: 50, transactionVersion: 0, swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' } }));
    if (u.includes('/swap/v2/order')) return new Response(JSON.stringify(order));
    if (u.includes('/swap/v2/execute')) { executes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: 'Success', code: 0, signature: base58(randomBytes(64)) })); }
    throw new Error('unexpected url ' + u);
  }) as any;
  const acct = (owner: string, lamports: bigint | number, data = Buffer.alloc(0)) => ({ owner, lamports: Number(lamports), data: [data.toString('base64'), 'base64'] });
  const tokenAcct = (amt: bigint) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(amt, 64); return d; };
  const W0 = 1_000_000_000n, U0 = 150_000_000_000n;
  const post: Record<string, any> = { [wallet]: acct(PROGRAMS.system, W0 - rent), [inAta]: acct(PROGRAMS.token, rent, tokenAcct(U0 - amtIn)), [outAta]: acct(PROGRAMS.token2022, rent, tokenAcct(out)) };
  let spendMore = 0n;
  const rpc = { async call(method: string, p: any[] = []): Promise<any> {
    if (method === 'getMultipleAccounts') return { value: (p[0] as string[]).map(k => p[1]?.encoding === 'jsonParsed' ? null : k === USDC ? acct(PROGRAMS.token, 1) : k === TSLA ? acct(PROGRAMS.token2022, 1) : k === wallet ? acct(PROGRAMS.system, W0) : k === inAta ? acct(PROGRAMS.token, rent, tokenAcct(U0)) : null) };
    if (method === 'simulateTransaction') return { value: { err: null, accounts: (p[1].accounts.addresses as string[]).map(a => a === wallet ? acct(PROGRAMS.system, W0 - rent - spendMore) : post[a] ?? null) } };
    if (method === 'getMinimumBalanceForRentExemption') return Number(rent);
    if (method === 'getSignaturesForAddress') return [];   // nothing landed yet
    throw new Error('unexpected rpc ' + method);
  } };
  const mk = (minQuote?: Record<string, bigint>) => { const c = new SolanaChain({ id: 'sol', wsol: WSOL, pools: [], jupiter: { pairs: [], fetchFn }, jupiterz: { minLamports: 100_000_000_000n, minQuote, marginBps: 20, fetchFn } }, rpc as any, signer); c.time = now; c.state.venues.set('jup:EPjFWd>XsDoVf', new JupiterVenue('jup:EPjFWd>XsDoVf', USDC, TSLA, WSOL, amtIn, out, 10)); return c; };
  const tx = (): any => ({ hash: '', wallet, nonce: 0, venue: 'jup:EPjFWd>XsDoVf', tokenIn: USDC, tokenOut: TSLA, amountIn: amtIn, minOut: out * 995n / 1000n, deadline: now + 600, platformFeeBps: 0, kind: 'swap' });
  // USDC listed with a $10k threshold: RFQ is used, the user signs slot 1, /execute lands it
  const c = mk({ [USDC]: 10_000_000_000n }), t = tx(), p = await c.prepare(t); t.hash = p.hash; t.raw = p.raw;
  assert.match(p.raw, /^jupz1:/); assert.match(c.rfqNote ?? '', /JupiterZ used/);
  assert.equal(await c.submit(t), t.hash); assert.equal(executes.length, 1);
  // below the USDC threshold, or USDC not listed: the normal route
  const c2 = mk({ [USDC]: 200_000_000_000n }); await assert.rejects(c2.prepare(tx())); assert.match(c2.rfqNote ?? '', /below the RFQ threshold/);
  const c3 = mk(); await assert.rejects(c3.prepare(tx())); assert.match(c3.rfqNote ?? '', /only with SOL/);
  // the simulation takes SOL from the wallet beyond the new-account rent: refused before signing
  spendMore = 5000n; const c4 = mk({ [USDC]: 1n }); await assert.rejects(c4.prepare(tx())); assert.match(c4.rfqNote ?? '', /more than the new-account rent/);
  // a platform fee on a USDC trade: RFQ is skipped (our fee is paid in SOL)
  const c5 = mk({ [USDC]: 1n }); await assert.rejects(c5.prepare({ ...tx(), platformFeeBps: 50 })); assert.match(c5.rfqNote ?? '', /platform fee/);
});
