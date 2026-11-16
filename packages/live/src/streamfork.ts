/** EVENT-DRIVEN TRIGGER AND JITO-STYLE SUBMITTER ON A LOCAL SOLANA VALIDATOR (real pump.fun program, cloned live curve, fake SOL).
 *  Part 1 measures how long a limit sell takes to fire after the price moves: (a) polled by a 5-second timer only, (b) the same plus an `accountSubscribe` stream on the curve that runs the trader on each change.
 *  Part 2 sends a real buy through `JitoSubmitter` to a STAND-IN block engine on loopback (it implements getTipAccounts and sendBundle and forwards the transaction to the validator), and checks the tip landed.
 *  Honest limits: a local validator has one node and no competition, so these numbers show the mechanism and the polling delay it removes, not mainnet latency; Jito itself is not contacted for sends.
 *  usage: npm run verify:stream (needs ALCHEMY_API_KEY in .env and solana-test-validator). Writes a redacted report to docs/live-verification/. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolanaStream, ChangeTrigger, JitoSubmitter, pumpAddresses } from '../../sol/src/index.ts';
import { startPumpValidator } from './pumpenv.ts';
import type { PumpEnv } from './pumpenv.ts';
import type { Check } from './localrun.ts';
import { Trader } from '../../sdk/src/trader.ts';

const PORT = 8970, SOLN = 10n ** 9n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)), DONE = ['finalized', 'failed', 'expired'], POLL_MS = 5000, TIP = 12_345n;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export async function runStream(env: PumpEnv): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [], check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const rpc = env.rpc, T = env.mint, signer = new DevSolSigner(), curveAddr = pumpAddresses(T, T, env.tokenProgram).bondingCurve;
  const airdrop = async (a: string, l: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(l)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } throw new Error('airdrop not confirmed'); };
  const [w1, mover, tipAcct, jw] = [signer.add(), signer.add(), signer.add(), signer.add()]; for (const w of [w1, mover, jw]) await airdrop(w, 60n * SOLN); await airdrop(tipAcct, SOLN);
  const pol = (): WalletPolicy => ({ userId: 'u1', chains: ['sol-local'], allowedVenues: ['pump'], maxPerTx: { [NATIVE]: 50n * SOLN, [T]: 10n ** 21n }, dailyLimit: { [NATIVE]: 10_000n * SOLN, [T]: 10n ** 22n }, destinations: [], deviceSecret: 'dev' });
  const pols = new Map<string, WalletPolicy>([[w1, pol()], [mover, pol()], [jw, pol()]]);
  const mkChain = (submitter?: any) => new SolanaChain({ id: 'sol-local', wsol: 'So11111111111111111111111111111111111111112', pools: [], pump: { mints: [T] }, submitter }, rpc, signer);
  const mkTrader = (chain: SolanaChain) => { const dir = mkdtempSync(join(tmpdir(), 'memedesk-stream-')); const engine = new Engine({ store: Store.open(join(dir, 'e.json')), chain, signer: new PolicySigner(new Map([...pols.keys()].map(w => [w, 'x'])), pols), router: new Router(chain), platformFeeBps: 0 }); return { engine, trader: new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: join(dir, 't') }) }; };
  const confirmedAt = async (sig: string) => { for (let i = 0; i < 400; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); const st = s.value[0]?.confirmationStatus; if (st === 'confirmed' || st === 'finalized') return Date.now(); await sleep(25); } throw new Error('not confirmed'); };
  const tokOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: T }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)).catch(() => 0n);
  const chain = mkChain(); await chain.refresh('venues'); { const v: any = chain.venues()[0]; console.log('venue:', v ? `${v.id.slice(0, 14)} tradable ${v.tradable} reason ${v.tradableReason ?? '-'}` : 'none'); } const { engine, trader } = mkTrader(chain);
  const settle = async (key: string) => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < 90_000) { t = await trader.advance(key); if (['confirmed', ...DONE].includes(t.state)) return t; await sleep(300); } return t; };
  const first = await trader.buy({ walletId: w1, token: T, amount: 3n * SOLN, slippageBps: 800, key: 'seed-buy' }); const fb = await settle(first.key);
  facts.push(`curve ${T.slice(0, 6)}..., polling timer ${POLL_MS} ms; seed buy ${fb.state}${fb.failure ? ' (' + fb.failure.slice(0, 120) + ')' : ''}`); console.log(facts.at(-1));

  // PART 1: how soon does a limit sell fire after the price moves?
  const stream = new SolanaStream({ wsUrl: `ws://127.0.0.1:${PORT + 1}`, log: m => console.log('  stream:', m) }); stream.start();
  const trig = new ChangeTrigger(() => trader.tick(), { minIntervalMs: 100 }); const unwatch = stream.watch(curveAddr, trig.onChange);
  for (let i = 0; i < 50 && !stream.connected; i++) await sleep(100);
  check('S1 the WebSocket stream connects to the validator and subscribes to the curve account', stream.connected, `reconnects ${stream.reconnects}`);
  const lat: Record<'poll' | 'stream', number[]> = { poll: [], stream: [] };
  const timer = setInterval(() => { void trader.tick(); }, POLL_MS);
  for (let round = 0; round < 4; round++) {
    const mode = round % 2 === 0 ? 'poll' : 'stream'; if (mode === 'poll') unwatch(); const off = mode === 'stream' ? stream.watch(curveAddr, trig.onChange) : () => {};
    await sleep(1500); const p = trader.spotE18(T)!, id = `ls${round}`;
    const ord = await trader.limitSell({ id, walletId: w1, token: T, amount: (await tokOf(w1)) / 10n, priceE18: String(p * 103n / 100n), slippageBps: 1500 });
    await sleep(800);   // let a tick see "not met" first
    const up = await trader.buy({ walletId: mover, token: T, amount: 6n * SOLN, slippageBps: 2000, key: `up${round}` });
    let sigHash = ''; for (let i = 0; i < 200 && !sigHash; i++) { sigHash = trader.trade_(up.key)?.txHash ?? ''; if (!sigHash) { await trader.advance(up.key).catch(() => {}); await sleep(50); } }
    const t0 = await confirmedAt(sigHash); let fired = 0; for (let i = 0; i < 400; i++) { await sleep(25); const o = trader.getOrder(ord.id); if (o && o.status !== 'active') { fired = Date.now(); break; } }
    const ms = fired ? fired - t0 : -1; if (ms >= 0) lat[mode].push(ms); console.log(`  round ${round} (${mode}): order fired ${ms} ms after the price move confirmed; order ${JSON.stringify(trader.orderStatus(ord.id), (_k, v) => typeof v === 'bigint' ? v.toString() : v)}; spot ${trader.spotE18(T)} vs trigger ${p * 103n / 100n}`);
    await settle(up.key); const down = await trader.sell({ walletId: mover, token: T, pctBps: 10000, slippageBps: 2000, key: `down${round}` }); await settle(down.key); off(); if (mode === 'poll') stream.watch(curveAddr, trig.onChange);
    for (let i = 0; i < 60; i++) { const o = trader.getOrder(ord.id); if (o && ['fired'].includes(o.status) && DONE.includes(engine.d.store.records.get(`order:${ord.id}:a0`)?.state ?? '')) break; await sleep(500); }
  }
  clearInterval(timer);
  const mp = median(lat.poll), ms = median(lat.stream);
  check('S2 every round fired (no order was missed)', lat.poll.length === 2 && lat.stream.length === 2, `poll ${lat.poll.join(',')} ms; stream ${lat.stream.join(',')} ms`);
  check('S3 with the stream, a limit sell fires in under 1.5 seconds after the price move is confirmed', lat.stream.length > 0 && Math.max(...lat.stream) < 1500, `stream ${lat.stream.join(', ')} ms`);
  facts.push(`fire delay after the price move confirmed: polling every ${POLL_MS} ms -> ${lat.poll.join(', ')} ms (median ${mp}); with the account stream -> ${lat.stream.join(', ')} ms (median ${ms}); stream events seen ${stream.events}, trigger runs ${trig.fired}, reconnects ${stream.reconnects}`);
  stream.stop();

  // PART 2: Jito-style submit through a stand-in block engine
  const calls: string[] = []; let forwarded: string | undefined;
  const engineSrv = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const b = JSON.parse(Buffer.concat(chunks).toString()); calls.push(b.method); let result: unknown; try {
    if (b.method === 'getTipAccounts') result = [tipAcct]; else if (b.method === 'sendBundle') { forwarded = await rpc.call<string>('sendTransaction', [b.params[0][0], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]); result = 'stand-in-bundle-1'; } else result = null; } catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { message: (e as Error).message.slice(0, 160) } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result })); });
  await new Promise<void>(r => engineSrv.listen(0, '127.0.0.1', r)); const eurl = `http://127.0.0.1:${(engineSrv.address() as { port: number }).port}/api/v1`;
  const jchain = mkChain(new JitoSubmitter({ url: eurl, tipLamports: TIP })); await jchain.refresh('venues'); const J = mkTrader(jchain);
  const tipBefore = BigInt((await rpc.call<any>('getBalance', [tipAcct, { commitment: 'confirmed' }])).value), tb = await tokOf(jw);
  const jb = await J.trader.buy({ walletId: jw, token: T, amount: SOLN, slippageBps: 800, key: 'jito-buy' }); const jr = await (async () => { const t0 = Date.now(); let t: any; while (Date.now() - t0 < 90_000) { t = await J.trader.advance(jb.key); if (['finalized', 'failed', 'expired'].includes(t.state)) return t; await sleep(500); } return t; })();
  const tipAfter = BigInt((await rpc.call<any>('getBalance', [tipAcct, { commitment: 'confirmed' }])).value);
  check('S4 a buy sent through the Jito submitter finalizes, the block engine got getTipAccounts then sendBundle, and the validator received the same signature we computed', jr.state === 'finalized' && calls.includes('getTipAccounts') && calls.includes('sendBundle') && forwarded === jr.txHash, `state ${jr.state}, calls ${calls.join(',')}, forwarded ${forwarded?.slice(0, 8)} vs ${jr.txHash?.slice(0, 8)}, failure ${jr.failure}`);
  check('S5 the tip landed: the tip account gained exactly the configured tip, and the wallet\'s tokens rose by the fill', tipAfter - tipBefore === TIP && (await tokOf(jw)) - tb === BigInt(jr.fill?.received ?? 0), `tip ${tipAfter - tipBefore} vs ${TIP}`);
  engineSrv.close(); return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Event-driven trigger and Jito-style submitter on a local Solana validator', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with the pump.fun program and a live curve cloned. NOT mainnet. Fake SOL, throwaway keys.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '', '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- A single local validator has no network latency, no competing bots and no real leader schedule: these timings show the mechanism and the polling delay it removes, not mainnet latency.', '- The block engine here is a stand-in on loopback. Real Jito behaviour (auction, bundle landing, tip economics, rate limits and auth) was NOT exercised for sends. Only the real getTipAccounts answer was read, separately.', '- An RPC WebSocket is not a validator-level feed; Yellowstone gRPC is not implemented.', '- Four rounds (2 per mode) is a small sample.'].join('\n') };
}
async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  let env: PumpEnv | undefined;
  try { env = await startPumpValidator(key, PORT); const r = await runStream(env), rep = report(env.url, r); mkdirSync('docs/live-verification', { recursive: true }); const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-stream-jito.md`; writeFileSync(file, env.redact(rep.text)); console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1); }
  catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('streamfork.ts')) main();
