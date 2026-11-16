/** WEB-TERMINAL-ON-FORK: starts the terminal server in real-node mode (TERMINAL_MODE=fork: it starts its own local anvil fork of Ethereum mainnet) and drives its
 *  HTTP API exactly as the browser UI does: overview, quote, trade, mine, txs, notes, orders, pause-entries. Local only: throwaway keys, fake ETH, loopback.
 *  usage: npm run verify:web (needs ALCHEMY_API_KEY in .env and Foundry's anvil/cast). */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Check } from './localrun.ts';

const PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const get = async (p: string) => (await fetch(BASE + p)).json() as Promise<any>;
const post = async (p: string, b: unknown) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<any>;

export async function runWeb(): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const ov = async () => get('/api/overview');
  const usdcOf = (o: any, w: string) => BigInt(o.wallets.find((x: any) => x.id === w).tokens[0]?.bal ?? 0);
  const waitTx = async (key: string, states = ['finalized', 'failed', 'expired']) => { for (let i = 0; i < 30; i++) { const t = (await get('/api/txs')).find((x: any) => x.key === key); if (t && states.includes(t.state)) return t; await post('/api/mine', { n: 1 }); await sleep(250); } return (await get('/api/txs')).find((x: any) => x.key === key); };

  // W1 overview
  const o = await ov(); const tok = o.tokens[0];
  facts.push(`terminal reports: ${o.live?.network}; block ${o.block}; USDC price ${tok.price.toPrecision(4)} ETH per USDC; pool depth ${tok.liquidity} wei`);
  check('W1 overview is real-node mode (simulated=false), shows the network and display units', o.simulated === false && /anvil/.test(o.live.network) && o.live.units.NATIVE.decimals === 18 && o.live.units[tok.address].decimals === 6);
  check('W1 two funded dev wallets, a real USDC token with a sane pool price (ETH per USDC) and non-zero depth', o.wallets.length === 2 && BigInt(o.wallets[0].native) === 10n * 10n ** 18n && tok.sym === 'USDC' && tok.price > 1e-5 && tok.price < 1e-1 && BigInt(tok.liquidity) > 0n, `price ${tok.price}`);
  check('W1 pages with no real-node implementation are listed as unavailable (not faked)', ['Copy trading', 'Portfolio', 'Launch sniper'].every(p => o.unavailable.includes(p)));
  const na = await get('/api/copy'); check('W1 an unavailable endpoint says so plainly instead of returning simulated data', na.ok === false && /not available/.test(na.title), na.title);

  // W2 quote
  const buyAmt = (10n ** 17n).toString();
  const q = await post('/api/quote', { token: tok.address, side: 'buy', amount: buyAmt, slippageBps: 100, walletId: 'w1' });
  check('W2 buy quote: expected output, a lower minimum received, price impact and itemised fees (no platform fee on this port)', q.ok && BigInt(q.expectedOut) > 0n && BigInt(q.minOut) < BigInt(q.expectedOut) && BigInt(q.fees.platform) === 0n && BigInt(q.fees.network) > 0n, JSON.stringify(q).slice(0, 200));
  const qBad = await post('/api/quote', { token: tok.address, side: 'buy', amount: (100n * 10n ** 18n).toString(), slippageBps: 100, walletId: 'w1' });
  check('W2 a quote above the wallet balance carries an error warning (UI shows Add funds)', qBad.ok && qBad.warnings.some((w: any) => w.level === 'error' && /holds/.test(w.text)));

  // W3 buy through the engine; W4 idempotent resubmit
  const before = await ov(); const cid = 'web-' + Math.random().toString(36).slice(2);
  const t1 = await post('/api/trade', { token: tok.address, side: 'buy', amount: buyAmt, slippageBps: 100, walletId: 'w1', clientId: cid });
  const done = await waitTx(t1.key); const after = await ov();
  check('W3 trade went through the engine to a finalized fill; the wallet\'s real USDC balance equals the fill', done?.state === 'finalized' && BigInt(done.fill.received) > 0n && usdcOf(after, 'w1') - usdcOf(before, 'w1') === BigInt(done.fill.received), `${done?.state} ${done?.fill?.received}`);
  check('W3 plain-language messages were produced for the lifecycle (sent, confirmed, final)', (await get('/api/notes')).filter((n: any) => /sent|confirmed|final/.test(n.title)).length >= 3 && (await get('/api/notes')).some((n: any) => /Received [0-9.]+ USDC for [0-9.]+ ETH/.test(n.body)));
  const nTx = (await get('/api/txs')).length; const t1b = await post('/api/trade', { token: tok.address, side: 'buy', amount: buyAmt, slippageBps: 100, walletId: 'w1', clientId: cid });
  check('W4 resubmitting the same client id returns the same trade and sends nothing new (idempotent)', t1b.key === t1.key && (await get('/api/txs')).length === nTx);

  // W5 sell everything (approve + swap as child tx)
  const held = usdcOf(after, 'w1'); const t2 = await post('/api/trade', { token: tok.address, side: 'sell', amount: held.toString(), slippageBps: 100, walletId: 'w1', clientId: cid + 's' });
  const sold = await waitTx(t2.key); const end = await ov();
  check('W5 sell finalized (exact-amount approval handled by the engine); wallet USDC back to zero; ETH received', sold?.state === 'finalized' && usdcOf(end, 'w1') === 0n && BigInt(sold.fill.received) > 0n, `${sold?.state} ${sold?.raw ?? ''}`);
  check('W5 the approval child transaction is hidden from the trade list (one card per trade)', (await get('/api/txs')).every((x: any) => !x.key.endsWith(':approve')));

  // W6 orders
  const price = (await ov()).tokens[0].price;
  const bad = await post('/api/orders', { kind: 'limit_sell', token: tok.address, amount: '1', price: 1 });
  check('W6 limit sell is refused with an honest explanation (not exercised on a real chain)', bad.ok === false && /not available/.test(bad.title));
  const badTr = await post('/api/orders', { kind: 'trailing_stop', token: tok.address, amount: '1', trailPct: 0, walletId: 'w1' });
  check('W6 a trailing stop with an invalid trail is refused with a clear message', badTr.ok === false && /Trail must be/.test(badTr.title));
  const fire = await post('/api/orders', { kind: 'limit_buy', token: tok.address, amount: (5n * 10n ** 16n).toString(), price: price * 1.05, walletId: 'w1' });
  await post('/api/mine', { n: 1 }); await sleep(500); for (let i = 0; i < 12; i++) { await post('/api/mine', { n: 1 }); await sleep(300); }
  const ords = await get('/api/orders'), fired = ords.find((x: any) => x.kind === 'limit_buy');
  check('W6 limit buy with a limit above the market fired from the REAL pool price and its trade finalized', fire.ok && fired?.status === 'fired' && (await get('/api/txs')).some((x: any) => x.origin === 'order' && x.state === 'finalized'), JSON.stringify(fired ?? ords));
  const idle = await post('/api/orders', { kind: 'limit_buy', token: tok.address, amount: (10n ** 16n).toString(), price: price * 0.5, walletId: 'w1' });
  await post('/api/mine', { n: 1 }); const ids = (await get('/api/orders')).find((x: any) => x.status === 'active');
  check('W6 a limit far below market stays active ("Watching the price")', idle.ok && ids?.statusText === 'Watching the price', JSON.stringify(ids));
  const ts = await post('/api/orders', { kind: 'trailing_stop', token: tok.address, amount: (10n ** 6n).toString(), trailPct: 10, walletId: 'w1' });
  const tsHold = await post('/api/trade', { token: tok.address, side: 'buy', amount: (10n ** 16n).toString(), slippageBps: 100, walletId: 'w1', clientId: cid + 'ts' }); await waitTx(tsHold.key);
  const tso = (await get('/api/orders')).find((x: any) => x.kind === 'trailing_stop');
  check('W6 a trailing stop can be placed and stays active ("10% below peak") while the price holds', ts.ok && tso?.status === 'active' && /10% below peak/.test(tso.label), JSON.stringify(tso));
  if (tso) await post('/api/orders/cancel', { id: tso.id });
  const cx = await post('/api/orders/cancel', { id: ids.id }); check('W6 cancelling releases it', cx.ok && (await get('/api/orders')).find((x: any) => x.id === ids.id).status === 'cancelled');

  // W7 pause new automated entries
  const txsBefore = (await get('/api/txs')).length; await post('/api/pause-entries', { paused: true });
  await post('/api/orders', { kind: 'limit_buy', token: tok.address, amount: (10n ** 16n).toString(), price: price * 1.05, walletId: 'w1' });
  for (let i = 0; i < 4; i++) { await post('/api/mine', { n: 1 }); await sleep(300); }
  const notes = await get('/api/notes');
  check('W7 with new entries paused an automated buy is NOT sent and the user is told', (await get('/api/txs')).length === txsBefore && notes.some((n: any) => n.title === 'Automated buy skipped'));
  const man = await post('/api/trade', { token: tok.address, side: 'buy', amount: (10n ** 16n).toString(), slippageBps: 100, walletId: 'w1', clientId: cid + 'm' }); const manDone = await waitTx(man.key);
  check('W7 manual trades are unaffected by the pause', manDone?.state === 'finalized');
  await post('/api/pause-entries', { paused: false });
  return { checks, facts };
}

