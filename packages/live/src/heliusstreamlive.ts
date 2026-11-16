/** LIVE, READ-ONLY check that the terminal's launch stream runs on Helius and feeds the Discover page. Starts the real terminal server (real markets, Telegram off) on a free port,
 *  reads /api/launches/stream for a while, and checks: connected through Helius (host only is exposed), real Pump.fun / Raydium creations arrive, each item has the fields Discover shows,
 *  a few of the mints exist on chain, and the key appears nowhere in what the stream says. Nothing is signed or sent. usage: npm run verify:helius-stream [seconds]. Writes a report to docs/live-verification/. */
import { spawn } from 'node:child_process';
import { createServer as net } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { heliusKey, heliusHttp } from './walletpush.ts';
import type { Check } from './localrun.ts';

async function main() {
  const key = heliusKey(process.env.HELIUS_API_KEY); if (!key) { console.error('HELIUS_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const secs = Number(process.argv[2]) || 60, redact = (s: string) => s.split(key).join('***'), checks: Check[] = [], facts: string[] = [];
  const check = (n: string, pass: boolean, d = '') => { checks.push({ name: n, pass, detail: redact(d) }); };
  const port = await new Promise<number>(r => { const x = net().listen(0, '127.0.0.1', () => { const q = (x.address() as any).port; x.close(() => r(q)); }); });
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, PORT: String(port), REAL_MARKETS: '1', ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? '', HELIUS_API_KEY: process.env.HELIUS_API_KEY!, TELEGRAM_BOT_TOKEN: '', TELEGRAM_LINKS_FILE: '' };
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/web/server.ts'], { env, stdio: 'ignore' });
  let raw = '';
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/overview`); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    const ctl = new AbortController(), res = await fetch(`http://127.0.0.1:${port}/api/launches/stream`, { signal: ctl.signal }); const rd = res.body!.getReader(), dec = new TextDecoder(); const t0 = Date.now();
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null; let launches = 0, hello: any = null, last: any = null; const items: any[] = [];
    while (Date.now() - t0 < secs * 1000) {
      pending ??= rd.read(); const r = await Promise.race([pending, new Promise<null>(x => setTimeout(() => x(null), 1000))]); if (!r) continue; pending = null; if (r.done) break;
      raw += dec.decode(r.value, { stream: true });   // (one read stays in flight: a timed-out read must not be abandoned, its chunk would be lost)
      let i: number; while ((i = raw.indexOf('\n\n')) >= 0) { const blk = raw.slice(0, i); raw = raw.slice(i + 2); const ev = /event: (\w+)/.exec(blk)?.[1], data = /data: (.*)/.exec(blk)?.[1]; if (!data) continue; const j = JSON.parse(data);
        if (ev === 'hello') hello = j; if (ev === 'status') last = j; if (ev === 'launch') { launches++; items.push(j); } }
      if (launches >= 20 && Date.now() - t0 > 110000) break;   // a fresh stream is bursty: judge the rate only after a couple of minutes
    }
    ctl.abort();
    // current status: a fresh connection's first event ("hello") carries it; the periodic status events lag behind
    let cur: any = null; try { const c2 = new AbortController(), r2 = await fetch(`http://127.0.0.1:${port}/api/launches/stream`, { signal: c2.signal }), rd2 = r2.body!.getReader(); let buf = ''; const dd = new TextDecoder(); for (let k = 0; k < 20 && !cur; k++) { const x = await rd2.read(); if (x.done) break; buf += dd.decode(x.value, { stream: true }); const m = /event: hello\ndata: (.*)/.exec(buf); if (m) cur = JSON.parse(m[1]).status; } c2.abort(); } catch { /* fall back to the last status event */ }
    const st = cur ?? last ?? hello?.status; facts.push(`stream host ${st?.url}; state ${st?.state}; feeds ${JSON.stringify((st?.feeds ?? []).map((f: any) => [f.name, f.subscribed]))}; received ${st?.received} in ${st?.since ? Math.round((Date.now() - st.since) / 1000) : '?'} s since the stream opened (${st?.since ? ((st.received / Math.max(1, (Date.now() - st.since) / 1000)) * 60).toFixed(1) : '?'} per minute), matched ${st?.matched}, emitted ${st?.emitted}, failed ${st?.failed}, polled ${st?.polled}, last error ${st?.lastError}; ${launches} launches pushed during ${Math.round((Date.now() - t0) / 1000)} s; ${(hello?.items ?? []).length} remembered at connect`);
    check('H1 the stream is connected through Helius (host shown, key not)', st?.state === 'open' && st?.url === 'mainnet.helius-rpc.com', `state ${st?.state}, host ${st?.url}`);
    check('H2 both feeds (Pump.fun creations, Raydium pool creations) are subscribed', (st?.feeds ?? []).length >= 2 && st.feeds.every((f: any) => f.subscribed), JSON.stringify(st?.feeds));
    const perMin = st?.since ? (st.received / Math.max(1, (Date.now() - st.since) / 1000)) * 60 : 0; check('H3 real launches arrive at a realistic rate, measured from when the stream opened (the public endpoint gave about 40 a minute in a side-by-side count)', launches > 0 && perMin >= 20, `${launches} pushed to this client; ${perMin.toFixed(1)} notifications per minute`);
    const fresh = items.filter(i => i.live && i.sym !== undefined);
    check('H4 each live item has what Discover shows (symbol, name, venue, risk verdict, address)', fresh.length > 0 && fresh.every(i => i.sym && i.name !== undefined && i.venue && i.verdict && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(i.contract)), `${fresh.length} items`);
    const sample = fresh.slice(0, 3); let found = 0;
    for (const i of sample) { const j: any = await (await fetch(heliusHttp(key), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [i.contract, { encoding: 'base64' }] }) })).json(); if (j.result?.value) found++; }
    check('H5 sampled mints exist on Solana mainnet', sample.length > 0 && found === sample.length, `${found}/${sample.length} found`);
    check('H6 the Helius key appears nowhere in the stream output', !JSON.stringify([hello, last, items]).includes(key), 'checked hello, status and launch events');
  } catch (e) { check('H0 the run completed without an error', false, (e as Error).message); }
  finally { child.kill(); }
  const pass = checks.every(c => c.pass);
  const text = ['# Solana launch stream on Helius, feeding Discover', '', `Run: ${new Date().toISOString()}`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: the real terminal server, started with real markets and a Helius key, runs its Solana launch stream through Helius and pushes Pump.fun and Raydium creations that the Discover page lists. Nothing is signed or sent.', '', '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`), '',
    '## Not covered', '- A short window, not a completeness audit: launches during a dropped connection are missing (the stream reports its gaps).', '- Tokens on other venues (Orca, Meteora, Pump.fun after migration) are not discovered; this lists creations only.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-helius-stream.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
main();
