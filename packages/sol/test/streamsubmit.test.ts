import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolanaStream, ChangeTrigger } from '../src/stream.ts';
import type { WsLike } from '../src/stream.ts';
import { JitoSubmitter, RpcSubmitter } from '../src/submitter.ts';

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

const engine = (calls: any[], fail?: string) => (async (url: string, init: any) => { const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers }); if (fail) return { ok: true, json: async () => ({ error: { message: fail } }) }; const result = body.method === 'getTipAccounts' ? TIP : 'bundle-id-1'; return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }; }) as any;

test('Jito: tips go to an account from the block engine\'s own list, with the configured amount', async () => {
  const calls: any[] = []; const j = new JitoSubmitter({ tipLamports: 10_000n, fetchFn: engine(calls), pickTip: a => a[1] });
  const ix = await j.extraInstruction('PAYER'); assert.equal(ix.keys[1].pubkey, TIP[1]); assert.equal(Buffer.from(ix.data).readBigUInt64LE(4), 10_000n); await j.extraInstruction('PAYER'); assert.equal(calls.filter(c => c.body.method === 'getTipAccounts').length, 1, 'list is cached');
  assert.ok(calls[0].url.endsWith('/bundles'));
});

test('Jito: sendBundle carries one base64 transaction, returns the signature we computed, and surfaces block-engine errors', async () => {
  const calls: any[] = []; const j = new JitoSubmitter({ tipLamports: 10_000n, fetchFn: engine(calls), uuid: 'u-1' });
  assert.equal(await j.send('AAAA', 'SIG1'), 'SIG1'); const c = calls.at(-1); assert.equal(c.body.method, 'sendBundle'); assert.deepEqual(c.body.params, [['AAAA'], { encoding: 'base64' }]); assert.equal(c.headers['x-jito-auth'], 'u-1');
  await assert.rejects(new JitoSubmitter({ tipLamports: 10_000n, fetchFn: engine([], 'bundle dropped') }).send('AAAA', 'S'), /bundle dropped/);
});

test('Jito refuses a zero tip and a tip above the safety cap unless raised on purpose', () => {
  assert.throws(() => new JitoSubmitter({ tipLamports: 0n }), /greater than zero/); assert.throws(() => new JitoSubmitter({ tipLamports: 50_000_000n }), /safety cap/); assert.doesNotThrow(() => new JitoSubmitter({ tipLamports: 50_000_000n, maxTipLamports: 100_000_000n }));
});

test('RPC submitter refuses a node that reports a different signature', async () => {
  const ok = new RpcSubmitter({ call: async () => 'SIG1' } as any); assert.equal(await ok.send('raw', 'SIG1'), 'SIG1');
  await assert.rejects(new RpcSubmitter({ call: async () => 'OTHER' } as any).send('raw', 'SIG1'), /different transaction/);
});