function report(r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Web terminal on a mainnet fork — real-node API', '', `Run: ${new Date().toISOString()}`, 'Node: the terminal server started its OWN local anvil fork of Ethereum mainnet (TERMINAL_MODE=fork). NOT mainnet. Throwaway keys, fake ETH, dev-only signer.', `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same HTTP endpoints the UI calls now run on OUR engine and EvmRpcChain against a real Uniswap V2 pool: quotes, buys and sells with automatic exact approvals, idempotent resubmits, price orders from real reserves, and the global pause. The browser UI itself was NOT driven by this script.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- The existing UI pages still format amounts as simulator integers and say "Practice network"; the API returns raw base units plus `overview.live.units`, but the UI has not been adapted to them in this run.', '- Copy trading, portfolio, alerts, signals, launch sniper, risk checks, plan and the audit log are NOT available in real-node mode (the API says so).', '- Limit sells are refused; limit buy, take profit, stop loss, bracket and trailing stop are exposed (the trailing stop\'s peak/fire/restart behaviour is verified by verify:snipe, not here). One token (WETH/USDC). State is in memory (restart loses it).'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  const redact = (s: string) => s.split(key).join('***');
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', 'apps/web/server.ts'], { env: { ...process.env, TERMINAL_MODE: 'fork', PORT: String(PORT), FORK_PORT: '8656' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const stop = () => child.kill('SIGTERM');
  try {
    let up = false; for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch(BASE + '/api/overview')).ok; } catch { up = false; } }
    if (!up) throw new Error(`terminal server did not start: ${redact(log).slice(-400)}`);
    const r = await runWeb(), rep = report(r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-web-fork.md`; writeFileSync(file, redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`);
    console.log(`\nreport: ${file}`); stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(redact((e as Error).stack ?? (e as Error).message)); stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('webfork.ts')) main();
