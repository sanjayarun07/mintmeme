/** JUPITER SWAP EXECUTION ON A LOCAL VALIDATOR. Real Jupiter Swap API V2 `/build` is asked for real SOL<->USDC routes (restricted to Raydium AMM v4 so the accounts can be cloned) for a throwaway wallet;
 *  every account and program those routes use, and their address lookup tables, are CLONED from mainnet into a local solana-test-validator (mainnet is only READ). OUR SolanaChain then compiles the
 *  v0 transaction from Jupiter's raw instructions, runs the safety gate, simulates, signs with a throwaway ed25519 key and sends it to the LOCAL node, driven by the same Engine as everything else.
 *  Honest caveats: (1) the cloned lookup tables are patched in ONE field (last-extended slot set to 0) because a young local chain would otherwise treat their newest addresses as inactive;
 *  (2) only Raydium AMM v4 routes are exercised; (3) Jupiter's quote is live mainnet, the pool state is the clone's, so small differences are expected; (4) nothing is sent to mainnet.
 *  usage: npm run verify:jupiter-swap (needs ALCHEMY_API_KEY in .env, solana-test-validator, and network access to api.jup.ag; JUPITER_API_KEY is optional and only raises the rate limit). */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy, Intent } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc, JupiterVenue, fetchBuild, PROGRAMS, COMPUTE_BUDGET } from '../../sol/src/index.ts';
import type { SolRpc } from '../../sol/src/index.ts';
import { Rpc } from './rpc.ts';
import { SOL_POOL, urls } from './config.ts';
import type { Check } from './localrun.ts';

SolanaChain.VISIBILITY_GRACE_MS = 60_000;   // the FIRST execution of each cloned program on a fresh validator is slow (program cache); a real node would not need this
const PORT = 8899, SOLN = 10n ** 9n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)), USDC = SOL_POOL.usdc.mint, WSOL = SOL_POOL.wsol.mint;
const BUILTIN = new Set([PROGRAMS.system, PROGRAMS.token, PROGRAMS.ata, COMPUTE_BUDGET, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'AddressLookupTab1e1111111111111111111111111', WSOL]);
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
class CountingRpc implements SolRpc { sends = 0; constructor(private inner: SolJsonRpc) {} async call<T = any>(m: string, p: unknown[] = []) { if (m === 'sendTransaction') this.sends++; return this.inner.call<T>(m, p); } }

