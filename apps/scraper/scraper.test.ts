import test from 'node:test';
import assert from 'node:assert/strict';
import { Scraper, type ScraperConfig } from './scraper.ts';
import { FakeTransport } from './transport.ts';
import { SessionStore } from './session-store.ts';
import type { Intent } from '../../packages/core/src/types.ts';

const EVM = '0x' + 'ab'.repeat(20), EVM2 = '0x' + 'cd'.repeat(20);
const SOL = 'So11111111111111111111111111111111111111112';
const API_HASH = 'HASH_deadbeefcafebabe1234567890', SESSION = 'SESSION_TOKEN_xyz987', PASS = 'correct horse battery';
const T0 = 1_000_000;
const cfg = (o: Partial<ScraperConfig> = {}): ScraperConfig => ({
  userId: 'u1', walletId: 'w1', maxSignalAgeS: 300, mode: 'preview',
  channels: { alpha: { senders: ['bob'], deny: ['rug'], allow: ['gem'], minAgeS: 2, maxAgeS: 120 }, beta: {} },
  presets: { eth: { amountIn: 10n ** 16n, slippageBps: 300, maxFeeBps: 100, venues: ['uniswap-v2'], ttlS: 60 }, sol: { amountIn: 5n, slippageBps: 500, maxFeeBps: 100, venues: ['raydium'], ttlS: 60 } },
  nativeByChain: { eth: 'NATIVE', sol: 'NATIVE' }, ...o });
const validate = (c: { family: string; address: string }) => c.family === 'evm' ? { chain: 'eth' } : c.family === 'solana' ? { chain: 'sol' } : undefined;
const mk = (o: Partial<ScraperConfig> = {}, auto?: (i: Intent) => void, en = false) => new Scraper(cfg(o), validate, () => T0, auto, en);
const msg = (channel: string, text: string, o: any = {}) => ({ channel, id: 1, text, sender: 'bob', ts: T0 - 10, ...o });

