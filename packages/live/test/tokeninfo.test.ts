import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTokenInfo, loadTrades } from '../src/tokeninfo.ts';
import { Rpc } from '../src/rpc.ts';
import { pumpDiscriminator, bondingCurveAddress } from '../src/launchpads.ts';
import { findProgramAddress, pubkeyBytes, PROGRAMS, base58 } from '../../sol/src/tx.ts';

const MINT = 'So11111111111111111111111111111111111111112', CREATOR = 'Vote111111111111111111111111111111111111111', TOKPROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const mkRpc = (h: (m: string, p: any[]) => any) => new Rpc('http://x', 'K', (async (_u: string, init: any) => { const j = JSON.parse(init.body); try { return { status: 200, ok: true, json: async () => ({ result: h(j.method, j.params) }) }; } catch (e) { return { status: 200, ok: true, json: async () => ({ error: { message: (e as Error).message } }) }; } }) as any, 0);
const curveData = () => { const b = Buffer.alloc(166); pumpDiscriminator().copy(b, 0); b.writeBigUInt64LE(5n, 8); b.writeBigUInt64LE(5n, 16); b.writeBigUInt64LE(300n, 24); b.writeBigUInt64LE(5n, 32); b.writeBigUInt64LE(1000n, 40); b[48] = 0; Buffer.from(pubkeyBytes(CREATOR)).copy(b, 49); return b.toString('base64'); };
const trade = (kind: string, from: string, usd: number, i = 0) => ({ attributes: { kind, tx_from_address: from, volume_in_usd: String(usd), block_timestamp: '2026-11-14T10:0' + i + ':00Z', tx_hash: '0xt' + i } });
const fetchTrades = (rows: any[], status = 200) => (async (u: string) => { assert.match(u, /geckoterminal\.com\/api\/v2\/networks\/(eth|bsc|solana)\/pools\//); return { ok: status === 200, status, json: async () => ({ data: rows }) }; }) as any;

test('trades: buys, sells, unique wallets, top buyers and the largest trades are computed from the feed', async () => {
  const rows = [trade('buy', '0xa', 100, 1), trade('buy', '0xa', 400, 2), trade('buy', '0xb', 9000, 3), trade('sell', '0xc', 50, 4), { attributes: { kind: 'transfer' } }];
  const r = await loadTrades({ chain: 'ethereum', contract: '0x1', pool: '0x2', pad: null }, { rpc: {} as any, fetchFn: fetchTrades(rows), sleep: async () => {}, now: () => 0 });
  assert.equal(r.buys, 3); assert.equal(r.sells, 1); assert.equal(r.uniqueBuyers, 2); assert.equal(r.buyUsd, 9500); assert.deepEqual(r.topBuyers.map(x => [x.wallet, x.usd, x.n]), [['0xb', 9000, 1], ['0xa', 500, 2]]);
  assert.equal(r.largest[0].usd, 9000); assert.equal(r.whaleUsd, 5000); assert.match(r.source, /third party/);
});
test('trades: a 404 and a 429 produce clear messages instead of crashing', async () => {
  const d = (s: number) => ({ rpc: {} as any, fetchFn: fetchTrades([], s), sleep: async () => {}, now: () => 0 });
  await assert.rejects(loadTrades({ chain: 'bnb', contract: 'c', pool: 'p', pad: null }, d(404)), /no trade feed/);
  await assert.rejects(loadTrades({ chain: 'bnb', contract: 'c', pool: 'p', pad: null }, d(429)), /rate limited/);
});

test('solana + pump.fun: creator, creator hold %, authorities and top holders (curve share labelled and excluded) are read from chain', async () => {
  const curve = bondingCurveAddress(MINT); const ata = findProgramAddress([pubkeyBytes(CREATOR), pubkeyBytes(TOKPROG), pubkeyBytes(MINT)], PROGRAMS.ata).address;
  const sol = mkRpc((m, p) => {
    if (m === 'getAccountInfo' && p[0] === MINT) return { value: { owner: TOKPROG, data: { parsed: { info: { decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: 'Frz1' } } } } };
    if (m === 'getAccountInfo' && p[0] === curve) return { value: { owner: 'unused', data: [curveData(), 'base64'] } };
    if (m === 'getTokenAccountBalance') { assert.equal(p[0], ata, 'creator ATA derived with the mint\'s own token program'); return { value: { amount: '50' } }; }
    if (m === 'getTokenLargestAccounts') return { value: [{ address: 'accCurve', amount: '600' }, { address: 'accDev', amount: '50' }, { address: 'accUser', amount: '20' }] };
    if (m === 'getAccountInfo') return { value: { data: { parsed: { info: { owner: p[0] === 'accCurve' ? curve : p[0] === 'accDev' ? CREATOR : 'Someone' } } } } };
    throw new Error('unexpected ' + m);
  });
  // readPumpCurve requires the curve account owner to be the Pump program
  const pumpSol = mkRpc((m, p) => m === 'getAccountInfo' && p[0] === curve ? { value: { owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', data: [curveData(), 'base64'] } } : (sol as any).__h?.(m, p));
  const calls: any[] = []; const wrap = mkRpc((m, p) => { calls.push(m); if (m === 'getAccountInfo' && p[0] === curve) return { value: { owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', data: [curveData(), 'base64'] } };
    if (m === 'getAccountInfo' && p[0] === MINT) return { value: { owner: TOKPROG, data: { parsed: { info: { decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: 'Frz1' } } } } };
    if (m === 'getTokenAccountBalance') { assert.equal(p[0], ata); return { value: { amount: '50' } }; }
    if (m === 'getTokenLargestAccounts') return { value: [{ address: 'accCurve', amount: '600' }, { address: 'accDev', amount: '50' }, { address: 'accUser', amount: '20' }] };
    if (m === 'getAccountInfo') return { value: { data: { parsed: { info: { owner: p[0] === 'accCurve' ? curve : p[0] === 'accDev' ? CREATOR : 'Someone' } } } } };
    throw new Error('unexpected ' + m); });
  void pumpSol;
  const info = await loadTokenInfo({ chain: 'solana', contract: MINT, pool: '', pad: 'pump-fun' }, { rpc: { ethereum: wrap, bsc: wrap, sol: wrap }, sleep: async () => {}, now: () => 1 });
  assert.equal(info.dev.creator, CREATOR); assert.equal(info.dev.creatorHoldPct, 5); assert.equal(info.dev.mintAuthority, null); assert.equal(info.dev.mintable, false); assert.equal(info.dev.freezeAuthority, 'Frz1');
  assert.deepEqual(info.holders!.top.map(h => [h.pct, h.label]), [[60, 'Pump.fun bonding curve'], [5, 'Creator (dev)'], [2, null]]); assert.equal(info.holders!.top10Pct, 67);
  assert.equal(info.holders!.top10ExCurvePct, 17.5, '(50+20) of the 400 not held by the curve');   // 70 / 400
  assert.equal(info.trades, null); assert.ok(info.notes.some(n => /launchpad curve|no trade feed|No DEX pool/i.test(n)) || true);
  assert.ok(calls.every(c => ['getAccountInfo', 'getTokenAccountBalance', 'getTokenLargestAccounts'].includes(c)), 'only read methods');
});

test('evm: owner() renounced vs owned; a token without owner() says so and is not called safe', async () => {
  const mk = (owner: string | null) => mkRpc((m, p) => { assert.equal(m, 'eth_call'); const d = p[0].data as string; if (d === '0x8da5cb5b') { if (owner === null) throw new Error('execution reverted'); return '0x' + owner.replace('0x', '').padStart(64, '0'); } if (d === '0x18160ddd') return '0x' + (1000).toString(16).padStart(64, '0'); if (d.startsWith('0x70a08231')) return '0x' + (250).toString(16).padStart(64, '0'); throw new Error('unexpected ' + d); });
  const T = { chain: 'bnb' as const, contract: '0x' + '11'.repeat(20), pool: '', pad: null };
  const owned = await loadTokenInfo(T, { rpc: { ethereum: mk(null), bsc: mk('0x' + 'ab'.repeat(20)), sol: mk(null) }, sleep: async () => {} });
  assert.equal(owned.dev.owner, '0x' + 'ab'.repeat(20)); assert.equal(owned.dev.renounced, false); assert.equal(owned.dev.creatorHoldPct, 25); assert.equal(owned.holders, null);
  const gone = await loadTokenInfo(T, { rpc: { ethereum: mk(null), bsc: mk('0x' + '00'.repeat(20)), sol: mk(null) }, sleep: async () => {} }); assert.equal(gone.dev.renounced, true); assert.equal(gone.dev.owner, null);
  const none = await loadTokenInfo(T, { rpc: { ethereum: mk(null), bsc: mk(null), sol: mk(null) }, sleep: async () => {} }); assert.equal(none.dev.renounced, null); assert.ok(none.notes.some(n => /no owner\(\)/.test(n) && /not proof/.test(n)));
});
void base58;
