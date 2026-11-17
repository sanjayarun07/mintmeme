import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolanaStream, ChangeTrigger } from '../src/stream.ts';
import type { WsLike } from '../src/stream.ts';
import { JitoSubmitter, RpcSubmitter, JITO_DONT_FRONT } from '../src/submitter.ts';

const ACCT = 'Dqzkg3DyBSUJyECM8iiLYuaDAi7GD2s7dnvWEyripump', TIP = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'];

class FakeWs implements WsLike {
  readyState = 0; sent: any[] = []; onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

test('stream subscribes after open, maps notifications to the watched account, and resubscribes after a reconnect', async () => {
  const sockets: FakeWs[] = [], timers: (() => void)[] = [];
  const s = new SolanaStream({ wsUrl: 'ws://x', makeSocket: () => { const w = new FakeWs(); sockets.push(w); return w; }, setTimer: ((f: () => void) => { timers.push(f); return 0 as any; }) as any });
  const seen: [string, number][] = []; s.watch(ACCT, (a, slot) => seen.push([a, slot])); s.start();
  sockets[0].open(); const sub = sockets[0].sent[0]; assert.equal(sub.method, 'accountSubscribe'); assert.equal(sub.params[0], ACCT); assert.equal(sub.params[1].commitment, 'confirmed');
  sockets[0].push({ jsonrpc: '2.0', id: sub.id, result: 77 });
  sockets[0].push({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: 77, result: { context: { slot: 123 }, value: {} } } });
  sockets[0].push({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: 999, result: { context: { slot: 5 }, value: {} } } });   // unknown subscription: ignored
  assert.deepEqual(seen, [[ACCT, 123]]); assert.equal(s.events, 1);
  sockets[0].close(); assert.equal(s.connected, false); assert.equal(timers.length, 1); timers[0]();
  sockets[1].open(); assert.equal(sockets[1].sent[0].method, 'accountSubscribe'); assert.equal(s.reconnects, 1); s.stop();
});

test('stream: an unwatch sends accountUnsubscribe, and malformed frames are ignored', () => {
  const w = new FakeWs(); const s = new SolanaStream({ wsUrl: 'ws://x', makeSocket: () => w }); const off = s.watch(ACCT, () => {}); s.start(); w.open();
  w.push({ id: w.sent[0].id, result: 5 }); w.onmessage?.({ data: '{not json' }); off(); assert.equal(w.sent.at(-1).method, 'accountUnsubscribe'); assert.deepEqual(w.sent.at(-1).params, [5]); s.stop();
});

test('ChangeTrigger: single flight, one trailing run for changes that arrive meanwhile, and a minimum interval', async () => {
  let t = 0, runs = 0, release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const trig = new ChangeTrigger(async () => { runs++; if (runs === 1) await gate; }, { minIntervalMs: 0, now: () => t });
  trig.onChange('a', 1); trig.onChange('a', 2); trig.onChange('a', 3); await new Promise(r => setTimeout(r, 5)); assert.equal(runs, 1);
  release(); await new Promise(r => setTimeout(r, 10)); assert.equal(runs, 2, 'three changes during one run cause exactly one more run');
  const slow = new ChangeTrigger(async () => { throw new Error('boom'); }, { minIntervalMs: 0, onError: () => {} }); slow.onChange('a', 1); await new Promise(r => setTimeout(r, 5)); assert.equal(slow.errors, 1);
});

// a stand-in block engine and tip-floor service (shapes from https://docs.jito.wtf/lowlatencytxnsend/ and the live tip_floor response)
const engine = (calls: any[], fail?: string, floor: any = [{ landed_tips_75th_percentile: 0.00001, landed_tips_50th_percentile: 4.08e-6 }]) => (async (url: string, init: any = {}) => {
  if (String(url).includes('tip_floor')) { calls.push({ url }); return { ok: true, status: 200, json: async () => floor }; }
  const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers }); if (fail) return { ok: true, json: async () => ({ error: { message: fail } }) };
  const result = body.method === 'getTipAccounts' ? TIP : body.params[0] === 'AAAA' ? 'SIG1' : 'OTHER'; return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
}) as any;