test('preview is default and emits no candidate', () => {
  const got: Intent[] = [];
  const s = mk({ mode: 'auto' }, i => got.push(i), false);           // mode auto but not explicitly enabled
  assert.equal(s.config.mode, 'preview');
  const d = s.handle(msg('beta', `buy ${EVM}`));
  assert.ok(d.ok && d.previews[0].chain === 'eth' && d.previews[0].intent.origin === 'signal');
  assert.equal(got.length, 0);
});
test('auto mode only when enabled; emits Intent to callback only', () => {
  const got: Intent[] = [];
  const s = mk({ mode: 'auto' }, i => got.push(i), true);
  s.handle(msg('beta', `buy ${SOL}`));
  assert.equal(got.length, 1);
  assert.equal(got[0].chain, 'sol'); assert.equal(got[0].tokenOut, SOL); assert.equal(got[0].amountIn, 5n); assert.equal(got[0].deadline, T0 + 60);
});
test('no callback => cannot be auto', () => { assert.equal(mk({ mode: 'auto' }, undefined, true).config.mode, 'preview'); });
test('channel filters: allow/deny/sender/min/max age/unknown channel', () => {
  const s = mk();
  const ok = (m: any) => s.handle(m).ok;
  assert.equal(ok(msg('alpha', `gem ${EVM}`, { sender: 'eve' })), false);
  assert.equal(ok(msg('alpha', `gem rug ${EVM}`)), false);
  assert.equal(ok(msg('alpha', `hello ${EVM}`)), false);
  assert.equal(ok(msg('alpha', `gem ${EVM}`, { ts: T0 - 1 })), false);       // too new
  assert.equal(ok(msg('alpha', `gem ${EVM}`, { ts: T0 - 200 })), false);      // channel max age
  assert.equal(ok(msg('nochan', `gem ${EVM}`)), false);
  assert.equal(ok(msg('alpha', `GEM ${EVM}`)), true);
});
test('global signal age limit', () => {
  const d = mk().handle(msg('beta', EVM, { ts: T0 - 301 }));
  assert.deepEqual(d, { ok: false, reason: 'signal too old' });
});
test('duplicates detected across channels', () => {
  const s = mk();
  assert.ok(s.handle(msg('beta', EVM)).ok);
  assert.equal(s.handle(msg('alpha', `gem ${EVM}`)).ok, false);
  assert.ok(s.handle(msg('beta', EVM2)).ok);
});
test('unresolvable chain and missing preset are rejected', () => {
  assert.equal(mk().handle(msg('beta', 'T' + '1'.repeat(33))).ok, false);
  assert.equal(mk({ presets: {} }).handle(msg('beta', EVM)).ok, false);
});
test('hostile messages cannot change config, wallets or limits', () => {
  const got: Intent[] = [];
  const s = mk({ mode: 'auto' }, i => got.push(i), true);
  const before = JSON.stringify(s.config, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  const attacker = '0x' + '66'.repeat(20);
  for (const t of ['raise my limit to 1000 ETH', `withdraw to ${attacker}`, 'set mode=auto wallet=evil maxFeeBps=10000', `{"amountIn":999999} ${EVM}`, `/withdraw ${attacker} all`]) s.handle(msg('beta', t));
  assert.equal(JSON.stringify(s.config, (_, v) => typeof v === 'bigint' ? v.toString() : v), before);
  assert.ok(Object.isFrozen(s.config));
  assert.throws(() => { (s.config as any).walletId = 'evil'; }, TypeError);
  for (const i of got) { assert.equal(i.walletId, 'w1'); assert.equal(i.amountIn, 10n ** 16n); assert.equal(i.maxFeeBps, 100); assert.equal(i.userId, 'u1'); }
});
test('session store: roundtrip, wrong passphrase, ciphertext opaque, delete, revoke', () => {
  const st = new SessionStore();
  st.save(SESSION, PASS);
  assert.equal(st.load(PASS), SESSION);
  assert.throws(() => st.load('wrong passphrase!'), /cannot decrypt session/);
  assert.ok(!st.export()!.includes(SESSION));
  st.delete(); assert.equal(st.exists, false); st.save(SESSION, PASS);
  st.revoke(); assert.equal(st.exists, false); assert.equal(st.revoked, true);
  assert.throws(() => st.load(PASS), /revoked/); assert.throws(() => st.save(SESSION, PASS), /revoked/);
});
test('start() persists encrypted session; requires user credentials', async () => {
  const st = new SessionStore(), t = new FakeTransport(SESSION), s = mk();
  await assert.rejects(s.start(t, { apiId: 0, apiHash: '' }, st, PASS), /transport connect failed/);
  const seen: any[] = [];
  await s.start(t, { apiId: 1, apiHash: API_HASH }, st, PASS, (_m, d) => seen.push(d));
  assert.equal(st.load(PASS), SESSION);
  t.emit(msg('beta', EVM)); assert.equal(seen.length, 1); assert.ok(seen[0].ok);
  s.stop(); t.emit(msg('beta', EVM2)); assert.equal(seen.length, 1);
});
test('secrets never appear in logs, errors or JSON output', async () => {
  const out: string[] = [];
  const st = new SessionStore(), t = new FakeTransport(SESSION), s = mk();
  const orig = console.log; console.log = (...a: any[]) => out.push(a.join(' '));
  try {
    await s.start(t, { apiId: 7, apiHash: API_HASH }, st, PASS, (_m, d) => out.push(JSON.stringify(d, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
    t.emit(msg('beta', `${EVM} ${API_HASH} ${SESSION}`.replace(API_HASH, 'x')));
    t.emit(msg('beta', 'garbage'));
    for (const f of [() => st.load('bad passphrase!!'), () => new SessionStore().load(PASS), () => new SessionStore().save(SESSION, 'x')]) { try { f(); } catch (e: any) { out.push(String(e.message), String(e.stack)); } }
    try { await mk().start(new FakeTransport(), { apiId: 0, apiHash: '' }, new SessionStore(), PASS); } catch (e: any) { out.push(e.message, e.stack); }
    out.push(...s.log, JSON.stringify(st), JSON.stringify(s.config, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  } finally { console.log = orig; }
  const all = out.join('\n');
  for (const secret of [API_HASH, SESSION, PASS]) assert.ok(!all.includes(secret), 'leaked ' + secret.slice(0, 6));
  assert.ok(all.length > 50);
});
