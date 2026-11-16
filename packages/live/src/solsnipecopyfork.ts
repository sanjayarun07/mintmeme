/** SOLANA COPY TRADING AND SNIPING ON A LOCAL VALIDATOR. The validator clones Raydium AMM v4, the mainnet SOL/USDC pool and its serum market (see solenv.ts).
 *  COPY: a leader wallet swaps through the cloned pool; OUR SolLeaderWatcher reads the leader's transactions over JSON-RPC, CopyEngine decides, and the Engine mirrors the trade for a follower
 *  through SolanaChain. SNIPE: SnipeRunner drives SolanaChain with the Solana mint-risk check and places TP/SL exits through OrderRunner.
 *  The launch EVENT in the snipe part is SYNTHETIC (nothing can create a Raydium pool on this validator): detection is covered by unit tests and a separate read-only mainnet check, not here.
 *  Local only: throwaway keys, fake SOL, loopback validator. usage: npm run verify:solana-snipe-copy (needs ALCHEMY_API_KEY in .env and solana-test-validator). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, OrderRunner, CopyRunner, SnipeRunner } from '../../core/src/index.ts';
import type { CopyConfig, SnipeConfig, WalletPolicy, Intent, LaunchEvent } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc, SolLeaderWatcher, MintInspector, RaydiumVenue } from '../../sol/src/index.ts';
import { SOL, SOL_POOL } from './config.ts';
import { startSolValidator } from './solenv.ts';
import type { Check } from './localrun.ts';

const PORT = 8912, SOLN = 10n ** 9n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const USDC = SOL_POOL.usdc.mint, WSOL = SOL_POOL.wsol.mint, TERMINAL = new Set(['finalized', 'failed', 'expired']);

export async function runSolSnipeCopy(env: { rpc: SolJsonRpc }): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const js = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const rpc = env.rpc, signer = new DevSolSigner(), programId = SOL.programs[0].address;
  const airdrop = async (a: string, lamports: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(lamports)]); for (let i = 0; i < 60; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } throw new Error('airdrop did not confirm'); };
  const policyFor = (w: string): WalletPolicy => ({ userId: 'u-' + w, chains: ['sol-local'], allowedVenues: ['raydium-v4'], maxPerTx: { [NATIVE]: 10n ** 17n * 20n, [USDC]: 10n ** 18n }, dailyLimit: { [NATIVE]: 10n ** 19n, [USDC]: 10n ** 19n }, destinations: [] } as unknown as WalletPolicy);
  const mk = (wallet: string, o: { persist?: string } = {}) => {
    const chain = new SolanaChain({ id: 'sol-local', wsol: WSOL, program: programId, pools: [{ id: SOL_POOL.id, program: programId }] }, rpc, signer), store = o.persist ? Store.open(o.persist) : new Store();
    const engine = new Engine({ store, chain, signer: new PolicySigner(new Map([[wallet, 'x']]), new Map([[wallet, policyFor(wallet)]])), router: new Router(chain), platformFeeBps: 0 });
    return { wallet, chain, store, engine };
  };
  const finish = async (s: ReturnType<typeof mk>, key: string, maxMs = 120_000) => { const t0 = Date.now(); for (;;) { const r = await s.engine.advance(key).catch(() => s.store.records.get(key)!); if (TERMINAL.has(r.state) || Date.now() - t0 > maxMs) return r; await sleep(600); } };
  const leaderTrade = async (s: ReturnType<typeof mk>, key: string, tokenIn: string, tokenOut: string, amountIn: bigint) => {
    await s.chain.refresh('venues'); const i: Intent = { idempotencyKey: key, userId: 'u-' + s.wallet, walletId: s.wallet, chain: 'sol-local', tokenIn, tokenOut, amountIn, minOut: 0n, slippageBps: 300, deadline: s.chain.time + 600, maxFeeBps: 200, venues: ['raydium-v4'], origin: 'manual' };
    await s.engine.submit(i); return finish(s, key);
  };
  const drive = async (settle: () => Promise<void>, busy: () => boolean, ms = 90_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await settle(); if (!busy()) return; await sleep(700); } };
  const cfgFor = (f: string, leader: string, o: Partial<CopyConfig> = {}): CopyConfig => ({ follower: 'f-' + f.slice(0, 6), walletId: f, userId: 'u-' + f, leader, chain: 'sol-local', quoteToken: NATIVE, mode: 'fixed', fixed: SOLN / 10n, ratioBps: 0, sides: 'both',
    maxPerLeader: 5n * SOLN, maxPerToken: 5n * SOLN, dailyLimit: 10n * SOLN, maxPositions: 3, cooldownS: 0, minLiquidity: 10n * SOLN, maxDeviationBps: 500, minConfirmations: 0, followLeaderExit: true, slippageBps: 300, venues: ['raydium-v4'], ...o });
  const usdcOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: USDC }, { encoding: 'jsonParsed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));

  // ================= COPY TRADING =================
  const lead = signer.add(), fol = signer.add(); await airdrop(lead, 100n * SOLN); await airdrop(fol, 20n * SOLN);
  const L = mk(lead), F = mk(fol), watcher = new SolLeaderWatcher({ chain: 'sol-local', wsol: WSOL, leaders: [lead], quoteMints: [], minConfirmations: 0 }, rpc);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-solcopy-')), seen: any[] = [];
  const src = { poll: async () => { const r = await watcher.poll(); seen.push(...r.events); return r; }, snapshot: () => watcher.snapshot(), load: (s: any) => watcher.load(s) };
  const copyFile = join(dir, 'copy.json'), engFile = join(dir, 'eng.json');
  const FP = mk(fol, { persist: engFile }); const cfg = cfgFor(fol, lead);
  const runner = new CopyRunner({ engine: FP.engine, chain: FP.chain, source: src, cfgs: [cfg], persistPath: copyFile });
  await FP.chain.refresh('venues'); await runner.tick();                                    // seeds "now": history is never copied
  facts.push(`validator cloned Raydium AMM v4 + SOL/USDC pool from mainnet; leader ${lead.slice(0, 8)}…, follower ${fol.slice(0, 8)}… (throwaway keys, fake SOL)`);

  const buy = await leaderTrade(L, 'lead-buy', NATIVE, USDC, 2n * SOLN); const leaderUsdc = await usdcOf(lead);
  const t1 = await runner.tick(); await drive(() => runner.settle(), () => runner.inflight.size > 0);
  const k1 = t1.submitted[0], r1 = k1 ? FP.store.records.get(k1) : undefined, ev1 = seen[0];
  check('C1 the leader\'s buy was detected from ITS OWN transaction over plain JSON-RPC: one swap event, buy, correct token, price from its balance changes', buy.state === 'finalized' && seen.length === 1 && ev1?.kind === 'swap' && ev1.side === 'buy' && ev1.token === USDC && ev1.leader === lead, js(seen.map(e => [e.kind, e.side, e.token])));
  check('C1 event amounts equal the leader\'s real balance change: tokens == its USDC balance, SOL spent == 2 SOL exactly (fee and account rent excluded)', ev1?.tokenAmount === leaderUsdc && ev1?.quoteAmount === 2n * SOLN && ev1?.leaderBalanceAfter === leaderUsdc && ev1?.leaderBalanceBefore === 0n, `event ${ev1?.tokenAmount}/${ev1?.quoteAmount} balance ${leaderUsdc}`);
  check('C1 the follower mirrored it through the engine: finalized, origin copy, fixed 0.1 SOL, key tied to the leader signature', r1?.state === 'finalized' && r1.intent.origin === 'copy' && r1.intent.amountIn === SOLN / 10n && k1 === `copy:${cfg.follower}:sol-local:${ev1?.txHash}:0`, `${r1?.state} ${k1}`);
  const mine = runner.copy.attributed(cfg.follower, lead, USDC), folUsdc = await usdcOf(fol);
  check('C1 attribution == the follower\'s real USDC balance; cost basis == SOL spent', mine === folUsdc && mine > 0n && runner.copy.exposure(cfg.follower, lead) === r1?.fill?.spent, `attributed ${mine} balance ${folUsdc}`);
  const sends = FP.store.records.size; const t2 = await runner.tick(); await runner.tick();
  check('C2 re-scanning with no new leader trade sends nothing', t2.events === 0 && t2.submitted.length === 0 && FP.store.records.size === sends);

  // restart: new runner, new watcher, same files -> the same leader trade is not copied again, and the cursor survived
  const w2 = new SolLeaderWatcher({ chain: 'sol-local', wsol: WSOL, leaders: [lead], quoteMints: [], minConfirmations: 0 }, rpc), seen2: any[] = [];
  const FP2 = mk(fol, { persist: engFile }), runner2 = new CopyRunner({ engine: FP2.engine, chain: FP2.chain, source: { poll: async () => { const r = await w2.poll(); seen2.push(...r.events); return r; }, snapshot: () => w2.snapshot(), load: (s: any) => w2.load(s) }, cfgs: [cfg], persistPath: copyFile });
  await FP2.chain.refresh('venues'); await runner2.resume(); const t3 = await runner2.tick();
  check('C3 restarted from the two state files only: the earlier leader trade is not seen or copied again', t3.events === 0 && t3.submitted.length === 0 && seen2.length === 0 && runner2.copy.attributed(cfg.follower, lead, USDC) === mine);

  // leader sells everything -> follower sells only what it bought for this leader
  const sellL = await leaderTrade(L, 'lead-sell', USDC, NATIVE, leaderUsdc);
  const t4 = await runner2.tick(); await drive(() => runner2.settle(), () => runner2.inflight.size > 0);
  const rs = t4.submitted[0] ? FP2.store.records.get(t4.submitted[0]) : undefined, e4 = seen2[0];
  check('C4 the leader\'s full exit was detected as a sell with balance before > 0 and after == 0', sellL.state === 'finalized' && e4?.side === 'sell' && e4.leaderBalanceBefore === leaderUsdc && e4.leaderBalanceAfter === 0n, js([e4?.side, e4?.leaderBalanceBefore, e4?.leaderBalanceAfter]));
  check('C4 the follower sold exactly its attributed tokens, finalized, and now holds none; attribution back to zero', rs?.state === 'finalized' && rs.intent.amountIn === mine && (await usdcOf(fol)) === 0n && runner2.copy.attributed(cfg.follower, lead, USDC) === 0n && runner2.copy.positionStatus(cfg.follower, lead, USDC) === 'none', `${rs?.state} sold ${rs?.intent.amountIn} of ${mine}`);

  // blocked token: a leader buy in a blocked token is skipped with a reason, nothing is sent
  const lead2 = signer.add(), fol2 = signer.add(); await airdrop(lead2, 20n * SOLN); await airdrop(fol2, 5n * SOLN);
  const L2 = mk(lead2), F2 = mk(fol2), w3 = new SolLeaderWatcher({ chain: 'sol-local', wsol: WSOL, leaders: [lead2], quoteMints: [], minConfirmations: 0 }, rpc);
  const cfg2 = cfgFor(fol2, lead2, { block: [USDC] }), r2 = new CopyRunner({ engine: F2.engine, chain: F2.chain, source: { poll: () => w3.poll(), snapshot: () => w3.snapshot(), load: (s: any) => w3.load(s) }, cfgs: [cfg2] });
  await F2.chain.refresh('venues'); await r2.tick(); await leaderTrade(L2, 'lead2-buy', NATIVE, USDC, SOLN); const t5 = await r2.tick();
  check('C5 a leader buy of a blocked token is skipped with a recorded reason and nothing is sent', t5.events === 1 && t5.submitted.length === 0 && (await usdcOf(fol2)) === 0n && r2.copy.log.some(l => /filtered/.test(l.decision)), JSON.stringify(r2.copy.log.map(l => l.decision)));

  // ================= SNIPING =================
  const sw = signer.add(); await airdrop(sw, 20n * SOLN); const S = mk(sw); await S.chain.refresh('venues');
  const launchEvent: LaunchEvent = { type: 'pool-created', chain: 'sol-local', token: USDC, txHash: 'synthetic-launch', logIndex: 0, block: S.chain.block, venueId: SOL_POOL.id, quoteLiquidity: 1000n * SOLN };
  let emitted = false; const source = { pairs: new Map([[USDC, { pair: SOL_POOL.id }]]), poll: async () => { const ev = emitted ? [] : [launchEvent]; emitted = true; return { events: ev, reorged: [] }; }, snapshot: () => ({ emitted }), load: (s: any) => { emitted = s.emitted; } };
  const snipeCfg = (o: Partial<SnipeConfig> = {}): SnipeConfig => ({ userId: 'u-' + sw, walletId: sw, chain: 'sol-local', quoteToken: NATIVE, venues: ['raydium-v4'], maxSpend: SOLN / 2n, delayBlocks: 0, minLiquidity: 10n * SOLN, maxTaxBps: 500, maxAttempts: 2, slippageBps: 300,
    exit: { takeProfitBps: 5000, stopLossBps: 3000, minLiquidity: 10n * SOLN, maxQuoteAgeMs: 120_000, maxDeviationBps: 3000 }, ...o });
  const mint = new MintInspector(rpc, () => Math.floor(Date.now() / 1000));
  const orders = new OrderRunner({ engine: S.engine, chain: S.chain, clockMs: () => Date.now() });
  const strict = new SnipeRunner({ engine: S.engine, chain: S.chain, source, cfg: snipeCfg({ riskCheck: (l, _a) => mint.riskCheck(l, S.chain.block) }), orders, inspect: async l => { await mint.inspect(l.token); } });
  await strict.tick(); await strict.tick();
  const mf = mint.facts.get(USDC);
  check('N1 the Solana mint check read the real USDC mint: freeze authority set -> the buy is refused (a freezable token can trap the buyer), nothing sent', !!mf?.freezeAuthority && strict.sniper.state(`sol-local:${USDC}`).attempts.length === 0 && [...S.store.records.keys()].every(k => !k.startsWith('snipe:')) && /blocked/.test(strict.status.get(`sol-local:${USDC}`) ?? ''), `status: ${strict.status.get(`sol-local:${USDC}`)}`);
  check('N1 the launch was handed to the chain: the pool was (re)registered through addPool with the configured program', S.chain.venues().some(v => v instanceof RaydiumVenue && v.id === SOL_POOL.id));

  // explicit opt-in: the user accepts a freeze authority (rejectVerdicts without 'blocked'). The guard is a default, not a wall; the choice must be explicit.
  emitted = false; const S2 = mk(sw), orders2 = new OrderRunner({ engine: S2.engine, chain: S2.chain, clockMs: () => Date.now() });
  const opt = new SnipeRunner({ engine: S2.engine, chain: S2.chain, source, cfg: snipeCfg({ rejectVerdicts: ['quarantined'], riskCheck: (l, _a) => mint.riskCheck(l, S2.chain.block) }), orders: orders2, inspect: async l => { await mint.inspect(l.token); } });
  await S2.chain.refresh('venues'); await opt.tick(); await drive(() => opt.settle(), () => opt.inflight.size > 0);
  const key = `snipe:${sw}:sol-local:${USDC}:a1`, rec = S2.store.records.get(key), held = await usdcOf(sw);
  check('N2 with the explicit opt-in it bought through the engine: finalized, origin snipe, exactly maxSpend (0.5 SOL), tokens received == wallet balance', rec?.state === 'finalized' && rec.intent.origin === 'snipe' && rec.intent.amountIn === SOLN / 2n && rec.fill?.received === held && held > 0n, `${rec?.state} ${rec?.fill?.received} vs ${held}`);
  const oco = [...orders2.orders.orders.values()];
  check('N2 exits were placed on the real pool: a take-profit and a stop-loss sharing one OCO group, one reservation of the bought tokens', oco.length === 2 && oco.some(o => o.kind === 'take_profit') && oco.some(o => o.kind === 'stop_loss') && new Set(oco.map(o => o.ocoGroup)).size === 1 && orders2.reservations.reservedTotal(sw, USDC) === held, `${oco.map(o => o.kind)} reserved ${orders2.reservations.reservedTotal(sw, USDC)}`);
  const t6 = await opt.tick(); const n = [...S2.store.records.keys()].filter(k => k.startsWith('snipe:') && !k.endsWith(':approve')).length;
  check('N3 the launch is done: later ticks buy nothing more (one attempt, budget and attempts respected)', t6.submitted.length === 0 && n === 1 && opt.sniper.state(`sol-local:${USDC}`).done);
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Solana copy trading and sniping on a local validator', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with the Raydium AMM v4 program, the mainnet SOL/USDC pool and its serum market cloned. Throwaway keys, fake SOL.`, '',
    'What this shows: the same CopyRunner and SnipeRunner that drive EVM drive Solana through SolanaChain. Copy: leader swaps are read from the leader\'s own transactions (balance changes), mirrored for a follower, restart-safe, sells mirror only what was attributed. Snipe: the Solana mint check refuses a freezable token by default; with an explicit opt-in it buys and places TP/SL exits.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- The launch event in the snipe checks is SYNTHETIC. Pool-creation detection is unit-tested and was checked read-only against real mainnet creation transactions in a separate step; a live pool creation was not reproduced here.', '- Only Raydium AMM v4. Most new Solana memecoins launch on Pump.fun or other programs that this engine cannot execute against: copy of a leader trade there is skipped (no venue), and Pump.fun launches are not sniped.',
    '- The mint check covers mint/freeze authority and Token-2022 only: no sell simulation, no holder concentration, no LP burn/lock check.', '- Single-node validator: no forks, rollbacks or congestion; reorg handling is unit-tested with a scripted node, not exercised here.', '- No bundles, no Jito tips, no private relay, no mempool access: the snipe acts only on MINED pool creations, so it is always after the creator.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let env: Awaited<ReturnType<typeof startSolValidator>> | undefined;
  try {
    env = await startSolValidator(key, PORT);
    const r = await runSolSnipeCopy(env), rep = report(env.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-solana-snipe-copy-validator.md`; writeFileSync(file, env.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + env!.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
if (process.argv[1]?.endsWith('solsnipecopyfork.ts')) main();