test('Jito: tips go to an account from the block engine\'s own list, carry the jitodontfront flag read-only, and a fixed tip is used as given', async () => {
  const calls: any[] = []; const j = new JitoSubmitter({ minIntervalMs: 0, tip: 10_000n, fetchFn: engine(calls), pickTip: a => a[1] });
  const ix = await j.extraInstruction('PAYER'); assert.equal(ix.keys[1].pubkey, TIP[1]); assert.equal(Buffer.from(ix.data).readBigUInt64LE(4), 10_000n);
  assert.deepEqual(ix.keys[2], { pubkey: JITO_DONT_FRONT }, 'the sandwich-mitigation flag: not a signer, not writable');
  await j.extraInstruction('PAYER'); assert.equal(calls.filter(c => c.body?.method === 'getTipAccounts').length, 1, 'list is cached'); assert.ok(calls[0].url.endsWith('/api/v1/getTipAccounts'));
  assert.equal((await new JitoSubmitter({ minIntervalMs: 0, tip: 10_000n, fetchFn: engine([]), dontFront: false }).extraInstruction('P')).keys.length, 2);
});

test('Jito: the automatic tip follows the tip floor (SOL -> lamports) within the minimum and the cap, and falls back when the floor cannot be read', async () => {
  assert.equal(await new JitoSubmitter({ minIntervalMs: 0, fetchFn: engine([]) }).tipNow(), 10_000n, '75th percentile 0.00001 SOL');
  assert.equal(await new JitoSubmitter({ minIntervalMs: 0, fetchFn: engine([]), tipPercentile: 50 }).tipNow(), 4_080n);
  assert.equal(await new JitoSubmitter({ minIntervalMs: 0, fetchFn: engine([], undefined, [{ landed_tips_75th_percentile: 0.5 }]) }).tipNow(), 100_000n, 'a spike is capped at 0.0001 SOL');
  assert.equal(await new JitoSubmitter({ minIntervalMs: 0, fetchFn: engine([], undefined, [{ landed_tips_75th_percentile: 1e-8 }]) }).tipNow(), 1_000n, 'never below Jito\'s 1,000-lamport minimum');
  assert.equal(await new JitoSubmitter({ minIntervalMs: 0, fetchFn: engine([], undefined, { nope: 1 }) }).tipNow(), 10_000n, 'unreadable floor: a tenth of the cap');
});

test('Jito: sends privately with sendTransaction?bundleOnly=true, checks the returned signature, and surfaces block-engine errors', async () => {
  const calls: any[] = []; const j = new JitoSubmitter({ minIntervalMs: 0, tip: 10_000n, fetchFn: engine(calls), uuid: 'u-1' });
  assert.equal(await j.send('AAAA', 'SIG1'), 'SIG1'); const c = calls.at(-1);
  assert.equal(c.body.method, 'sendTransaction'); assert.deepEqual(c.body.params, ['AAAA', { encoding: 'base64' }]); assert.match(c.url, /\/api\/v1\/transactions\?bundleOnly=true&uuid=u-1$/); assert.equal(c.headers['x-jito-auth'], 'u-1');
  await assert.rejects(j.send('BBBB', 'SIG2'), /refusing to track a different transaction/);
  await assert.rejects(new JitoSubmitter({ minIntervalMs: 0, tip: 10_000n, fetchFn: engine([], 'bundle dropped') }).send('AAAA', 'S'), /bundle dropped/);
});

test('Jito refuses a zero tip and a tip above the safety cap unless raised on purpose', () => {
  assert.throws(() => new JitoSubmitter({ tip: 0n }), /greater than zero/); assert.throws(() => new JitoSubmitter({ tip: 50_000_000n }), /safety cap/); assert.doesNotThrow(() => new JitoSubmitter({ tip: 50_000_000n, maxTipLamports: 100_000_000n }));
});

test('RPC submitter refuses a node that reports a different signature', async () => {
  const ok = new RpcSubmitter({ call: async () => 'SIG1' } as any); assert.equal(await ok.send('raw', 'SIG1'), 'SIG1');
  await assert.rejects(new RpcSubmitter({ call: async () => 'OTHER' } as any).send('raw', 'SIG1'), /different transaction/);
});

test('Jito: block-engine calls in one process are spaced to respect the 1-per-second limit', async () => {
  const at: number[] = [], f = (async (_u: string, init: any) => { at.push(Date.now()); const b = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ result: b.params[0] }) }; }) as any;
  const a = new JitoSubmitter({ tip: 10_000n, fetchFn: f, url: 'http://pace.test', minIntervalMs: 120 }), b = new JitoSubmitter({ tip: 10_000n, fetchFn: f, url: 'http://pace.test', minIntervalMs: 120 });
  await Promise.all([a.send('X', 'X'), b.send('Y', 'Y'), a.send('Z', 'Z')]);
  assert.equal(at.length, 3); assert.ok(at[1] - at[0] >= 110 && at[2] - at[1] >= 110, `spaced: ${at[1] - at[0]} ms, ${at[2] - at[1]} ms (two instances share the queue)`);
});
