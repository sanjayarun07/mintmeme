/** TELEGRAM TRADING ON THE FORK TERMINAL. Starts the real fork terminal (`TERMINAL_MODE=fork`: a local anvil fork of Ethereum mainnet, throwaway wallets, fake ETH) in a child process
 *  and points its Telegram bot at a FAKE Bot API on loopback. A linked chat then buys and sells USDC on the real Uniswap V2 pool of the fork through our engine.
 *  No real Telegram message is sent, no real token is used, nothing is sent to mainnet. usage: npm run verify:telegram-fork (needs ALCHEMY_API_KEY in .env; read-only for the fork). Writes a report to docs/live-verification/. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer as net } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Check } from './localrun.ts';

const TOKEN = '999999:FAKE-fork-token';
const freePort = () => new Promise<number>(r => { const s = net().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const until = async <T>(f: () => Promise<T | undefined | false> | T | undefined | false, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 150)); } };

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const redact = (s: string) => s.split(key).join('***'), checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail: redact(detail) }); };
  const sent: string[] = [], queue: any[] = []; let uid = 0;
  const fake = createServer(async (req, res) => {
    const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer); const body = ch.length ? JSON.parse(Buffer.concat(ch).toString() || '{}') : {}; const m = req.url!.split('/').pop()!; res.setHeader('content-type', 'application/json');
    if (m === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'fake_fork_bot' } }));
    if (m === 'getUpdates') { await new Promise(r => setTimeout(r, 150)); return res.end(JSON.stringify({ ok: true, result: queue.splice(0) })); }
    if (m === 'sendMessage') sent.push(body.text); res.end('{"ok":true,"result":true}');
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r)); const api = `http://127.0.0.1:${(fake.address() as any).port}`, port = await freePort(), forkPort = await freePort(), base = `http://127.0.0.1:${port}`;
  const say = (text: string) => queue.push({ update_id: ++uid, message: { message_id: uid, chat: { id: 4242, type: 'private' }, text } });
  const reply = (n: number) => until(() => sent.length >= n && sent[n - 1]);
  const get = (p: string) => fetch(base + p).then(r => r.json()) as Promise<any>, post = (p: string) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json()) as Promise<any>;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/web/server.ts'], { env: { PATH: process.env.PATH!, PORT: String(port), FORK_PORT: String(forkPort), TERMINAL_MODE: 'fork', ALCHEMY_API_KEY: key, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: api, TELEGRAM_LINKS_FILE: '' }, stdio: 'ignore' });
  const w1 = async () => { const o = await get('/api/overview'); const w = o.wallets.find((x: any) => x.id === 'w1'); return { eth: BigInt(w.native), usdc: BigInt(w.tokens.find((t: any) => t.sym === 'USDC')?.bal ?? 0) }; };
  try {
    const st: any = await until(async () => { try { const j = await get('/api/telegram/status'); return j.state === 'running' && j; } catch { return false; } }, 120000);
    facts.push(`fork terminal started in a child process; bot @${st.bot} (fake Bot API on loopback); network reported by the terminal: ${st.network}`);
    check('F1 the bot starts inside the FORK terminal and reports the fork network', st.network === 'fork' && st.linkedChats === 0, `network ${st.network}, linked ${st.linkedChats}`);
    say('/buy USDC 0.01'); check('F2 before linking, /buy is refused and nothing is traded', /not linked/.test(await reply(1)) && (await w1()).usdc === 0n);
    const lk = await post('/api/telegram/link'); say(`/link ${lk.code}`); check('F3 /link with the one-time code links the chat', /^Linked/.test(await reply(2)));
    const b0 = await w1(); say('/buy USDC 0.01'); const r4 = await reply(3); const b1 = await w1();
    check('F4 /buy USDC 0.01 spends 0.01 ETH (plus gas) and the wallet receives USDC from the real pool; the reply says finalized', /^buy USDC: state=finalized\.$/.test(r4) && b1.usdc > 0n && b0.eth - b1.eth >= 10n ** 16n && b0.eth - b1.eth < 10n ** 16n + 10n ** 16n, `reply "${r4}"; USDC ${b1.usdc}; ETH spent incl. gas ${b0.eth - b1.eth}`);
    const half = b1.usdc / 2n, halfTxt = `${half / 1_000_000n}.${(half % 1_000_000n).toString().padStart(6, '0')}`; say(`/sell USDC ${halfTxt}`); const r5 = await reply(4); const b2 = await w1();
    check('F5 /sell USDC <half> sells exactly that much USDC and the wallet holds that much less USDC', /^sell USDC: state=finalized\.$/.test(r5) && b1.usdc - b2.usdc === half, `reply "${r5}"; USDC sold ${b1.usdc - b2.usdc} of ${half}`);
    const txs: any[] = await get('/api/txs'); check('F6 the trades appear in the terminal as Telegram-origin transactions (at least two records)', txs.filter(t => t.origin === 'telegram').length >= 2, `${txs.filter(t => t.origin === 'telegram').length} telegram-origin records`);
    say('/buy DOGE 0.01'); const r7 = await reply(5); say('/buy USDC abc'); const r8 = await reply(6); say('/buy USDC 0.0000000000000000001'); const r9 = await reply(7);
    check('F7 an unknown token and bad amounts get plain explanations and trade nothing', /not sent\. Unknown token.*USDC only/.test(r7) && /number such as 0\.01/.test(r8) && /at most 18 decimal/.test(r9), `${r7} | ${r8} | ${r9}`);
    const b3 = await w1(); say('/buy USDC 6'); const r10 = await reply(8); const b4 = await w1();
    check('F8 a buy over the wallet\'s per-transaction limit (6 ETH, limit 5) is stopped by the same wallet policy as the web and spends no ETH and is reported as failed', /state=failed/.test(r10) && b4.eth === b3.eth, `reply "${r10.slice(0, 160)}"; ETH change ${b3.eth - b4.eth}`);
    await post('/api/telegram/unlink'); say('/buy USDC 0.01'); check('F9 after unlinking, the chat can no longer trade', /not linked/.test(await reply(9)));
    check('F10 neither the bot token nor the Alchemy key appears in any reply', sent.every(s => !s.includes(TOKEN) && !s.includes(key)));
  } catch (e) { check('F0 the run completed without an error', false, redact((e as Error).message)); }
  finally { child.kill(); fake.close(); }
  const pass = checks.every(c => c.pass);
  const text = ['# Telegram trading on the fork terminal', '', `Run: ${new Date().toISOString()}`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: with `TERMINAL_MODE=fork`, a chat linked by one-time code buys and sells USDC on a local anvil fork of Ethereum mainnet (real Uniswap V2 pool state, fake ETH, throwaway keys) through our engine and the wallet policy, with plain-decimal amounts. The Telegram side is a fake Bot API on loopback.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Real Telegram: the fake Bot API stands in for it (the practice terminal was linked and traded from a real Telegram chat on 2026-11-15; the fork terminal was not).', '- Only USDC against ETH, only the first dev wallet, one account.', '- No live chain; nothing was sent to mainnet.', ''].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-telegram-fork.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + c.detail}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
