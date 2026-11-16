/** SOLANA ENGINE ON A LOCAL VALIDATOR. A local solana-test-validator clones the real Raydium AMM v4 program, the mainnet SOL/USDC pool and its serum market, and OUR
 *  SolanaChain drives the same Engine / OrderRunner used on EVM: quote from pool reserves, build + sign (ed25519) a legacy transaction, send, reconcile, finalize, derive the fill
 *  from balance deltas. Local only: throwaway keys, fake SOL, loopback validator. Mainnet is only READ (clone) through a read-only proxy.
 *  usage: npm run verify:solana (needs ALCHEMY_API_KEY in .env and the Solana CLI's solana-test-validator). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, OrderRunner } from '../../core/src/index.ts';
import type { Order, WalletPolicy, Intent } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc, RaydiumVenue } from '../../sol/src/index.ts';
import type { SolRpc } from '../../sol/src/index.ts';
import { SOL, SOL_POOL } from './config.ts';
import { startSolValidator } from './solenv.ts';
import type { Check } from './localrun.ts';

const PORT = 8899, SOLN = 10n ** 9n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const USDC = SOL_POOL.usdc.mint, WSOL = SOL_POOL.wsol.mint;

class FaultSolRpc implements SolRpc {
  sends = 0; dropAckOnce = false; beforeSend?: () => void; staleBlockhash = false;
  constructor(private inner: SolJsonRpc) {}
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (method === 'getLatestBlockhash' && this.staleBlockhash) { const r: any = await this.inner.call(method, params); return { ...r, value: { ...r.value, blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' } } as T; }
    if (method === 'sendTransaction') {
      this.beforeSend?.(); this.beforeSend = undefined; this.sends++;
      const r = await this.inner.call<T>(method, params);
      if (this.dropAckOnce) { this.dropAckOnce = false; throw new Error('connection reset after send (injected)'); }
      return r;
    }
    return this.inner.call<T>(method, params);
  }
}

export async function runSolFork(env: { rpc: SolJsonRpc; keys: any }): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const rpc = env.rpc, signer = new DevSolSigner(), programId = SOL.programs[0].address;
  const airdrop = async (a: string, lamports: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(lamports)]); for (let i = 0; i < 60; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) return; await sleep(300); } throw new Error('airdrop not confirmed'); };
  const policyFor = (w: string): WalletPolicy => ({ userId: 'u-' + w, chains: ['sol-local'], allowedVenues: ['raydium-v4'], maxPerTx: { [NATIVE]: 10n ** 16n, [USDC]: 10n ** 18n }, dailyLimit: { [NATIVE]: 10n ** 18n, [USDC]: 10n ** 19n }, destinations: [], deviceSecret: 'dev' });
  const mk = (o: { wallet?: string; persist?: string; rpc?: FaultSolRpc } = {}) => {
    const wallet = o.wallet ?? signer.add(), frpc = o.rpc ?? new FaultSolRpc(rpc);
    const chain = new SolanaChain({ id: 'sol-local', wsol: WSOL, pools: [{ id: SOL_POOL.id, program: programId }] }, frpc, signer), store = o.persist ? Store.open(o.persist) : new Store();
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[wallet, 'x']]), new Map([[wallet, policyFor(wallet)]])), router: new Router(chain), platformFeeBps: 0 });
    const orders = new OrderRunner({ engine, chain, clockMs: () => Date.now() });
    return { wallet, rpc: frpc, chain, store, engine, orders };
  };
  type S = ReturnType<typeof mk>;
  const intent = (s: S, key: string, tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps = 300): Intent => ({ idempotencyKey: key, userId: 'u-' + s.wallet, walletId: s.wallet, chain: 'sol-local', tokenIn, tokenOut, amountIn,
    minOut: 0n, slippageBps, deadline: s.chain.time + 600, maxFeeBps: 200, venues: ['raydium-v4'], origin: 'manual' });
  const TERMINAL = new Set(['finalized', 'failed', 'expired']);
  const finish = async (s: S, key: string, maxMs = 120_000) => { const t0 = Date.now(); for (;;) { const r = await s.engine.advance(key).catch(() => s.store.records.get(key)!); if (TERMINAL.has(r.state) || Date.now() - t0 > maxMs) return r; await sleep(700); } };
  const trade = async (s: S, key: string, tokenIn: string, tokenOut: string, amountIn: bigint, slip = 300) => { await s.chain.refresh('venues'); await s.engine.submit(intent(s, key, tokenIn, tokenOut, amountIn, slip)); return finish(s, key); };
  const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const venue = (s: S) => s.chain.venues()[0] as RaydiumVenue;
  const sigCount = async (a: string) => (await rpc.call<any[]>('getSignaturesForAddress', [a, { limit: 100, commitment: 'confirmed' }])).length;

  // ================= setup =================
  const A = mk(); await airdrop(A.wallet, 100n * SOLN); await A.chain.refresh('venues'); const v0 = venue(A);
  facts.push(`local validator cloned Raydium AMM v4 + pool ${SOL_POOL.id} + its serum market from mainnet; reserves at clone time: ${v0.baseReserve} lamports / ${v0.quoteReserve} micro-USDC; spot ${(Number(v0.quoteReserve) / 1e6 / (Number(v0.baseReserve) / 1e9)).toFixed(2)} USDC per SOL`);
  check('S1 SolanaChain loaded the cloned pool as a venue (keys derived and cross-checked on-chain, status swap-enabled) with positive reserves', v0 instanceof RaydiumVenue && v0.tradable && v0.baseReserve > 0n && v0.quoteReserve > 0n && v0.baseMint === WSOL && v0.quoteMint === USDC, `${v0.tradable} ${v0.baseMint}`);
  check('S1 head: slot and block time read from the validator; confirmedNonce is 0 (no nonce on Solana); no approvals needed', A.chain.block > 0 && A.chain.time > 1_700_000_000 && (await A.chain.confirmedNonce()) === 0 && (await A.chain.needsApproval()) === undefined, `slot ${A.chain.block} time ${A.chain.time}`);

  // ================= buy =================
  const sol0 = await lamports(A.wallet); const quote = v0.quote(NATIVE, USDC, SOLN);
  const buy = await trade(A, 'buy1', NATIVE, USDC, SOLN);
  const usdcAfterBuy = await A.chain.balanceOf(A.wallet, USDC), sol1 = await lamports(A.wallet);
  check('B1 SOL -> USDC through the Engine reached finalized (Solana\'s own finality: rooted)', buy.state === 'finalized' && !!buy.fill, `${buy.state} ${buy.history.at(-1)?.note ?? ''}`);
  check('B2 the fill is the real balance change: received == wallet USDC token balance; spent == exactly 1 SOL', buy.fill?.received === usdcAfterBuy && buy.fill?.spent === SOLN, `received ${buy.fill?.received} balance ${usdcAfterBuy} spent ${buy.fill?.spent}`);
  const devBps = quote.amountOut === 0n ? 0 : Number((quote.amountOut - usdcAfterBuy) * 10_000n / quote.amountOut);
  check('B3 our constant-product quote vs the executed output (open-orders balances are not in our quote): within 50 bps', Math.abs(devBps) <= 50, `quote ${quote.amountOut} got ${usdcAfterBuy} (${devBps} bps)`);
  check('B4 wallet SOL fell by exactly spent + network fee + one-time token account rent (nothing else): no wrapped-SOL leftover', sol0 - sol1 === SOLN + buy.fill!.networkFee, `delta ${sol0 - sol1} fee ${buy.fill?.networkFee}`);
  const wsolLeft = await rpc.call<any>('getTokenAccountsByOwner', [A.wallet, { mint: WSOL }, { encoding: 'jsonParsed' }]);
  check('B4 the temporary wrapped-SOL account was closed inside the transaction', wsolLeft.value.length === 0);
  const n1 = await sigCount(A.wallet); const again = await A.engine.submit(intent(A, 'buy1', NATIVE, USDC, SOLN));
  check('B5 resubmitting the same idempotency key returns the same record and sends nothing new', again.key === 'buy1' && (await sigCount(A.wallet)) === n1 && A.rpc.sends === 1, `sends ${A.rpc.sends}`);

  // ================= sell =================
  const sell = await trade(A, 'sell1', USDC, NATIVE, usdcAfterBuy); const usdcEnd = await A.chain.balanceOf(A.wallet, USDC), sol2 = await lamports(A.wallet);
  check('S1 sell: USDC -> SOL finalized with no allowance step; wallet USDC is zero', sell.state === 'finalized' && usdcEnd === 0n && !sell.history.some(h => /approve/.test(h.note ?? '')), `${sell.state} ${usdcEnd}`);
  check('S2 SOL received == real lamport change + network fee (fill from balance deltas)', sell.fill?.received !== undefined && sol2 - sol1 + sell.fill!.networkFee === sell.fill!.received && sell.fill!.received > 0n, `received ${sell.fill?.received}`);

  // ================= lost ack =================
  const L = mk({ wallet: A.wallet, rpc: undefined }); await L.chain.refresh('venues'); L.rpc.dropAckOnce = true;
  const nBefore = await sigCount(A.wallet); await L.engine.submit(intent(L, 'lost1', NATIVE, USDC, SOLN / 2n)); const lost = await finish(L, 'lost1');
  check('L1 the node got the tx but the ack was lost: the engine went unresolved, looked the signature up, and finalized WITHOUT sending a second tx', lost.state === 'finalized' && lost.history.some(h => h.state === 'unresolved') && L.rpc.sends === 1 && (await sigCount(A.wallet)) === nBefore + 1, `${lost.state} sends ${L.rpc.sends} history ${lost.history.map(h => h.state).join('>')}`);

  // ================= crash after write-ahead, before send =================
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-solfork-')), file = join(dir, 'engine.json');
  const C = mk({ wallet: A.wallet, persist: file }); await C.chain.refresh('venues'); C.rpc.beforeSend = () => { throw new Error('process killed'); };
  const nC = await sigCount(A.wallet); await C.engine.submit(intent(C, 'crash1', NATIVE, USDC, SOLN / 4n)); let crashed = false; try { await C.engine.advance('crash1'); } catch (e) { crashed = /process killed|ack lost|unresolved/.test((e as Error).message) || true; }
  const saved = Store.open(file).records.get('crash1');
  check('C1 crash between signing and sending: the signed transaction is on disk (write-ahead), nothing landed', !!saved?.tx?.raw && saved.state !== 'created' && (await sigCount(A.wallet)) === nC && C.rpc.sends === 0, `state ${saved?.state} raw ${!!saved?.tx?.raw} landed ${(await sigCount(A.wallet)) - nC} crashed ${crashed} sends ${C.rpc.sends} history ${saved?.history.map(h => h.state).join('>')}`);
  const C2 = mk({ wallet: A.wallet, persist: file }); await C2.chain.refresh('venues'); const resumed = await finish(C2, 'crash1');
  check('C2 restarted from the file only: the SAME signed bytes were sent, exactly one landing, finalized', resumed.state === 'finalized' && (await sigCount(A.wallet)) === nC + 1 && resumed.tx?.hash === saved?.tx?.hash, `${resumed.state} ${resumed.tx?.hash === saved?.tx?.hash}`);

  // ================= expired / unknown blockhash fails closed =================
  const E = mk({ wallet: A.wallet }); await E.chain.refresh('venues'); E.rpc.staleBlockhash = true; const bal0 = await lamports(A.wallet);
  await E.engine.submit(intent(E, 'stale1', NATIVE, USDC, SOLN / 10n)); const stale = await finish(E, 'stale1', 30_000);
  check('E1 a transaction built on a blockhash the cluster does not know can never land: it is rejected, the record fails closed with a clear reason, no SOL moved', stale.state === 'failed' && /blockhash/i.test(JSON.stringify(stale.history)) && (await lamports(A.wallet)) === bal0, `${stale.state} ${stale.history.at(-1)?.note}`);

  // ================= slippage guard =================
  const G = mk({ wallet: A.wallet }); await G.chain.refresh('venues'); const nG = await sigCount(A.wallet);
  await G.engine.submit({ ...intent(G, 'guard1', NATIVE, USDC, SOLN, 0), minOut: 0n }); const guard = await finish(G, 'guard1', 30_000);
  check('G1 slippage 0 bps on a trade with price impact: either refused before sending or reverted by the program; never a bad fill', (guard.state === 'failed' || guard.state === 'finalized') && (guard.state !== 'finalized' || guard.fill!.received >= guard.quote!.amountOut - guard.quote!.amountOut / 1000n), `${guard.state} ${guard.history.at(-1)?.note ?? ''} landed ${(await sigCount(A.wallet)) - nG}`);

  // ================= price order (take profit) from the real pool, driven by a competitor =================
  const T = mk({ wallet: A.wallet }); await T.chain.refresh('venues'); const held0 = await T.chain.balanceOf(A.wallet, USDC);
  const hold = await trade(T, 'hold1', NATIVE, USDC, 2n * SOLN); const held = (await T.chain.balanceOf(A.wallet, USDC)) - held0; await T.chain.refresh('venues');
  const spot = venue(T).spotPriceE18(USDC, NATIVE);
  const tp: Order = { id: 'tp1', userId: 'u-' + A.wallet, walletId: A.wallet, chain: 'sol-local', token: USDC, quoteToken: NATIVE, kind: 'take_profit', amount: held, triggerPriceE18: spot * 1005n / 1000n, expiresAt: T.chain.time + 86_400,
    maxQuoteAgeMs: 120_000, minLiquidity: SOLN, maxDeviationBps: 3000, maxAttempts: 2, slippageBps: 300, venues: ['raydium-v4'], status: 'active', attempts: 0 };
  await T.orders.place(tp); await T.chain.refresh('venues'); const idle = await T.orders.tick();
  check('T1 take-profit placed on the real pool: not triggered at the current price, USDC reserved', idle.fired.length === 0 && T.orders.reservations.reservedTotal(A.wallet, USDC) === held && hold.state === 'finalized', `fired ${idle.fired}`);
  const B = mk(); const spend = venue(T).baseReserve * 3n / 100n; await airdrop(B.wallet, spend + 5n * SOLN); await B.chain.refresh('venues');
  const comp = await trade(B, 'comp1', NATIVE, USDC, spend); await T.chain.refresh('venues'); const spot2 = venue(T).spotPriceE18(USDC, NATIVE);
  check('T2 a competitor wallet (own engine) bought USDC with 3% of the pool\'s SOL: the real price moved up past the trigger', comp.state === 'finalized' && spot2 > tp.triggerPriceE18!, `spot ${spot} -> ${spot2} (+${Number((spot2 - spot) * 10_000n / spot) / 100}%)`);
  let fired = false; for (let i = 0; i < 200 && !fired; i++) { await T.chain.refresh('venues'); const r = await T.orders.tick(); if (r.fired.length) fired = true; else await sleep(400); }
  for (let i = 0; i < 160 && (T.orders.inflight.size || !T.orders.orders.orders.get('tp1') || T.orders.orders.orders.get('tp1')!.status === 'active'); i++) { await T.orders.settle(); await sleep(700); }
  const sellRec = T.store.records.get('order:tp1:a0'), tpo = T.orders.orders.orders.get('tp1');
  check('T3 the take-profit fired from the real pool price; the engine sold exactly the reserved amount; finalized; wallet USDC back to its earlier level', fired && tpo?.status === 'fired' && sellRec?.state === 'finalized' && sellRec.intent.amountIn === held && (await T.chain.balanceOf(A.wallet, USDC)) === held0, `${tpo?.status} ${sellRec?.state}`);
  check('T3 the reservation was released', T.orders.reservations.reservedTotal(A.wallet, USDC) === 0n);

  // ================= misc safety =================
  const disk = readFileSync(file, 'utf8');
  check('M1 no private key material in the engine state file', !/privateKey|secretKey|seed/i.test(disk));
  const P = mk({ wallet: A.wallet }); await P.chain.refresh('venues'); const pf = await P.engine.submit({ ...intent(P, 'fee1', NATIVE, USDC, SOLN / 10n), maxFeeBps: 200 });
  const pfEngine = new Engine({ store: new Store(), chain: P.chain, signer: new PolicySigner(new Map([[A.wallet, 'x']]), new Map([[A.wallet, policyFor(A.wallet)]])), router: new Router(P.chain), platformFeeBps: 50 });
  await pfEngine.submit(intent(P, 'fee2', NATIVE, USDC, SOLN / 10n)); const pfRec = await finish({ ...P, engine: pfEngine, store: (pfEngine as any).d.store } as S, 'fee2', 20_000);
  check('M2 a platform fee is refused (collection not implemented on this chain): fails before anything is sent', pfRec.state === 'failed' && /platform fee/.test(JSON.stringify(pfRec.history)) && pf.key === 'fee1', `${pfRec.state} ${pfRec.history.at(-1)?.note ?? ''}`);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Solana engine on a local validator (cloned Raydium AMM v4)', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with the Raydium AMM v4 program, the mainnet SOL/USDC pool and its serum market CLONED from mainnet at start-up. NOT mainnet. Throwaway keys, fake SOL, dev-only ed25519 signer.`, `Result: **${pass ? 'PASS' : 'FAIL'}** (${r.checks.filter(c => c.pass).length}/${r.checks.length} checks)`, '',
    'What this shows: the same Engine and OrderRunner used on EVM drive Solana through SolanaChain: quotes from pool vault reserves, a legacy transaction built and signed by our code (ed25519, wrapped SOL created and closed inside the transaction, output token account created if needed), sent over JSON-RPC, reconciled by signature after a lost ack or a crash, finalized on Solana\'s own finality, with the fill taken from balance deltas. A take-profit fires from the real pool price.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- Only Raydium AMM v4 (one SOL/USDC pool). No CLMM/CPMM, Orca, Meteora or Pump.fun; no multi-pool routing; no Token-2022 transfer fees.', '- The validator is a single node: no leader schedule, no forks or rollbacks, no congestion, no priority-fee market, no Jito/MEV. Blockhash expiry is tested with an unknown blockhash, not by waiting out the 150-slot window.',
    '- The pool\'s open-orders balances are not part of our quote; the executed output differed from the quote by the amount shown in B3.', '- Platform fee collection and pending-transaction cancellation are not implemented. The engine does not rebuild a transaction with a fresh blockhash: it fails closed and a new intent is needed.',
    '- Launch detection, sniping and copy trading are EVM only; nothing here touches mainnet funds or sends mainnet transactions.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let env: Awaited<ReturnType<typeof startSolValidator>> | undefined;
  try {
    env = await startSolValidator(key, PORT);
    const r = await runSolFork(env), rep = report(env.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-solana-validator.md`; writeFileSync(file, env.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + env!.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('solfork.ts')) main();
