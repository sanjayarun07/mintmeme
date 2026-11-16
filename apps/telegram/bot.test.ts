import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { TelegramBot } from './bot.ts';
import type { Ctx } from './handler.ts';

const TOKEN = '123456:SECRET-TOKEN-abc';
async function mockApi(updates: any[][]) {
  const calls: { method: string; body: any }[] = []; let poll = 0, failNext: any = null;
  const srv: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const method = req.url!.split('/').pop()!; calls.push({ method, body }); res.setHeader('content-type', 'application/json');
    if (!req.url!.startsWith(`/bot${TOKEN}/`)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
    if (failNext) { const f = failNext; failNext = null; res.statusCode = f.status; return res.end(JSON.stringify(f.body)); }
    res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? (updates[poll++] ?? []) : true }));
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(srv.address() as any).port}`, calls, fail: (f: any) => { failNext = f; }, close: () => srv.close() };
}
const msg = (id: number, chat: number, text: string, type = 'private') => ({ update_id: id, message: { message_id: id * 10, chat: { id: chat, type }, text } });
const ctx = (submitted: any[]): Ctx => ({ userId: 'u1', walletId: 'w1', chain: 'c', native: 'NATIVE', autoTrade: false, submit: async i => { submitted.push(i); return { state: 'confirmed' }; }, now: () => 1_000_000, quickBuy: 5n });

test('a linked private chat gets the handler\'s answer and the command reaches submit; the offset moves past the update', async () => {
  const api = await mockApi([[msg(7, 42, '/buy TOK 100')], []]); const sub: any[] = [];
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map([[42, () => ctx(sub)]]), pollTimeoutS: 0 });
  assert.equal(await bot.pollOnce(), 1); assert.equal(sub.length, 1); assert.equal(sub[0].amountIn, 100n); assert.equal(sub[0].origin, 'telegram');
  const sent = api.calls.find(c => c.method === 'sendMessage')!; assert.equal(sent.body.chat_id, 42); assert.match(sent.body.text, /state=confirmed/);
  await bot.pollOnce(); assert.equal(api.calls.filter(c => c.method === 'getUpdates')[1].body.offset, 8, 'second poll asks for updates after 7');
  api.close();
});

test('groups are ignored; an unlinked private chat is told to link first and nothing is submitted', async () => {
  const api = await mockApi([[msg(1, 99, '/buy TOK', 'group'), msg(2, 55, '/buy TOK 1')]]); const sub: any[] = [];
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map([[42, () => ctx(sub)]]), pollTimeoutS: 0 });
  await bot.pollOnce(); const sends = api.calls.filter(c => c.method === 'sendMessage');
  assert.equal(sub.length, 0); assert.equal(sends.length, 1); assert.equal(sends[0].body.chat_id, 55); assert.match(sends[0].body.text, /not linked/);
  api.close();
});

test('a message that looks like a private key is deleted from the chat, warned about, and never reaches the handler', async () => {
  const key = '0x' + 'ab'.repeat(32); const api = await mockApi([[msg(3, 42, key)]]); const sub: any[] = [];
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map([[42, () => ctx(sub)]]), pollTimeoutS: 0 });
  await bot.pollOnce(); const del = api.calls.find(c => c.method === 'deleteMessage')!;
  assert.equal(del.body.message_id, 30); assert.match(api.calls.find(c => c.method === 'sendMessage')!.body.text, /deleted your message/); assert.equal(sub.length, 0);
  api.close();
});

test('a redelivered update is handled once (update_id dedupe)', async () => {
  const api = await mockApi([[msg(5, 42, '/buy TOK 1')], [msg(5, 42, '/buy TOK 1')]]); const sub: any[] = [];
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map([[42, () => ctx(sub)]]), pollTimeoutS: 0 });
  await bot.pollOnce(); await bot.pollOnce(); assert.equal(sub.length, 1); api.close();
});

test('long replies are split at 4096 characters; the handler failing on one update does not stop the loop', async () => {
  const api = await mockApi([[msg(1, 42, '/boom'), msg(2, 42, '/buy TOK 2')]]); const sub: any[] = []; let n = 0;
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map([[42, () => { if (n++ === 0) throw new Error('db down'); return ctx(sub); }]]), pollTimeoutS: 0 });
  await bot.pollOnce(); assert.equal(sub.length, 1); assert.match(bot.log[0], /db down/); api.close();
  const api2 = await mockApi([[msg(9, 42, 'hello')]]);
  const long = new TelegramBot({ token: TOKEN, apiBase: api2.base, links: new Map([[42, () => ({ ...ctx([]), autoTrade: false })]]), pollTimeoutS: 0 });
  (long as any).send = TelegramBot.prototype['send' as keyof TelegramBot]; await (long as any).send(42, 'x'.repeat(9000));
  assert.deepEqual(api2.calls.filter(c => c.method === 'sendMessage').map(c => c.body.text.length), [4096, 4096, 808]); api2.close();
});

test('API errors never leak the token; retry_after is honoured by run()', async () => {
  const api = await mockApi([]); api.fail({ status: 429, body: { ok: false, description: `Too Many Requests: token ${TOKEN}`, parameters: { retry_after: 3 } } });
  const bot = new TelegramBot({ token: TOKEN, apiBase: api.base, links: new Map(), pollTimeoutS: 0 });
  await assert.rejects(bot.pollOnce(), (e: any) => !e.message.includes('SECRET-TOKEN') && e.retryAfter === 3);
  api.fail({ status: 429, body: { ok: false, description: 'slow down', parameters: { retry_after: 3 } } }); const slept: number[] = []; let rounds = 0;
  await bot.run(() => rounds++ >= 2, async ms => { slept.push(ms); });
  assert.equal(slept[0], 3000); assert.ok(bot.log.every(l => !l.includes('SECRET-TOKEN')));
  const dead = new TelegramBot({ token: TOKEN, apiBase: 'http://127.0.0.1:1', links: new Map() });
  await assert.rejects(dead.pollOnce(), (e: Error) => !e.message.includes('SECRET-TOKEN') && /unreachable/.test(e.message)); api.close();
  assert.throws(() => new TelegramBot({ token: '', links: new Map() }), /token required/);
});
