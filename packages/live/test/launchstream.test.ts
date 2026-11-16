import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchStream, decodeToken2022Metadata, solanaFeeds } from '../src/launchstream.ts';
import type { StreamFeed, WsLike } from '../src/launchstream.ts';
import type { LaunchItem } from '../src/launchfeed.ts';

class FakeWs implements WsLike {
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null; sent: any[] = []; closed = false;
  constructor(public url: string) { FakeWs.all.push(this); }
  static all: FakeWs[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.onclose?.({}); }
  open() { this.onopen?.({}); }
  reply(id: number, result: number) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) }); }
  refuse(id: number) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: "Method 'logsSubscribe' not found" } }) }); }
  note(sub: number, signature: string, logs: string[], err: unknown = null, slot = 100) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot }, value: { signature, err, logs } } } }) }); }
}
const item = (id: string): LaunchItem => ({ id, chain: 'solana', sym: id, name: id, contract: id, pool: 'p', venue: 'Pump.fun', pad: 'pump-fun', source: 'launchpad', stage: 'new', ageMin: 0, liqUsd: null, price: null, verdict: 'unchecked', flags: [], dryRun: { wouldBuy: false, why: '' }, executable: false });
const feed = (parse: StreamFeed['parse'] = async sig => [item(sig)]): StreamFeed => ({ name: 'f1', mention: 'ACCOUNT1', match: l => l.includes('create'), parse });
const mk = (feeds: StreamFeed[], extra: Partial<ConstructorParameters<typeof LaunchStream>[0]> = {}) => { FakeWs.all = []; return new LaunchStream({ url: 'wss://secret.example/abc', feeds, wsFactory: u => new FakeWs(u), backoffMs: [5], retryMs: [5, 5], ...extra }); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('subscribes once per feed with the mention, and only releases matching, successful, new signatures', async () => {
  const s = mk([feed()]); const got: string[] = []; s.on(i => got.push(i.id)); s.start();
  const ws = FakeWs.all[0]; ws.open();
  assert.deepEqual(ws.sent.map(m => [m.method, m.params[0].mentions, m.params[1].commitment]), [['logsSubscribe', ['ACCOUNT1'], 'confirmed']]);
  ws.reply(ws.sent[0].id, 7);
  ws.note(7, 'sigA', ['x create y']); ws.note(7, 'sigB', ['no match']); ws.note(7, 'sigC', ['create'], { InstructionError: 1 }); ws.note(7, 'sigA', ['create']);   // wrong filter, failed tx, duplicate
  await tick();
  assert.deepEqual(got, ['sigA']); const st = s.status();
  assert.equal(st.received, 4); assert.equal(st.matched, 1); assert.equal(st.emitted, 1); assert.equal(st.state, 'open'); assert.equal(st.feeds[0].subscribed, true);
  assert.equal(s.recent()[0].live, true); assert.equal(s.recent()[0].sig, 'sigA'); assert.equal(s.recent()[0].slot, 100);
  s.stop();
});

test('items get the dry run of the sniper rules and a Pump.fun curve can never be "would buy"', async () => {
  const s = mk([feed()]); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); ws.note(1, 's1', ['create']); await tick();
  const it = s.recent()[0]; assert.equal(it.dryRun.wouldBuy, false); assert.match(it.dryRun.why, /Pump\.fun curves cannot be traded/); s.stop();
});

test('a transaction the node cannot serve yet is retried, then counted as a failure with a reason and the stream keeps going', async () => {
  let calls = 0;
  const flaky = feed(async sig => { calls++; if (sig === 'late' && calls < 3) throw new Error('transaction not available yet'); if (sig === 'never') throw new Error('transaction not available yet'); return [item(sig)]; });
  const s = mk([flaky]); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1);
  ws.note(1, 'late', ['create']); ws.note(1, 'never', ['create']); ws.note(1, 'ok', ['create']); await tick(600);
  const st = s.status(); assert.equal(st.emitted, 2); assert.equal(st.failed, 1); assert.match(st.lastError!, /never.slice|could not decode never/); assert.deepEqual(s.recent().map(i => i.id).sort(), ['late', 'ok']); s.stop();
});

