import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE } from '../../core/src/index.ts';
import type { SimTx } from '../../core/src/index.ts';
import { DevSolSigner, verifySignature, SolanaChain, base58, b58decode, ataAddress, PROGRAMS, COMPUTE_BUDGET, u32le, u64le, cat, compileV0, parseMessage, resolveMessage, unsignedV0, wireV0, decodeTable, gateInstructions, JupiterRefused, JUPITER, JupiterVenue } from '../src/index.ts';
import type { JIx, Table } from '../src/index.ts';

const signer = new DevSolSigner(), W = signer.add(), USDC = signer.add(), WSOL = signer.add(), DEX = signer.add(), POOL = signer.add(), POOL2 = signer.add(), OTHER = signer.add(), EVIL = signer.add(), TBL = signer.add(), BH = base58(new Uint8Array(32).fill(5));
const acc = (pubkey: string, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const wsolAta = ataAddress(W, WSOL), usdcAta = ataAddress(W, USDC);
const cuLimit = (n: number): JIx => ({ programId: COMPUTE_BUDGET, accounts: [], data: cat(Uint8Array.of(2), u32le(n)) });
const cuPrice = (n: bigint): JIx => ({ programId: COMPUTE_BUDGET, accounts: [], data: cat(Uint8Array.of(3), u64le(n)) });
const mkAta = (mint: string, o: { owner?: string; payer?: string; token?: string } = {}): JIx => ({ programId: PROGRAMS.ata, data: Uint8Array.of(1), accounts: [acc(o.payer ?? W, true, true), acc(ataAddress(o.owner ?? W, mint), true), acc(o.owner ?? W), acc(mint), acc(PROGRAMS.system), acc(o.token ?? PROGRAMS.token)] });
const sysTransfer = (from: string, to: string, n: bigint): JIx => ({ programId: PROGRAMS.system, data: cat(u32le(2), u64le(n)), accounts: [acc(from, true, true), acc(to, true)] });
const sync = (a: string): JIx => ({ programId: PROGRAMS.token, data: Uint8Array.of(17), accounts: [acc(a, true)] });
const close = (a: string, dest = W, owner = W): JIx => ({ programId: PROGRAMS.token, data: Uint8Array.of(9), accounts: [acc(a, true), acc(dest, true), acc(owner, false, true)] });
const route = (extra: JIx['accounts'] = []): JIx => ({ programId: JUPITER.v6, data: Uint8Array.of(1, 2, 3), accounts: [acc(PROGRAMS.token), acc(W, false, true), acc(wsolAta, true), acc(usdcAta, true), acc(DEX), acc(POOL, true), acc(POOL2), ...extra] });
const goodIxs = (amount = 1_000_000_000n): JIx[] => [cuLimit(200_000), cuPrice(1000n), mkAta(WSOL), sysTransfer(W, wsolAta, amount), sync(wsolAta), mkAta(USDC), route(), close(wsolAta)];
const ctx = (o: object = {}) => ({ wallet: W, wsol: WSOL, tokenIn: WSOL, tokenOut: USDC, amountIn: 1_000_000_000n, allowedPrograms: new Set([DEX]), maxPriorityLamports: 2_000_000n, maxComputeUnits: 1_400_000, ...o });
const refused = (ixs: JIx[], re: RegExp, c = ctx()) => assert.throws(() => gateInstructions(ixs, c), (e: Error) => e instanceof JupiterRefused && re.test(e.message), String(re));
const tableAcct = (addrs: string[], deactivated = false) => { const b = Buffer.alloc(56 + 32 * addrs.length); b.writeUInt32LE(1, 0); b.writeBigUInt64LE(deactivated ? 100n : 0xffffffffffffffffn, 4); addrs.forEach((a, i) => Buffer.from(b58decode(a)).copy(b, 56 + 32 * i)); return b; };

test('v0 message: compile -> parse -> resolve returns the same instructions, flags and lookup-table accounts; the signature verifies', () => {
  const tables: Table[] = [{ key: TBL, addresses: [POOL, POOL2, OTHER] }], ixs = goodIxs();
  const msg = compileV0(W, ixs, b58decode(BH), tables), pm = parseMessage(msg);
  assert.equal(pm.version, 0); assert.equal(pm.staticKeys[0], W); assert.equal(pm.signers, 1); assert.equal(pm.blockhash, BH);
  assert.deepEqual(pm.lookups.map(l => [l.table, l.writable.length, l.readonly.length]), [[TBL, 1, 1]], 'POOL (writable) and POOL2 (readonly) load through the table; program ids and signers stay static');
  assert.ok(!pm.staticKeys.includes(POOL) && pm.staticKeys.includes(DEX));
  const back = resolveMessage(pm, tables); assert.equal(back.length, ixs.length);
  // A Solana message carries ONE flag set per account (merged over every instruction that uses it), so compare against the merged flags.
  const merged = new Map<string, { s: boolean; w: boolean }>(); for (const ix of ixs) for (const a of ix.accounts) { const m = merged.get(a.pubkey) ?? { s: false, w: false }; m.s ||= a.isSigner; m.w ||= a.isWritable; merged.set(a.pubkey, m); } merged.set(W, { s: true, w: true });
  back.forEach((b, i) => { assert.equal(b.programId, ixs[i].programId); assert.deepEqual(Buffer.from(b.data), Buffer.from(ixs[i].data)); assert.deepEqual(b.accounts.map(a => [a.pubkey, a.isSigner, a.isWritable]), ixs[i].accounts.map(a => [a.pubkey, merged.get(a.pubkey)!.s, merged.get(a.pubkey)!.w]), `ix ${i}`); });
  const sig = signer.sign(W, msg), wire = wireV0(msg, [sig]); assert.equal(wire[0], 1); assert.ok(verifySignature(W, wire.subarray(65), wire.subarray(1, 65)));
  assert.equal(Buffer.from(unsignedV0(msg)).length, 1 + 64 + msg.length); assert.throws(() => wireV0(msg, []), /needs 1 signature/);
  assert.throws(() => resolveMessage(pm, []), /not read from the chain/);
  assert.doesNotThrow(() => gateInstructions(back, ctx({ allowedPrograms: new Set([DEX]) })));
  assert.throws(() => parseMessage(cat(msg, Uint8Array.of(0))), /trailing/); assert.throws(() => parseMessage(msg.subarray(0, 40)), /truncated/);
});

test('lookup tables: only a live, well-formed table is accepted', () => {
  assert.deepEqual(decodeTable(TBL, tableAcct([POOL, POOL2])).addresses, [POOL, POOL2]);
  assert.throws(() => decodeTable(TBL, tableAcct([POOL], true)), /deactivated/); assert.throws(() => decodeTable(TBL, Buffer.alloc(57)), /unexpected size/);
  const wrong = tableAcct([POOL]); wrong.writeUInt32LE(0, 0); assert.throws(() => decodeTable(TBL, wrong), /not an initialised/);
});

test('safety gate: accepts the normal wrap -> route -> unwrap shape and reports what it created', () => {
  const r = gateInstructions(goodIxs(), ctx()); assert.equal(r.swapIndex, 6); assert.deepEqual(r.createdTokenAccounts, [wsolAta, usdcAta]); assert.equal(r.createdNonWsol, 1); assert.equal(r.computeUnitLimit, 200_000);
  assert.equal(r.priorityLamports, 200n, '1000 micro-lamports x 200k units');
});

test('safety gate: refuses everything outside the allowlist', () => {
  refused([...goodIxs(), { programId: EVIL, accounts: [], data: new Uint8Array() }], /not on the allowlist/);
  refused([...goodIxs().slice(0, 6), { ...route(), accounts: [...route().accounts, acc(EVIL, false, true)] }, close(wsolAta)], /requires a signature from/);
  refused(goodIxs().map((x, i) => (i === 3 ? sysTransfer(W, EVIL, 1_000_000_000n) : x)), /only move SOL from our wallet into our own wrapped-SOL/);
  refused(goodIxs(2_000_000_000n), /exceeds what this swap may spend/);
  refused(goodIxs(), /exceeds what this swap may spend/, ctx({ tokenIn: USDC, tokenOut: WSOL }));
  refused([...goodIxs(), { programId: PROGRAMS.token, data: cat(Uint8Array.of(3), u64le(5n)), accounts: [acc(usdcAta, true), acc(EVIL, true), acc(W, false, true)] }], /token instruction type 3/);
  refused([...goodIxs().slice(0, 7), close(wsolAta, EVIL)], /token instruction type 9/);
  refused([...goodIxs().slice(0, 7), { ...close(wsolAta), accounts: [acc(wsolAta, true), acc(W, true), acc(EVIL)] }], /token instruction type 9/);
  refused([...goodIxs().slice(0, 7), close(wsolAta, W, EVIL)], /requires a signature from/);
  refused(goodIxs().map((x, i) => (i === 5 ? mkAta(USDC, { owner: EVIL }) : x)), /by and for our wallet/);
  refused(goodIxs().map((x, i) => (i === 5 ? mkAta(USDC, { token: signer.add() }) : x)), /Token-2022 is not supported/);
  refused(goodIxs().map((x, i) => (i === 1 ? cuPrice(500_000_000n) : x)), /priority fee/);
  refused(goodIxs().map((x, i) => (i === 0 ? cuLimit(9_000_000) : x)), /compute unit limit/);
  refused([cuLimit(1), { programId: COMPUTE_BUDGET, accounts: [], data: Uint8Array.of(4, 0, 0, 0, 0) }, route()], /compute budget instruction type 4/);
  refused(goodIxs().filter(x => x.programId !== JUPITER.v6), /no Jupiter route/);
  refused([...goodIxs(), { programId: DEX, accounts: [], data: new Uint8Array() }], /only be invoked through the Jupiter aggregator/);
  refused(goodIxs().map((x, i) => (i === 3 ? { ...sysTransfer(W, wsolAta, 5n), data: cat(u32le(0), u64le(5n), u64le(0n)) } : x)), /plain System transfer/);
  refused([...goodIxs(), route()], /more than one Jupiter route/);
});

// ---- the chain flow with scripted Jupiter and RPC
class Script { calls: string[] = []; log: any[] = []; h: Record<string, (p: any[]) => any> = {}; async call(m: string, p: any[] = []) { this.calls.push(m); this.log.push([m, p]); const f = this.h[m]; if (!f) throw new Error(`unscripted ${m}`); return f(p); } }
const b64 = (b: Buffer) => [b.toString('base64'), 'base64'];
const tokAcct = (owner: string, amount: bigint) => { const b = Buffer.alloc(165); Buffer.from(b58decode(owner)).copy(b, 32); b.writeBigUInt64LE(amount, 64); return b; };
function world(o: { jup?: (url: string) => any; sim?: (p: any[]) => any; accounts?: Record<string, { lamports: number; owner: string; data: Buffer } | null>; tableOnChain?: string[] } = {}) {
  const s = new Script(), fetched: string[] = [];
  const build = (extra: any = {}) => ({ inputMint: WSOL, outputMint: USDC, inAmount: '1000000000', outAmount: '150000000', otherAmountThreshold: '149250000', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.01', transactionVersion: 0, tipInstruction: null, routePlan: [{ swapInfo: { label: 'TestDex' } }],
    computeBudgetInstructions: [wire(cuPrice(1000n))], setupInstructions: [wire(mkAta(WSOL)), wire(sysTransfer(W, wsolAta, 1_000_000_000n)), wire(sync(wsolAta)), wire(mkAta(USDC))], swapInstruction: wire(route()), cleanupInstruction: wire(close(wsolAta)), otherInstructions: [], addressesByLookupTableAddress: { [TBL]: [POOL, POOL2] }, ...extra });
  const wire = (ix: JIx) => ({ programId: ix.programId, data: Buffer.from(ix.data).toString('base64'), accounts: ix.accounts });
  const fetchFn = (async (url: string) => { fetched.push(String(url)); if (String(url).includes('program-id-to-label')) return { ok: true, status: 200, json: async () => Object.fromEntries([...Array.from({ length: 12 }, () => [signer.add(), 'x']), [DEX, 'TestDex']]) };
    const j = o.jup ? o.jup(String(url)) : build(); return { ok: true, status: 200, json: async () => j }; }) as any;
  const accounts = o.accounts ?? {}; const tableAcctData = tableAcct(o.tableOnChain ?? [POOL, POOL2]);
  s.h.getMultipleAccounts = ([addrs]) => ({ value: (addrs as string[]).map(a => a === TBL ? { lamports: 1, owner: 'AddressLookupTab1e1111111111111111111111111', data: b64(tableAcctData) } : a === W ? { lamports: 5_000_000_000, owner: PROGRAMS.system, data: b64(Buffer.alloc(0)) } : (accounts[a] ? { lamports: accounts[a]!.lamports, owner: accounts[a]!.owner, data: b64(accounts[a]!.data) } : null)) });
  s.h.getLatestBlockhash = () => ({ value: { blockhash: BH, lastValidBlockHeight: 99 } }); s.h.getMinimumBalanceForRentExemption = () => 2_039_280;
  s.h.simulateTransaction = o.sim ?? (() => ({ value: { err: null, accounts: [{ lamports: 5_000_000_000 - 1_000_000_000 - 5_200, owner: PROGRAMS.system, data: b64(Buffer.alloc(0)) }, { lamports: 1, owner: PROGRAMS.token, data: b64(tokAcct(W, 149_900_000n)) }] } }));
  const c = new SolanaChain({ id: 'sol-test', wsol: WSOL, pools: [], jupiter: { fetchFn, pairs: [] } }, s, signer); c.time = 1_800_000_000; c.block = 100;
  c.state.venues.set('jup1', new JupiterVenue('jup1', WSOL, USDC, WSOL, 10n ** 9n, 150_000_000n, 5));
  return { c, s, fetched, build };
}
const tx = (o: Partial<SimTx> = {}): SimTx => ({ hash: '', wallet: W, nonce: 0, venue: 'jup1', tokenIn: NATIVE, tokenOut: USDC, amountIn: 1_000_000_000n, minOut: 148_000_000n, deadline: 1_800_000_600, platformFeeBps: 0, ...o });

test('chain: a Jupiter swap is built from raw instructions, gated, simulated against the wallet balances, and signed as a v0 transaction', async () => {
  const { c, s, fetched } = world();
  const sim = await c.simulate(tx()); assert.equal(sim.receipt.status, 'success', sim.receipt.reason); assert.equal(sim.receipt.deltas[USDC], 149_900_000n);
  const p = await c.prepare(tx()), w = Buffer.from(p.raw, 'base64'); assert.equal(w[0], 1); const sig = w.subarray(1, 65), msg = w.subarray(65);
  assert.equal(msg[0], 0x80, 'a versioned (v0) message'); assert.ok(verifySignature(W, msg, sig)); assert.equal(p.hash, base58(sig));
  assert.ok(fetched.some(u => u.includes('/build?') && u.includes('taker=' + W) && u.includes('slippageBps=50')), 'asked Jupiter for raw instructions for OUR wallet');
  assert.ok(!s.calls.includes('sendTransaction'), 'building never sends');
  const sentSim = s.log.find(l => l[0] === 'simulateTransaction')!; assert.equal(sentSim[1][1].sigVerify, false);
});

test('chain: slippage is never looser than the engine allows: a tighter minOut makes us ask Jupiter for a tighter slippage; an impossible one is refused', async () => {
  const urls: string[] = [];
  const w1 = world({ jup: (u) => { urls.push(u); const bps = Number(new URL(u).searchParams.get('slippageBps')); const out = 150_000_000n; return { ...world().build(), otherAmountThreshold: String(out * BigInt(10_000 - bps) / 10_000n), slippageBps: bps }; } });
  const r = await w1.c.simulate(tx({ minOut: 149_850_000n }));   // engine allows only 10 bps
  assert.equal(r.receipt.status, 'success', r.receipt.reason); assert.deepEqual(urls.map(u => new URL(u).searchParams.get('slippageBps')), ['50', '10'], 'second call carries the engine\'s tighter slippage');
  const w2 = world(); const r2 = await w2.c.simulate(tx({ minOut: 151_000_000n }));
  assert.equal(r2.receipt.status, 'reverted'); assert.match(r2.receipt.reason!, /price moved/);
});

test('chain: refuses a route whose simulated output is below minOut, or that spends more than the intent', async () => {
  const low = world({ sim: () => ({ value: { err: null, accounts: [{ lamports: 4_000_000_000 - 5_200, owner: PROGRAMS.system, data: b64(Buffer.alloc(0)) }, { lamports: 1, owner: PROGRAMS.token, data: b64(tokAcct(W, 100_000n)) }] } }) });
  const a = await low.c.simulate(tx()); assert.equal(a.receipt.status, 'reverted'); assert.match(a.receipt.reason!, /simulated output 100000 is below the minimum/);
  const drain = world({ sim: () => ({ value: { err: null, accounts: [{ lamports: 1_000_000_000, owner: PROGRAMS.system, data: b64(Buffer.alloc(0)) }, { lamports: 1, owner: PROGRAMS.token, data: b64(tokAcct(W, 149_900_000n)) }] } }) });
  const b = await drain.c.simulate(tx()); assert.equal(b.receipt.status, 'reverted'); assert.match(b.receipt.reason!, /simulated SOL spend .* exceeds the intent/);
  const fail = world({ sim: () => ({ value: { err: { InstructionError: [6, 'Custom'] }, logs: ['x', 'Program failed'] } }) });
  const f = await fail.c.simulate(tx()); assert.match(f.receipt.reason!, /simulation failed.*Program failed/);
  await assert.rejects(fail.c.prepare(tx()), /simulation failed/);
});

test('chain: refuses lookup tables that differ from the chain, route instructions that touch our other token accounts, an unknown program, and a platform fee', async () => {
  const bad = world({ tableOnChain: [OTHER, POOL2] }); assert.match((await bad.c.simulate(tx())).receipt.reason!, /differs from what Jupiter described/);
  const mine = world({ accounts: { [POOL]: { lamports: 1, owner: PROGRAMS.token, data: tokAcct(W, 777n) } } }); assert.match((await mine.c.simulate(tx())).receipt.reason!, /writes our token account/);
  const evilProg = world({ jup: () => ({ ...world().build(), otherInstructions: [{ programId: EVIL, data: '', accounts: [] }] }) }); assert.match((await evilProg.c.simulate(tx())).receipt.reason!, /not on the allowlist/);
  const tip = world({ jup: () => ({ ...world().build(), tipInstruction: { programId: PROGRAMS.system, data: '', accounts: [] } }) }); assert.match((await tip.c.simulate(tx())).receipt.reason!, /tip instruction/);
  const other = world({ jup: () => ({ ...world().build(), outputMint: OTHER }) }); assert.match((await other.c.simulate(tx())).receipt.reason!, /different pair/);
  const fee = world(); assert.match((await fee.c.simulate(tx({ platformFeeBps: 100 }))).receipt.reason!, /platform fee/);
  await assert.rejects(fee.c.prepare(tx({ platformFeeBps: 100 })), /platform fee/);
});

test('chain: with no program allowlist from Jupiter we refuse rather than guess', async () => {
  const { c } = world(); (c as any).cfg.jupiter.fetchFn = (async (u: string) => ({ ok: true, status: 200, json: async () => (String(u).includes('program-id-to-label') ? { x: 'y' } : {}) })) as any;
  const r = await c.simulate(tx()); assert.equal(r.receipt.status, 'reverted'); assert.match(r.receipt.reason!, /too few programs/);
});

test('chain: a route too large for one transaction is asked for again with fewer accounts (48, 36, 28), and refused when none fits', async () => {
  // a route whose swap instruction carries 700 bytes of data pushes the signed transaction past 1,232 bytes; with maxAccounts set, Jupiter "answers" with a small one
  const wire = (ix: JIx) => ({ programId: ix.programId, data: Buffer.from(ix.data).toString('base64'), accounts: ix.accounts });
  const big = (url: string) => !/maxAccounts=(36|28)/.test(url);
  const w = world({ jup: url => { const b = world().build(); const r = route(); return { ...b, swapInstruction: wire({ ...r, data: new Uint8Array(big(url) ? 700 : 20) }) }; } });
  const p = await w.c.prepare(tx({}));
  const builds = w.fetched.filter(u => u.includes('/build'));
  assert.ok(builds.some(u => !u.includes('maxAccounts')) && builds.some(u => u.includes('maxAccounts=48')) && builds.some(u => u.includes('maxAccounts=36')), builds.map(u => u.match(/maxAccounts=\d+/)?.[0] ?? 'default').join(' > '));
  assert.ok(Buffer.from(p.raw, 'base64').length <= 1232, 'the signed transaction fits');
  const never = world({ jup: () => { const b = world().build(); return { ...b, swapInstruction: wire({ ...route(), data: new Uint8Array(700) }) }; } });
  await assert.rejects(never.c.prepare(tx({})), /every Jupiter route for this trade is too large/);
});
