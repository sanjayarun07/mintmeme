import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LinkStore, LINK_LIMITS } from './linking.ts';
import { TelegramBot } from './bot.ts';
import type { Ctx } from './handler.ts';

const TOKEN = '123456:SECRET-TOKEN-abc';
let T = 1_000_000_000; const clock = () => T;
const store = (extra: object = {}) => new LinkStore({ now: clock, ...extra });

test('a code works once, for the account that asked, and then the chat maps to that account', () => {
  const s = store(), { code } = s.issue('alice');
  assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.deepEqual(s.redeem(5, code.toLowerCase()), { ok: true, userId: 'alice' });
  assert.equal(s.userOf(5), 'alice'); assert.deepEqual(s.chatsOf('alice'), [5]);
  assert.deepEqual(s.redeem(6, code), { ok: false, reason: 'bad-code' }, 'a used code is dead');
  assert.equal(s.userOf(6), undefined);
});

test('a code expires after 10 minutes', () => {
  const s = store(), { code } = s.issue('alice'); T += (LINK_LIMITS.codeTtlS + 1) * 1000;
  assert.deepEqual(s.redeem(5, code), { ok: false, reason: 'bad-code' }); assert.equal(s.userOf(5), undefined);
});

test('only 3 unused codes per account: asking again drops the oldest', () => {
  const s = store(), codes: string[] = []; for (let i = 0; i < 4; i++) { codes.push(s.issue('alice').code); T += 1000; }
  assert.equal(s.redeem(1, codes[0]).ok, false, 'oldest code was dropped'); assert.equal(s.redeem(2, codes[3]).ok, true);
});

test('five wrong guesses lock the chat out, even for a valid code, until the window passes', () => {
  const s = store(), { code } = s.issue('alice');
  for (let i = 0; i < LINK_LIMITS.badTries; i++) assert.deepEqual(s.redeem(9, 'WRONG' + i), { ok: false, reason: 'bad-code' });
  assert.deepEqual(s.redeem(9, code), { ok: false, reason: 'locked' });
  assert.equal(s.redeem(10, code).ok, true, 'another chat is not affected');
  T += (LINK_LIMITS.badWindowS + 1) * 1000; assert.equal(s.redeem(9, s.issue('alice').code).ok, true, 'the lockout ends with its window');
});

test('an account links at most 3 chats; unlink frees a slot; unlinkAccount removes all', () => {
  const s = store(); for (const c of [1, 2, 3]) assert.equal(s.redeem(c, s.issue('alice').code).ok, true);
  assert.deepEqual(s.redeem(4, s.issue('alice').code), { ok: false, reason: 'too-many-chats' });
  assert.equal(s.unlink(1), true); assert.equal(s.unlink(1), false); assert.equal(s.redeem(4, s.issue('alice').code).ok, true);
  assert.equal(s.unlinkAccount('alice'), 3); assert.deepEqual(s.chatsOf('alice'), []);
});

test('links are saved to a file as chat and account ids only, and loaded back', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'link-')), 'links.json'); const a = store({ file }), { code } = a.issue('alice'); a.redeem(77, code);
  const raw = readFileSync(file, 'utf8'); assert.ok(!raw.includes(code), 'no code is written'); assert.deepEqual(JSON.parse(raw), { chats: { '77': 'alice' } });
  assert.equal(store({ file }).userOf(77), 'alice');
});

/* ---- through the bot, against a fake Bot API ---- */
async function mockApi(updates: any[][]) {
  const calls: { method: string; body: any }[] = []; let poll = 0;
  const srv = createServer(async (req, res) => { const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const body = ch.length ? JSON.parse(Buffer.concat(ch).toString()) : {}; const method = req.url!.split('/').pop()!; calls.push({ method, body }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? (updates[poll++] ?? []) : true })); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); return { base: `http://127.0.0.1:${(srv.address() as any).port}`, calls, close: () => srv.close() };
}
const msg = (id: number, chat: number, text: string) => ({ update_id: id, message: { message_id: id * 10, chat: { id: chat, type: 'private' }, text } });
const ctxFor = (sub: any[]) => (userId: string): Ctx => ({ userId, walletId: 'w1', chain: 'c', native: 'NATIVE', autoTrade: false, submit: async i => { sub.push(i); return { state: 'confirmed' }; }, now: () => 1_000_000, quickBuy: 10n });

test('bot: /buy before linking is refused and tells the user how to link; /link <code> then enables /buy for that account only; /unlink turns it off', async () => {
  const s = store(), { code } = s.issue('alice'), sub: any[] = [];
  const api = await mockApi([[msg(1, 42, '/buy TOK 5'), msg(2, 42, '/link WRONGONE'), msg(3, 42, `/link ${code}`), msg(4, 42, '/buy TOK 7'), msg(5, 42, '/unlink'), msg(6, 42, '/buy TOK 9')]]);
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map(), linker: s, ctxFor: ctxFor(sub), pollTimeoutS: 0 }); await bot.pollOnce();
  const texts = api.calls.filter(c => c.method === 'sendMessage').map(c => c.body.text as string);
  assert.match(texts[0], /not linked.*Settings/s); assert.match(texts[1], /not valid/); assert.match(texts[2], /^Linked/); assert.match(texts[3], /state=confirmed/); assert.match(texts[4], /^Unlinked/); assert.match(texts[5], /not linked/);
  assert.equal(sub.length, 1); assert.equal(sub[0].userId, 'alice'); assert.equal(sub[0].amountIn, 7n);
  assert.ok(api.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 30), 'the /link message with the code is deleted');
  api.close();
});

test('bot: a code sent in a group does nothing; a secret key inside /link is deleted and never treated as a code', async () => {
  const s = store(), { code } = s.issue('alice'); const key = 'a'.repeat(64);
  const api = await mockApi([[{ update_id: 1, message: { message_id: 10, chat: { id: 99, type: 'group' }, text: `/link ${code}` } }, msg(2, 42, `/link ${key}`)]]);
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map(), linker: s, ctxFor: ctxFor([]), pollTimeoutS: 0 }); await bot.pollOnce();
  assert.equal(s.userOf(99), undefined); assert.ok(api.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 20)); assert.match(api.calls.filter(c => c.method === 'sendMessage').at(-1)!.body.text, /looked like a seed phrase or private key/);
  assert.equal(s.redeem(5, code).ok, true, 'the real code is still valid'); api.close();
});

test('bot: /start lists the commands; with no linker, /link is not offered', async () => {
  const api = await mockApi([[msg(1, 42, '/start')]]);
  await new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map(), pollTimeoutS: 0 }).pollOnce();
  const t = api.calls.find(c => c.method === 'sendMessage')!.body.text as string; assert.ok(!t.includes('/link')); assert.match(t, /\/wallet/); api.close();
});
