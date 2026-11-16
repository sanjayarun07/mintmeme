import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletPush } from '../src/walletpush.ts';
import type { WsLike } from '../src/launchstream.ts';

const W1 = '11111111111111111111111111111112', W2 = 'So11111111111111111111111111111111111111112';
function fakeWs() {
  const made: any[] = [];
  const factory = (url: string) => { const s: any = { url, sent: [] as any[], closed: false, onopen: null, onmessage: null, onclose: null, onerror: null, send(d: string) { s.sent.push(JSON.parse(d)); }, close() { s.closed = true; } }; made.push(s); return s as WsLike & typeof s; };
  return { made, factory };
}
const reply = (s: any, id: number, result: number) => s.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) });
const notify = (s: any, sub: number, signature: string, err: any = null) => s.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot: 77 }, value: { signature, err, logs: [] } } } }) });

test('subscribes once per wallet, maps notifications to the right wallet, ignores duplicates', () => {
  const f = fakeWs(), got: any[] = [];
  const p = new WalletPush({ url: 'wss://x.example/?api-key=SECRET', wallets: [W1, W2, W1], onActivity: a => got.push(a), wsFactory: f.factory });
  p.start(); const s = f.made[0]; s.onopen({});
  assert.equal(s.sent.length, 2); assert.deepEqual(s.sent[0].params[0], { mentions: [W1] }); assert.equal(s.sent[0].method, 'logsSubscribe');
  reply(s, s.sent[0].id, 101); reply(s, s.sent[1].id, 102); assert.equal(p.status().state, 'live'); assert.equal(p.status().subscribed, 2);
  notify(s, 102, 'sigA'); notify(s, 102, 'sigA'); notify(s, 101, 'sigB', { InstructionError: [0, 'x'] });
  assert.deepEqual(got.map(g => [g.wallet, g.signature, g.failed, g.slot]), [[W2, 'sigA', false, 77], [W1, 'sigB', true, 77]]);
  assert.equal(p.status().notifications, 2); p.stop();
});

test('status never exposes the key in the URL, only the host', () => {
  const f = fakeWs(); const p = new WalletPush({ url: 'wss://x.example/?api-key=SECRET', wallets: [W1], onActivity: () => {}, wsFactory: f.factory }); p.start();
  const s = f.made[0]; s.onopen({}); s.onmessage({ data: JSON.stringify({ id: s.sent[0].id, error: { message: 'bad wss://x.example/?api-key=SECRET' } }) });
  const st = JSON.stringify(p.status()); assert.ok(!st.includes('SECRET')); assert.equal(p.status().host, 'x.example'); assert.match(p.status().lastError!, /<ws url>/); p.stop();
});

test('reconnects after a close, re-subscribes, and keeps working', () => {
  const f = fakeWs(), got: any[] = []; const timers: (() => void)[] = [];
  const p = new WalletPush({ url: 'wss://x.example/', wallets: [W1], onActivity: a => got.push(a), wsFactory: f.factory, setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any, backoffMs: () => 1 });
  p.start(); f.made[0].onopen({}); reply(f.made[0], f.made[0].sent[0].id, 5);
  f.made[0].onclose({}); assert.equal(p.status().state, 'reconnecting'); assert.equal(p.status().reconnects, 1); assert.equal(timers.length, 1);
  timers[0](); const s2 = f.made[1]; assert.ok(s2); s2.onopen({}); reply(s2, s2.sent[0].id, 9); notify(s2, 9, 'sigC'); assert.equal(got.length, 1); assert.equal(p.status().state, 'live');
  p.stop(); assert.equal(p.status().state, 'stopped'); f.made[1].onclose({}); assert.equal(timers.length, 1, 'no reconnect after stop');
});

test('a throwing listener does not stop the stream; bad addresses are rejected up front; junk frames are ignored', () => {
  const f = fakeWs(); let n = 0;
  const p = new WalletPush({ url: 'wss://x.example/', wallets: [W1], onActivity: () => { n++; throw new Error('boom'); }, wsFactory: f.factory }); p.start();
  const s = f.made[0]; s.onopen({}); reply(s, s.sent[0].id, 1); s.onmessage({ data: 'not json' }); s.onmessage({ data: JSON.stringify({ method: 'logsNotification', params: { subscription: 999, result: {} } }) });
  notify(s, 1, 'a'); notify(s, 1, 'b'); assert.equal(n, 2);
  assert.throws(() => new WalletPush({ url: 'wss://x', wallets: ['0xabc'], onActivity: () => {} }), /not a Solana address/); p.stop();
});
