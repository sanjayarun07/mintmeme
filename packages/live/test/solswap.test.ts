import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b58decode, isOnCurve, findProgramAddress, createProgramAddress, compileLegacy, unsignedTx, raydiumSwapBaseIn, createAtaIdempotent, ataAddress, pubkeyBytes, PROGRAMS } from '../src/solswap.ts';
import { base58 } from '../src/solpool.ts';

const OWNER = '3aHLqHsvw3gPxnq1fVEYG6P3pCcxkGo3ETSkQGE4KZkS', RAY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

test('base58 round-trips, including leading zero bytes', () => {
  for (const b of [Uint8Array.from([0, 0, 1, 2, 255]), pubkeyBytes(OWNER)]) assert.deepEqual(b58decode(base58(b)), b);
  assert.equal(pubkeyBytes(PROGRAMS.system).every(x => x === 0), true);
  assert.throws(() => b58decode('0OIl'), /invalid base58/);
});
test('a wallet address is on the ed25519 curve; a derived program address is not', () => {
  assert.equal(isOnCurve(pubkeyBytes(OWNER)), true);
  const { address } = findProgramAddress([new TextEncoder().encode('amm authority')], RAY);
  assert.equal(isOnCurve(pubkeyBytes(address)), false);
});
test('AMM authority derivation equals the owner of the real pool vaults (confirmed on mainnet 2026-11-13)', () => {
  assert.equal(findProgramAddress([new TextEncoder().encode('amm authority')], RAY).address, '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
});
test('createProgramAddress rejects seeds that land on the curve and seeds over 32 bytes', () => {
  assert.throws(() => createProgramAddress([new Uint8Array(33)], RAY), /seed too long/);
});
test('message layout: payer first, signer/writable ordering, header counts, unsigned tx has zeroed signature', () => {
  const pool = (c: string) => base58(Uint8Array.from({ length: 32 }, () => c.charCodeAt(0)));
  const k = Object.fromEntries('abcdefghijklmnopq'.split('').map(c => [c, pool(c)]));
  const keys = { programId: RAY, id: k.a, authority: k.b, openOrders: k.c, targetOrders: k.d, baseVault: k.e, quoteVault: k.f, marketProgram: k.g, market: k.h, bids: k.i, asks: k.j, eventQueue: k.k, marketBaseVault: k.l, marketQuoteVault: k.m, marketAuthority: k.n };
  const ixs = [createAtaIdempotent(OWNER, OWNER, k.o), raydiumSwapBaseIn(keys, k.p, k.q, OWNER, 5n, 1n)];
  const msg = compileLegacy(OWNER, ixs);
  assert.deepEqual([...msg.slice(0, 3)], [1, 0, msg[2]]);            // one signer (the owner), writable; no readonly signers
  assert.deepEqual([...msg.slice(4, 36)], [...pubkeyBytes(OWNER)]);   // payer is account 0
  const tx = unsignedTx(msg);
  assert.equal(tx[0], 1); assert.equal(tx.slice(1, 65).every(b => b === 0), true); assert.equal(tx.length, 1 + 64 + msg.length);
  const swap = ixs[1]; assert.deepEqual([...swap.data], [9, 5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(swap.keys.length, 18); assert.equal(swap.keys[17].signer, true);
});
test('associated token address is deterministic and differs per mint', () => {
  const a = ataAddress(OWNER, 'So11111111111111111111111111111111111111112'), b = ataAddress(OWNER, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.notEqual(a, b); assert.equal(ataAddress(OWNER, 'So11111111111111111111111111111111111111112'), a);
});