test('enrichment failure does not drop the item: it is shown as unchecked with the reason', async () => {
  const s = mk([feed()], { enrich: async () => { throw new Error('mint boom'); } }); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); ws.note(1, 's1', ['create']); await tick();
  const it = s.recent()[0]; assert.equal(it.verdict, 'unchecked'); assert.ok(it.flags.some(f => /mint not inspected: mint boom/.test(f))); s.stop();
});

test('a refused subscription is reported per feed, with the node\'s reason, and does not crash', async () => {
  const s = mk([feed()]); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.refuse(ws.sent[0].id);
  const st = s.status(); assert.equal(st.feeds[0].subscribed, false); assert.match(st.feeds[0].error!, /logsSubscribe/); assert.match(st.lastError!, /f1:/); s.stop();
});

test('a dropped socket reconnects, subscribes again, and counts a gap; stop() ends everything', async () => {
  const s = mk([feed()]); s.start(); let ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1);
  ws.onclose({}); assert.equal(s.status().state, 'reconnecting'); await tick(30);
  assert.equal(FakeWs.all.length, 2); ws = FakeWs.all[1]; ws.open(); assert.equal(ws.sent.length, 1);
  const st = s.status(); assert.equal(st.reconnects, 1); assert.equal(st.gaps, 1); assert.equal(st.state, 'open');
  s.stop(); assert.equal(s.status().state, 'stopped'); assert.equal(ws.closed, true); await tick(30); assert.equal(FakeWs.all.length, 2, 'no reconnect after stop');
});

test('the url (which may carry a key) is redacted out of errors', async () => {
  const s = mk([feed(async () => { throw new Error('failed talking to wss://secret.example/abc'); })]); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); ws.note(1, 'x', ['create']); await tick();
  assert.ok(!s.status().lastError!.includes('secret.example')); s.stop();
});

test('keeps only the newest N items', async () => {
  const s = mk([feed()], { keep: 3 }); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1);
  for (const n of ['a', 'b', 'c', 'd', 'e']) ws.note(1, n, ['create']); await tick(60); assert.equal(s.recent().length, 3); s.stop();
});

/* ---------- Token-2022 metadata ---------- */
function mint2022(name: string, symbol: string, uri: string, extra: Buffer[] = []) {
  const str = (x: string) => { const b = Buffer.from(x); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const body = Buffer.concat([Buffer.alloc(64), str(name), str(symbol), str(uri), Buffer.alloc(4)]);
  const tlv = (type: number, data: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); };
  return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), ...extra, tlv(19, body)]);
}
test('Token-2022 metadata: name, symbol and uri are read from the TokenMetadata extension, also after another extension', () => {
  assert.deepEqual(decodeToken2022Metadata(mint2022('Pepe Coin', 'PEPE', 'https://x/y')), { name: 'Pepe Coin', symbol: 'PEPE', uri: 'https://x/y' });
  const other = Buffer.concat([Buffer.from([18, 0, 64, 0]), Buffer.alloc(64)]);                               // a MetadataPointer-sized extension first
  assert.equal(decodeToken2022Metadata(mint2022('A', 'B', 'C', [other]))?.symbol, 'B');
  assert.equal(decodeToken2022Metadata(mint2022('é emoji', 'ÆØ', ''))?.name, 'é emoji');
});
test('Token-2022 metadata: a mint without the extension, a plain account, or truncated bytes give null instead of garbage', () => {
  assert.equal(decodeToken2022Metadata(Buffer.alloc(82)), null);
  assert.equal(decodeToken2022Metadata(Buffer.concat([Buffer.alloc(165), Buffer.from([2])])), null);          // account type is not "mint"
  assert.equal(decodeToken2022Metadata(mint2022('Name', 'SYM', 'uri').subarray(0, 190)), null);
});

