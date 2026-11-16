/** End to end: the real practice terminal server in a child process, talking to a FAKE Telegram Bot API on loopback. Nothing leaves the machine and no real token is used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as net } from 'node:net';

const TOKEN = '999999:FAKE-e2e-token';
const freePort = () => new Promise<number>(r => { const s = net().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const until = async <T>(f: () => Promise<T | undefined | false> | T | undefined | false, ms = 45000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('link a chat with a one-time code, trade from it through the real engine, and unlink', async () => {
  const sent: string[] = [], queue: any[] = []; let uid = 0;
  const fake = createServer(async (req, res) => {
    const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const body = ch.length ? JSON.parse(Buffer.concat(ch).toString() || '{}') : {}; const m = req.url!.split('/').pop()!; res.setHeader('content-type', 'application/json');
    if (!req.url!.startsWith(`/bot${TOKEN}/`)) { res.statusCode = 401; return res.end('{"ok":false,"description":"Unauthorized"}'); }
    if (m === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'fake_bot' } }));
    if (m === 'getUpdates') { await new Promise(r => setTimeout(r, 150)); return res.end(JSON.stringify({ ok: true, result: queue.splice(0) })); }
    if (m === 'sendMessage') sent.push(body.text); res.end('{"ok":true,"result":true}');
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r)); const api = `http://127.0.0.1:${(fake.address() as any).port}`, port = await freePort(), base = `http://127.0.0.1:${port}`;
  const say = (text: string) => queue.push({ update_id: ++uid, message: { message_id: uid, chat: { id: 4242, type: 'private' }, text } });
  const reply = async (n: number) => until(() => sent.length >= n && sent[n - 1]);
  const post = (p: string) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json());
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/web/server.ts'], { env: { PATH: process.env.PATH!, PORT: String(port), TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: api, TELEGRAM_LINKS_FILE: '' }, stdio: 'ignore' });
  try {
    const st: any = await until(async () => { try { const j: any = await (await fetch(base + '/api/telegram/status')).json(); return j.state === 'running' && j; } catch { return false; } });
    assert.equal(st.bot, 'fake_bot'); assert.equal(st.linkedChats, 0);

    say('/buy MEME 1000'); assert.match(await reply(1), /not linked/);
    const lk: any = await post('/api/telegram/link'); assert.equal(lk.ok, true); assert.match(lk.code, /^[A-Z2-9]{8}$/);
    say('/link WRONG123'); assert.match(await reply(2), /not valid/);
    say(`/link ${lk.code}`); assert.match(await reply(3), /^Linked/);
    assert.equal(((await (await fetch(base + '/api/telegram/status')).json()) as any).linkedChats, 1);

    const before: any = await (await fetch(base + '/api/overview')).json(), memeBal = (o: any) => BigInt(o.wallets.find((w: any) => w.id === 'w1').tokens.find((t: any) => t.sym === 'MEME')?.bal ?? 0);
    say('/buy MEME 1000'); assert.match(await reply(4), /^buy MEME: state=(confirmed|finalized)/);
    const after: any = await (await fetch(base + '/api/overview')).json(); assert.ok(memeBal(after) > memeBal(before), 'the buy really moved tokens into the wallet');
    const txs: any[] = await (await fetch(base + '/api/txs')).json(); assert.ok(txs.length >= 1, 'the trade is in the transaction list');

    say('/sell MEME 100'); assert.match(await reply(5), /^sell MEME: state=(confirmed|finalized)/);
    say('/buy NOPE 5'); assert.match(await reply(6), /not sent\. Unknown token/);
    say('/buy MEME abc'); assert.match(await reply(7), /whole number/);
    say('/buy MEME 99999999999999999999999'); assert.match(await reply(8), /state=failed|not sent/, 'a trade over the wallet limits is stopped by the same policy as the web');

    assert.deepEqual(await post('/api/telegram/unlink'), { ok: true, removed: 1 });
    say('/buy MEME 1000'); assert.match(await reply(9), /not linked/);
    for (const s of sent) assert.ok(!s.includes(TOKEN), 'the token never appears in a reply');
  } finally { child.kill(); fake.close(); }
});
