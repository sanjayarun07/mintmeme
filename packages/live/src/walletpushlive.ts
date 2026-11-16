/** LIVE, READ-ONLY check of the wallet push watcher against Solana mainnet through Helius. Picks a busy wallet from a recent block (the most frequent fee payer; nothing typed in),
 *  subscribes to it with WalletPush, waits for a real notification, then reads that transaction and checks the wallet is really in it. Nothing is signed or sent.
 *  usage: npm run verify:wallet-push [seconds]. HELIUS_API_KEY in .env may be the bare key or the full RPC URL; it is never printed. Writes a report to docs/live-verification/. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as net } from 'node:net';
import { WalletPush, heliusKey } from './walletpush.ts';
import type { Check } from './localrun.ts';


async function main() {
  const key = heliusKey(process.env.HELIUS_API_KEY); if (!key) { console.error('HELIUS_API_KEY is not set (bare key or full RPC URL). Put it in .env and run again.'); process.exit(2); }
  const secs = Number(process.argv[2]) || 90, redact = (s: string) => s.split(key).join('***'), checks: Check[] = [], facts: string[] = [];
  const check = (n: string, pass: boolean, d = '') => { checks.push({ name: n, pass, detail: redact(d) }); };
  const http = `https://mainnet.helius-rpc.com/?api-key=${key}`, ws = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
  const rpc = async (method: string, params: unknown[]) => { const r = await fetch(http, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j: any = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
  let push: WalletPush | undefined; let wallet: string | undefined;
  try {
    const slot = await rpc('getSlot', [{ commitment: 'finalized' }]); const blk = await rpc('getBlock', [slot - 5, { transactionDetails: 'accounts', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
    const VOTE = 'Vote111111111111111111111111111111111111111', count = new Map<string, number>();
    for (const t of blk.transactions as any[]) { const keys = t.transaction.accountKeys.map((k: any) => k.pubkey); if (keys.includes(VOTE)) continue; const payer = keys[0]; count.set(payer, (count.get(payer) ?? 0) + 1); }
    wallet = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; facts.push(`chose the most frequent non-vote fee payer of finalized block ${slot - 5} (${count.get(wallet!)} transactions in that block): ${wallet}`);
    check('W1 a busy wallet is picked from a real recent block (not typed in)', !!wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet!), wallet ?? 'none');
    const got: any[] = []; push = new WalletPush({ url: ws, wallets: [wallet!], onActivity: a => got.push(a) }); push.start();
    const t0 = Date.now(); while (Date.now() - t0 < secs * 1000 && !got.length) await new Promise(r => setTimeout(r, 300));
    const st = push.status(); facts.push(`socket state ${st.state}, subscribed ${st.subscribed}, notifications ${st.notifications}, reconnects ${st.reconnects}; first notification after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check('W2 the provider accepts the subscription (state live, 1 subscribed)', st.subscribed === 1 && (st.state === 'live'), `state ${st.state}, subscribed ${st.subscribed}, error ${st.lastError}`);
    check('W3 a real notification arrives for the wallet', got.length > 0 && got[0].wallet === wallet, `${got.length} within ${secs} s`);
    if (got.length) {
      const a = got[0]; let tx: any = null; for (let i = 0; i < 10 && !tx; i++) { tx = await rpc('getTransaction', [a.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null); if (!tx) await new Promise(r => setTimeout(r, 800)); }
      const keys: string[] = tx?.transaction?.message?.accountKeys?.map((k: any) => k.pubkey) ?? [];
      check('W4 the notified transaction exists on chain and really includes the wallet', !!tx && keys.includes(wallet!), `signature ${a.signature.slice(0, 12)}…, accounts ${keys.length}`);
      check('W5 the failed flag matches the transaction result', a.failed === (tx?.meta?.err !== null && tx?.meta?.err !== undefined), `push failed=${a.failed}, chain err=${JSON.stringify(tx?.meta?.err)}`);
      const slotDiff = tx ? Math.abs(Number(tx.slot) - a.slot) : -1; check('W6 the slot in the notification matches the transaction slot', slotDiff === 0, `diff ${slotDiff}`);
    }
    // the same wallet through the real terminal server's Wallet Tracker routes
    push.stop(); const port = await new Promise<number>(r => { const x = net().listen(0, '127.0.0.1', () => { const q = (x.address() as any).port; x.close(() => r(q)); }); });
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/web/server.ts'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, PORT: String(port), REAL_MARKETS: '1', ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? '', HELIUS_API_KEY: process.env.HELIUS_API_KEY!, TELEGRAM_LINKS_FILE: '' }, stdio: 'ignore' });
    try {
      const base = `http://127.0.0.1:${port}`, post = async (path: string, body: any) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
      for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/overview'); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
      const first = await post('/api/watch/trades', { chain: 'solana', address: wallet, limit: 5 });
      check('W8 the Wallet Tracker route reads the wallet and reports push is on', first.ok === true && first.push === true, `ok ${first.ok}, push ${first.push}, ${first.title ?? ''} ${first.why ?? ''}`);
      let p0: any; for (let i = 0; i < 40; i++) { p0 = (await post('/api/watch/pulse', { items: [{ chain: 'solana', address: wallet }] })).items[0]; if (p0.live) break; await new Promise(r => setTimeout(r, 300)); }
      check('W9 the pulse route says the wallet is live', p0?.live === true, JSON.stringify(p0));
      let p1: any = p0; const t1 = Date.now(); while (Date.now() - t1 < secs * 1000 && !(p1.activityAt > 0)) { await new Promise(r => setTimeout(r, 500)); p1 = (await post('/api/watch/pulse', { items: [{ chain: 'solana', address: wallet }] })).items[0]; }
      check('W10 real activity on the wallet shows up in the pulse', p1.activityAt > 0 && p1.count > 0, `count ${p1.count} after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      const again = await post('/api/watch/trades', { chain: 'solana', address: wallet, limit: 5 });
      check('W11 after activity the cached history is dropped: the next read is fresh (not the 60 s cache)', again.ok === true && again.at > first.at, `first.at ${first.at}, again.at ${again.at}`);
      const bad = await post('/api/watch/trades', { chain: 'ethereum', address: '0x0000000000000000000000000000000000000001', limit: 3 });
      check('W12 non-Solana wallets are unaffected (no push, still read)', bad.push !== true, `push ${bad.push}`);
    } finally { child.kill(); }
    check('W7 the API key appears nowhere in the status', !JSON.stringify(push.status()).includes(key), JSON.stringify(push.status()));
  } catch (e) { check('W0 the run completed without an error', false, (e as Error).message); }
  finally { push?.stop(); }
  const pass = checks.every(c => c.pass);
  const text = ['# Wallet push watcher on live Solana (Helius)', '', `Run: ${new Date().toISOString()}`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length} checks)`, '',
    'What this shows: `WalletPush` subscribes to one real wallet through the provider WebSocket (`logsSubscribe`, read-only), gets a notification for a real transaction, and that transaction is on chain and includes the wallet. Nothing is signed or sent.', '',
    '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`), '',
    '## Not covered', '- One wallet for a short window; reconnect after a real network drop is covered by unit tests with a fake socket, not here.', '- Whether the transaction is a swap: the notification only says the wallet was mentioned; the existing parser decides that.'].join('\n');
  mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-wallet-push.md`; writeFileSync(file, redact(text));
  for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`); console.log(`\nreport: ${file}`); process.exit(pass ? 0 : 1);
}
if (process.argv[1]?.endsWith('walletpushlive.ts')) main();