/* ---------- Solana feeds ---------- */
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function pumpTx(opts: { program?: boolean; err?: unknown; tag?: number; tokenProgram?: string } = {}) {
  const keys = ['payer', 'So11111111111111111111111111111111111111112', 'pdaAuthority', opts.tokenProgram ?? TOKEN22, ...(opts.program === false ? [] : ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'])];
  const b58 = (n: number) => ({ 0: '1', 1: '2', 20: 'M' } as Record<number, string>)[n];                       // single-byte base58 values for tags 0, 1, 20 (see test below)
  return { slot: 5, meta: { err: opts.err ?? null, innerInstructions: [{ instructions: [{ programIdIndex: 3, data: b58(opts.tag ?? 20), accounts: [1, 2] }] }] }, transaction: { message: { accountKeys: keys, instructions: [] } } };
}
const fx = (tx: any) => solanaFeeds({ rpc: { call: async () => tx } as any, raydium: { parse: async () => [] }, raydiumWatch: 'W', pumpWatch: 'P' });
test('Pump.fun feed: filter accepts the creation instruction names only (not Create-account helpers)', () => {
  const [, pump] = fx(null);
  assert.equal(pump.match(['Program log: Instruction: CreateV2', 'x']), true);
  assert.equal(pump.match(['Program log: Instruction: Create']), true);
  assert.equal(pump.match(['Program log: Instruction: CreateAtaWithCloseAuthority']), false);
  assert.equal(pump.match(['Program log: Instruction: Buy']), false);
});
test('Pump.fun feed: the new mint is the account initialised by InitializeMint2 in a transaction that invokes the Pump.fun program', async () => {
  const [, pump] = fx(pumpTx()); const items = await pump.parse('sig', 5);
  assert.equal(items.length, 1); assert.equal(items[0].contract, 'So11111111111111111111111111111111111111112'); assert.equal(items[0].pad, 'pump-fun'); assert.equal(items[0].venue, 'Pump.fun'); assert.equal(items[0].liqUsd, null);
});
test('Pump.fun feed: a failed transaction, one without the Pump.fun program, or one with no mint initialisation yields nothing', async () => {
  assert.equal((await fx(pumpTx({ err: { InstructionError: 1 } }))[1].parse('s', 5)).length, 0);
  assert.equal((await fx(pumpTx({ program: false }))[1].parse('s', 5)).length, 0);
  assert.equal((await fx(pumpTx({ tag: 1 }))[1].parse('s', 5)).length, 0);
  assert.equal((await fx(pumpTx({ tokenProgram: 'SomeOtherProgram' }))[1].parse('s', 5)).length, 0);
});
test('Pump.fun feed: a null transaction is "not available yet" so the stream retries it', async () => {
  await assert.rejects(() => fx(null)[1].parse('s', 5), /not available yet/);
});
test('Raydium feed: filter is initialize2; liquidity uses SOL x2 at the DexScreener SOL price, and is null when no price is known', async () => {
  const mkf = (fetchFn: any) => solanaFeeds({ rpc: { call: async () => null } as any, raydium: { parse: async () => [{ token: 'TOK', venueId: 'POOL', block: 9, quoteLiquidity: 50n * 10n ** 9n }] }, fetchFn, raydiumWatch: 'W', pumpWatch: 'P' })[0];
  const f = mkf(async () => ({ json: async () => ({ pairs: [{ priceUsd: '150', liquidity: { usd: 9e9 } }] }) }));
  assert.equal(f.match(['Program log: initialize2: InitializeInstruction2 { nonce: 255 }']), true); assert.equal(f.match(['Program log: ray_log: abc']), false);
  const [it] = await f.parse('sig', 9); assert.equal(it.contract, 'TOK'); assert.equal(it.pool, 'POOL'); assert.equal(it.venue, 'Raydium AMM v4'); assert.equal(it.liqUsd, 50 * 150 * 2);
  const [none] = await mkf(async () => { throw new Error('offline'); }).parse('sig', 9); assert.equal(none.liqUsd, null);
});
test('transactions are requested with maxSupportedTransactionVersion 1 (version-1 transactions are returned instead of looking like a missing transaction)', async () => {
  const seen: any[] = [];
  const f = solanaFeeds({ rpc: { call: async (m: string, p: any[]) => { seen.push([m, p[1]]); return pumpTx(); } } as any, raydium: { parse: async () => [] }, raydiumWatch: 'W', pumpWatch: 'P' })[1];
  await f.parse('sig', 5); assert.equal(seen[0][0], 'getTransaction'); assert.equal(seen[0][1].maxSupportedTransactionVersion, 1);
});
test('seed(): restores earlier stream items newest-first, ignores items that did not come from the stream, dedupes by signature and respects keep', () => {
  const s = mk([feed()], { keep: 3 }); const mkI = (sig: string, seenAt: number, live = true) => ({ ...item(sig), live, sig, seenAt });
  s.seed([mkI('a', 100), mkI('b', 300), mkI('c', 200), mkI('d', 50), mkI('b', 300), mkI('x', 999, false), { ...item('nosig'), live: true } as any]);
  assert.deepEqual(s.recent().map(i => i.sig), ['b', 'c', 'a']);
});
test('Pump.fun feed: the creator is the fee payer of the creation transaction', async () => {
  const [it] = await fx(pumpTx())[1].parse('sig', 5); assert.equal(it.creator, 'payer');
});
test('signature poll fills what the WebSocket missed: skips failed, duplicate and too-old signatures, uses the block time as the age, marks via=poll', async () => {
  const nowMs = 10_000_000_000; const sec = (n: number) => Math.floor((nowMs - n * 1000) / 1000);
  const f = { ...feed(), recent: async () => [{ signature: 'new1', slot: 7, blockTime: sec(20) }, { signature: 'bad', err: {}, blockTime: sec(10) }, { signature: 'viaWs', blockTime: sec(30) }, { signature: 'ancient', blockTime: sec(7200) }, { signature: 'new0', blockTime: sec(60) }] };
  const s = mk([f], { now: () => nowMs, backfillMs: 30 }); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); ws.note(1, 'viaWs', ['create']); await tick(120);
  assert.deepEqual(s.recent().map(i => i.sig).sort(), ['new0', 'new1', 'viaWs']); const p = s.recent().find(i => i.sig === 'new1')!;
  assert.equal(p.via, 'poll'); assert.equal(p.seenAt, nowMs - 20_000); assert.equal(s.recent().find(i => i.sig === 'viaWs')!.via, 'ws'); assert.equal(s.status().polled, 2);
  const before = s.status().emitted; await tick(100); assert.equal(s.status().emitted, before, 'a signature is never emitted twice'); s.stop();
});
test('a failing signature poll is reported without stopping the stream', async () => {
  const f = { ...feed(), recent: async () => { throw new Error('node down'); } }; const s = mk([f], { backfillMs: 20 }); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); await tick(80);
  assert.match(s.status().lastError!, /signature poll failed: node down/); ws.note(1, 'ok', ['create']); await tick(30); assert.equal(s.recent()[0].sig, 'ok'); s.stop();
});

test('a decode that failed (for example a rate limit) is offered again by the next signature poll, once; a second failure stays failed', async () => {
  const nowMs = 10_000_000_000; let calls = 0; const attempts: Record<string, number> = {};
  const f = { ...feed(async sig => { attempts[sig] = (attempts[sig] ?? 0) + 1; if (sig === 'flaky' && attempts[sig] === 1) throw new Error('rate limited on getTransaction after retries'); if (sig === 'broken') throw new Error('always bad'); calls++; return [item(sig)]; }),
    recent: async () => [{ signature: 'flaky', blockTime: Math.floor(nowMs / 1000) }, { signature: 'broken', blockTime: Math.floor(nowMs / 1000) }] };
  const s = mk([f], { now: () => nowMs, backfillMs: 30 }); s.start(); const ws = FakeWs.all[0]; ws.open(); ws.reply(ws.sent[0].id, 1); await tick(250);
  assert.deepEqual(s.recent().map(i => i.sig), ['flaky']); assert.equal(attempts.flaky, 2); assert.equal(attempts.broken, 2, 'tried once more, then left failed'); assert.equal(s.status().failed, 3); s.stop();
});