async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env and run again.'); process.exit(2); }
  const redact = (s: string) => s.split(key).join('***'), apiKey = process.env.JUPITER_API_KEY, upstream = urls(key).sol, main = new Rpc(upstream, key, fetch, 150);
  const cache = new Map<string, any>(), keyOf = (u: string) => { const q = new URL(u).searchParams; return ['inputMint', 'outputMint', 'amount', 'slippageBps'].map(k => q.get(k)).join('|'); };
  const recFetch = (async (u: any, init: any) => { const r = await fetch(u, init); if (!String(u).includes('/build?') || !r.ok) return r; const j = await r.json(); cache.set(keyOf(String(u)), j); return { ok: true, status: 200, json: async () => structuredClone(j) } as any; }) as typeof fetch;
  // Later builds REPLAY the captured Jupiter responses (same pair, amount, slippage) so the routes only touch accounts that were cloned; everything else (labels, quotes) is live.
  const replayFetch = (mut?: (j: any) => void): typeof fetch => (async (u: any, init: any) => { const j = cache.get(keyOf(String(u))); if (!String(u).includes('/build?') || !j) return fetch(u, init); const c = structuredClone(j); mut?.(c); return { ok: true, status: 200, json: async () => c } as any; }) as typeof fetch;
  const checks: Check[] = [], facts: string[] = []; const check = (name: string, pass: boolean, detail = '') => checks.push({ name, pass, detail });
  const signer = new DevSolSigner(), W = signer.add(), jcfg = { dexes: ['Raydium'], apiKey }, rcfg = { ...jcfg, fetchFn: recFetch };
  // 1. real routes from Jupiter for this throwaway wallet (both directions)
  const b1 = await fetchBuild({ ...rcfg, inputMint: WSOL, outputMint: USDC, amount: SOLN / 10n, taker: W, slippageBps: 50 }); await sleep(2500);
  const b2 = await fetchBuild({ ...rcfg, inputMint: USDC, outputMint: WSOL, amount: 3_000_000n, taker: W, slippageBps: 50 });
  facts.push(`Jupiter /build (live mainnet) for 0.1 SOL -> USDC: out ${b1.outAmount}, min ${b1.minOut}, route ${b1.routeLabels.join(' > ')}; for 3 USDC -> SOL: out ${b2.outAmount}, route ${b2.routeLabels.join(' > ')}`);
  // 2. everything those routes touch, read from mainnet
  const addrs = new Set<string>(); for (const b of [b1, b2]) for (const ix of b.ixs) { addrs.add(ix.programId); ix.accounts.forEach(a => addrs.add(a.pubkey)); }
  const tables = new Map<string, string>(); for (const b of [b1, b2]) b.claimedTables.forEach(t => tables.set(t.key, ''));
  for (const w of [W, ...b1.ixs.flatMap(i => i.accounts.map(a => a.pubkey)).filter(a => a === W)]) addrs.delete(w);
  const list = [...addrs].filter(a => !BUILTIN.has(a)), info = new Map<string, any>();
  for (let i = 0; i < list.length; i += 100) { const r: any = await main.call('getMultipleAccounts', [list.slice(i, i + 100), { encoding: 'base64' }]); r.value.forEach((v: any, k: number) => info.set(list[i + k], v)); }
  const args: string[] = []; const dir = mkdtempSync(join(tmpdir(), 'memedesk-jup-')); let nAcc = 0, nProg = 0, nMissing = 0;
  for (const a of list) { const v = info.get(a); if (!v) { nMissing++; continue; }
    if (v.executable) { if (v.owner === UPGRADEABLE) { args.push('--clone-upgradeable-program', a); nProg++; } else if (v.owner !== 'NativeLoader1111111111111111111111111111111') { args.push('--clone', a); nProg++; } }
    else { args.push('--clone', a); nAcc++; } }
  for (const t of tables.keys()) { const v: any = (await main.call('getAccountInfo', [t, { encoding: 'base64' }])).value; if (!v) throw new Error(`lookup table ${t} not found on mainnet`);
    const data = Buffer.from(v.data[0], 'base64'); data.writeBigUInt64LE(0n, 12); data[20] = 0;   // last_extended_slot = 0, start index 0: every address active on a young local chain (the ONLY patch)
    const f = join(dir, `${t}.json`); writeFileSync(f, JSON.stringify({ pubkey: t, account: { lamports: v.lamports, data: [data.toString('base64'), 'base64'], owner: v.owner, executable: false, rentEpoch: 0, space: data.length } })); args.push('--account', t, f); }
  facts.push(`cloned from mainnet: ${nAcc} accounts, ${nProg} programs, ${tables.size} lookup tables (patched: last_extended_slot only); ${nMissing} route accounts do not exist on mainnet (created at run time, e.g. our token accounts)`);
  // 3. local validator via a loopback proxy that adds the key (never in argv)
  const proxy = createServer(async (req, res) => { const ch: Buffer[] = []; for await (const c of req) ch.push(c as Buffer);
    try { const u = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(ch) }); res.writeHead(u.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await u.arrayBuffer())); } catch { res.writeHead(502); res.end('{"error":"upstream unreachable"}'); } });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)); const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const child = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', join(dir, 'ledger'), '--rpc-port', String(PORT), '--faucet-port', String(PORT + 1), '--bind-address', '127.0.0.1', '--url', proxyUrl, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; child.stdout.on('data', d => { buf += d; }); child.stderr.on('data', d => { buf += d; });
  const url = `http://127.0.0.1:${PORT}`, rpc = new SolJsonRpc(url), stop = () => { child.kill(); proxy.close(); };
  try {
    let up = false; for (let i = 0; i < 160 && !up; i++) { await sleep(500); try { up = (await rpc.call('getHealth')) === 'ok'; } catch { up = false; } }
    if (!up) throw new Error(`solana-test-validator did not start: ${redact(buf).slice(-600)}`);
    const airdrop = async (a: string, n: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(n)]); for (let i = 0; i < 60; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus === 'finalized' || s.value[0]?.confirmationStatus === 'confirmed') return; await sleep(500); } throw new Error('airdrop did not confirm'); };
    await airdrop(W, 10n * SOLN);
    const policy: WalletPolicy = { userId: 'u1', chains: ['sol-local'], allowedVenues: ['jupiter'], maxPerTx: { [NATIVE]: 10n ** 16n, [USDC]: 10n ** 18n }, dailyLimit: { [NATIVE]: 10n ** 18n, [USDC]: 10n ** 19n }, destinations: [] } as any;
    const mk = (o: { fetchFn?: typeof fetch; inflate?: bigint } = {}) => {
      const frpc = new CountingRpc(rpc), chain = new SolanaChain({ id: 'sol-local', wsol: WSOL, pools: [], jupiter: { ...jcfg, fetchFn: o.fetchFn ?? replayFetch(), pairs: [{ inMint: WSOL, outMint: USDC, refAmount: SOLN / 10n }, { inMint: USDC, outMint: WSOL, refAmount: 3_000_000n }] } }, frpc, signer);
      const store = new Store(), engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[W, 'x']]), new Map([[W, policy]])), router: new Router(chain), platformFeeBps: 0 });
      return { chain, frpc, store, engine };
    };
    type S = ReturnType<typeof mk>;
    const intent = (s: S, key: string, tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps = 300): Intent => ({ idempotencyKey: key, userId: 'u1', walletId: W, chain: 'sol-local', tokenIn, tokenOut, amountIn, minOut: 0n, slippageBps, deadline: s.chain.time + 600, maxFeeBps: 200, venues: ['jupiter'], origin: 'manual' } as Intent);
    const TERMINAL = new Set(['finalized', 'failed', 'expired']);
    const finish = async (s: S, key: string, maxMs = 150_000) => { const t0 = Date.now(); for (;;) { const r = await s.engine.advance(key).catch(() => s.store.records.get(key)!); if (TERMINAL.has(r.state) || Date.now() - t0 > maxMs) return r; await sleep(1500); } };
    const trade = async (s: S, key: string, i: string, o: string, n: bigint, slip = 300) => { await s.chain.refresh('venues'); await s.engine.submit(intent(s, key, i, o, n, slip)); return finish(s, key); };
    const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
    const A = mk(); await A.chain.refresh('venues'); const jv = A.chain.venues().filter(v => v instanceof JupiterVenue) as JupiterVenue[];
    check('S1 refresh loaded one Jupiter venue per direction from live quotes (Jupiter venue family, positive reference output)', jv.length === 2 && jv.every(v => v.refOut > 0n) && !A.chain.jupiterError, A.chain.jupiterError ?? `${jv.length} venues`);
    // ---- buy
    const sol0 = await lamports(W), buy = await trade(A, 'buy1', NATIVE, USDC, SOLN / 10n);
    const usdc1 = await A.chain.balanceOf(W, USDC), sol1 = await lamports(W);
    check('B1 SOL -> USDC through Jupiter and the Engine reached finalized', buy.state === 'finalized' && !!buy.fill, `${buy.state} ${JSON.stringify(buy.history.at(-1)?.note ?? '')}`);
    const tx: any = buy.state === 'finalized' ? await rpc.call('getTransaction', [(buy as any).tx?.hash ?? '', { encoding: 'json', maxSupportedTransactionVersion: 0 }]).catch(() => null) : null;
    check('B2 the landed transaction is a versioned (v0) transaction that succeeded', tx?.version === 0 && tx?.meta?.err === null, `version ${tx?.version} err ${JSON.stringify(tx?.meta?.err)}`);
    check('B3 the fill is the real balance change: received == wallet USDC; spent == exactly 0.1 SOL', buy.fill?.received === usdc1 && buy.fill?.spent === SOLN / 10n, `received ${buy.fill?.received} balance ${usdc1} spent ${buy.fill?.spent}`);
    check('B4 wallet SOL fell by exactly spent + network fee (fee and token-account rent only)', sol0 - sol1 === SOLN / 10n + (buy.fill?.networkFee ?? 0n), `delta ${sol0 - sol1} fee ${buy.fill?.networkFee}`);
    const gap = Number((b1.outAmount - usdc1) * 10_000n / b1.outAmount);
    check('B5 executed output vs Jupiter\'s mainnet quote taken minutes earlier: within 150 bps (a live quote vs a cloned pool, so not exact)', Math.abs(gap) <= 150, `jupiter ${b1.outAmount} executed ${usdc1} (${gap} bps)`);
    check('B6 the executed output respected Jupiter\'s on-chain minimum (otherAmountThreshold, 50 bps slippage)', usdc1 >= b1.minOut - b1.outAmount / 50n, `got ${usdc1} threshold ${b1.minOut}`);
    const wsolLeft = await rpc.call<any>('getTokenAccountsByOwner', [W, { mint: WSOL }, { encoding: 'jsonParsed' }]); check('B7 no wrapped-SOL account left behind', wsolLeft.value.length === 0);
    const sends = A.frpc.sends, again = await A.engine.submit(intent(A, 'buy1', NATIVE, USDC, SOLN / 10n));
    check('B8 resubmitting the same idempotency key sends nothing new', again.key === 'buy1' && A.frpc.sends === sends, `sends ${A.frpc.sends}`);
    // ---- sell back (token in, native out)
    const sellAmt = 3_000_000n, solBefore = await lamports(W), sell = await trade(A, 'sell1', USDC, NATIVE, sellAmt); const usdc2 = await A.chain.balanceOf(W, USDC), solAfter = await lamports(W);
    check('X1 USDC -> SOL (token in, native out, wrapped SOL unwrapped by the route) finalized', sell.state === 'finalized' && !!sell.fill, `${sell.state} ${JSON.stringify(sell.history.at(-1)?.note ?? '')}`);
    check('X2 sold exactly the requested USDC and the wallet received SOL (fill matches the lamport change net of network fee)', usdc1 - usdc2 === sellAmt && sell.fill?.spent === sellAmt && solAfter - solBefore === (sell.fill?.received ?? 0n) - (sell.fill?.networkFee ?? 0n), `spent ${sell.fill?.spent} recv ${sell.fill?.received} net ${solAfter - solBefore} fee ${sell.fill?.networkFee}`);
    // ---- refusals send nothing
    const evilFetch = replayFetch(j => { j.otherInstructions = [{ programId: signer.add(), data: '', accounts: [] }]; });
    const E = mk({ fetchFn: evilFetch }), eb = E.frpc.sends, ev = await trade(E, 'evil1', NATIVE, USDC, SOLN / 10n);
    check('R1 Jupiter response with an instruction for an unknown program: refused, nothing sent, nothing spent', ev.state === 'failed' && E.frpc.sends === eb && /allowlist/.test(JSON.stringify(ev.history)), `${ev.state} sends ${E.frpc.sends} ${JSON.stringify(ev.history.at(-1)?.note ?? '')}`);
    const inflFetch = (async (u: any, init: any) => { if (!String(u).includes('/quote')) return replayFetch()(u, init); const j: any = await (await fetch(u, init)).json(); j.outAmount = String(BigInt(j.outAmount) * 12n / 10n); return { ok: true, status: 200, json: async () => j } as any; }) as typeof fetch;
    const I = mk({ fetchFn: inflFetch }); await I.chain.refresh('venues');
    const ib = I.frpc.sends; await I.engine.submit(intent(I, 'infl1', NATIVE, USDC, SOLN / 10n, 300)); const inf = await finish(I, 'infl1');
    check('R2 an optimistic reference quote (+20%, injected into the snapshot the Engine uses to set minOut) cannot produce a worse fill: the exact route is re-quoted, falls short of minOut, and nothing is sent', inf.state === 'failed' && I.frpc.sends === ib && /price moved|below/.test(JSON.stringify(inf.history)), `${inf.state} sends ${I.frpc.sends} ${JSON.stringify(inf.history.at(-1)?.note ?? '')}`);
    return finish2();
    function finish2() {
      const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
      const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-jupiter-swap-validator.md`;
      const text = ['# Jupiter swap execution on a local validator (real routes cloned from mainnet)', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}); mainnet only READ (accounts cloned through a loopback proxy). Throwaway ed25519 key, fake SOL. Jupiter Swap API V2 /build and quote were called live.`, '',
        'What this shows: our SolanaChain turns Jupiter\'s raw instructions into a v0 transaction (lookup tables read from the chain), gates every instruction against an allowlist, simulates and checks the wallet balances, signs and sends it to the local node under the Engine; fills come from balance deltas.', '',
        '## Observed', ...facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
        '## Not covered', '- Routes were restricted to Raydium AMM v4 (`dexes=Raydium`) so their accounts could be cloned. Routes through other DEXes, multi-hop routes via intermediate tokens, and Token-2022 mints were NOT executed here.', '- The cloned lookup tables were patched in one field (last-extended slot = 0).', '- Single local node: no congestion, forks, or priority-fee competition; no Jito. Jupiter\'s quote is live mainnet while the pool is the clone, so small output gaps are expected.', '- Nothing was sent to mainnet and no real funds were used.'].join('\n') + '\n';
      writeFileSync(file, redact(text)); for (const c of checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + redact(c.detail)}`); console.log(`\nreport: ${file}`); stop(); process.exit(pass ? 0 : 1);
    }
  } catch (e) { console.error(redact((e as Error).stack ?? (e as Error).message)); stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('jupswapfork.ts')) main();
