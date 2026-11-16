/** BULK BUY (multi-wallet) ON A LOCAL SOLANA VALIDATOR. Five throwaway wallets buy USDC from the cloned mainnet SOL/USDC Raydium pool through ONE BulkRunner: each leg is an ordinary Engine
 *  intent from its own wallet. Local only: fake SOL, loopback validator. usage: npm run verify:bulk (needs ALCHEMY_API_KEY in .env and solana-test-validator). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE, BulkRunner, splitEqual } from '../../core/src/index.ts';
import type { WalletPolicy, BulkSpec } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner, SolJsonRpc } from '../../sol/src/index.ts';
import { SOL, SOL_POOL } from './config.ts';
import { startSolValidator } from './solenv.ts';
import type { Check } from './localrun.ts';

const PORT = 8914, SOLN = 10n ** 9n, sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const USDC = SOL_POOL.usdc.mint, WSOL = SOL_POOL.wsol.mint;

export async function runBulkFork(env: { rpc: SolJsonRpc }): Promise<{ checks: Check[]; facts: string[] }> {
  const checks: Check[] = [], facts: string[] = [];
  const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); };
  const rpc = env.rpc, signer = new DevSolSigner(), programId = SOL.programs[0].address;
  const airdrop = async (a: string, lamports: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(lamports)]); for (let i = 0; i < 60; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } throw new Error('airdrop did not confirm'); };
  const policy = (w: string): WalletPolicy => ({ userId: 'u1', chains: ['sol-local'], allowedVenues: ['raydium-v4'], maxPerTx: { [NATIVE]: 200n * SOLN, [USDC]: 10n ** 18n }, dailyLimit: { [NATIVE]: 1000n * SOLN, [USDC]: 10n ** 19n }, destinations: [] } as unknown as WalletPolicy);
  const wallets = Array.from({ length: 5 }, () => signer.add()); for (const w of wallets) await airdrop(w, 150n * SOLN);
  const poor = signer.add(); await airdrop(poor, SOLN / 100n);
  const mk = (persist?: string) => {
    const chain = new SolanaChain({ id: 'sol-local', wsol: WSOL, program: programId, pools: [{ id: SOL_POOL.id, program: programId }] }, rpc, signer), store = persist ? Store.open(persist) : new Store();
    const all = [...wallets, poor], engine = new Engine({ store, chain, signer: new PolicySigner(new Map(all.map(w => [w, 'x'])), new Map(all.map(w => [w, policy(w)]))), router: new Router(chain), platformFeeBps: 0 });
    return { chain, store, engine };
  };
  const spec = (legs: BulkSpec['legs'], o: Partial<BulkSpec> = {}): BulkSpec => ({ id: 'bulk1', userId: 'u1', chain: 'sol-local', token: USDC, quoteToken: NATIVE, venues: ['raydium-v4'], legs, slippageBps: 300, ...o });
  const usdcOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: USDC }, { encoding: 'jsonParsed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n));
  const lamports = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const run = async (r: BulkRunner, ms = 240_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await r.tick(); if (r.summary().done) break; await sleep(700); } return r.summary(); };

  const M = mk(); await M.chain.refresh('venues'); const v = M.chain.venues()[0] as any;
  facts.push(`validator cloned Raydium AMM v4 + SOL/USDC pool from mainnet (reserves ${v.baseReserve} lamports / ${v.quoteReserve} micro-USDC); 5 funded wallets and 1 nearly empty wallet, all throwaway keys, fake SOL`);
  const before = await Promise.all(wallets.map(lamports));
  const legs = wallets.map((w, i) => ({ walletId: w, amount: BigInt(10 + i * 5) * SOLN }));            // 10, 15, 20, 25, 30 SOL
  const file = join(mkdtempSync(join(tmpdir(), 'memedesk-bulkfork-')), 'bulk.json');
  const R = new BulkRunner({ engine: M.engine, chain: M.chain, spec: spec([...legs, { walletId: poor, amount: 5n * SOLN }], { maxTotal: 200n * SOLN }), persistPath: file });
  const sum = await run(R);
  check('B1 five wallets each bought through the engine and finalized; the sixth, which could not fund its leg, was skipped with a reason and nothing was sent for it', sum.filled === 5 && sum.skipped === 1 && sum.failed === 0 && sum.legs.at(-1)!.status === 'skipped' && !M.store.records.has(`bulk:bulk1:${poor}`) && sum.done, JSON.stringify(sum.legs.map(l => [l.status, l.reason?.slice(0, 40)])));
  const got = await Promise.all(wallets.map(usdcOf)), after = await Promise.all(wallets.map(lamports));
  check('B2 each wallet holds exactly the USDC its own engine record says it received, and the summary adds up', got.every((g, i) => g === sum.legs[i].received && g > 0n) && sum.received === got.reduce((a, b) => a + b, 0n), `balances ${got}`);
  check('B3 each wallet\'s SOL fell by its leg plus the network fee and nothing else (no wrapped-SOL leftovers)', after.every((a, i) => { const rec = M.store.records.get(`bulk:bulk1:${wallets[i]}`)!; return before[i] - a === legs[i].amount + rec.fill!.networkFee; }));
  const per = sum.legs.slice(0, 5).map(l => Number(l.received!) / Number(l.spent!));
  check('B4 legs ran one after another on the pool as the earlier legs left it: the USDC per SOL fell with every leg (price moved up)', per.every((p, i) => i === 0 || p < per[i - 1]), per.map(p => p.toFixed(8)).join(' > '));

  // same id again with a fresh runner and the same files -> nothing new is bought
  const M2 = mk(); const R2 = new BulkRunner({ engine: M2.engine, chain: M2.chain, spec: spec([...legs, { walletId: poor, amount: 5n * SOLN }], { maxTotal: 200n * SOLN }), persistPath: file });
  const sends = (await Promise.all(wallets.map(w => rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 100, commitment: 'confirmed' }])))).reduce((a, x) => a + x.length, 0);
  const s2 = await run(R2, 20_000), sends2 = (await Promise.all(wallets.map(w => rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 100, commitment: 'confirmed' }])))).reduce((a, x) => a + x.length, 0);
  check('B5 restarting from the saved bulk state and running it again buys nothing more', s2.filled === 5 && sends2 === sends && (await Promise.all(wallets.map(usdcOf))).every((g, i) => g === got[i]));

  // impact limit: the TOTAL is judged against the pool before anything is sent
  const M3 = mk(); const before3 = await Promise.all(wallets.map(usdcOf));
  const R3 = new BulkRunner({ engine: M3.engine, chain: M3.chain, spec: spec(wallets.map(w => ({ walletId: w, amount: 20n * SOLN })), { id: 'bulk-impact', maxImpactBps: 1 }) }); const s3 = await run(R3, 30_000);
  check('B6 a total that would move the pool more than the 1 bp limit is refused for every leg, with the measured impact in the reason, and nothing is sent', !!s3.refused && /bps, above the 1 bps limit/.test(s3.refused) && s3.skipped === 5 && M3.store.records.size === 0 && (await Promise.all(wallets.map(usdcOf))).every((g, i) => g === before3[i]), s3.refused ?? 'not refused');

  // refused by wallet policy: one wallet's policy forbids this size; the others still buy
  const M4 = mk(); const small = signer.add(); await airdrop(small, 50n * SOLN);
  const pol4 = new Map([...wallets, poor].map(w => [w, policy(w)] as [string, WalletPolicy])); pol4.set(small, { ...policy(small), maxPerTx: { [NATIVE]: SOLN, [USDC]: 10n ** 18n } } as WalletPolicy);
  const e4 = new Engine({ store: M4.store, chain: M4.chain, signer: new PolicySigner(new Map([...wallets, poor, small].map(w => [w, 'x'])), pol4), router: new Router(M4.chain), platformFeeBps: 0 });
  const R4 = new BulkRunner({ engine: e4, chain: M4.chain, spec: spec([{ walletId: wallets[0], amount: 2n * SOLN }, { walletId: small, amount: 5n * SOLN }, { walletId: wallets[1], amount: 2n * SOLN }], { id: 'bulk-policy' }) }); const s4 = await run(R4, 90_000);
  check('B7 a leg above its wallet\'s own per-transaction limit failed alone with the policy reason; the other two wallets bought', s4.legs[1].status === 'failed' && s4.filled === 2 && !!s4.legs[1].reason && (await usdcOf(small)) === 0n, JSON.stringify(s4.legs.map(l => [l.status, l.reason?.slice(0, 60)])));

  // ---- bulk SELL: the five wallets that bought USDC each sell half of it back through one BulkRunner (each wallet's own USDC token account, its own engine record)
  const M5 = mk(); await M5.chain.refresh('venues');
  const usdcBefore = await Promise.all(wallets.map(usdcOf)), solBefore = await Promise.all(wallets.map(lamports));
  const sellLegs = wallets.map((w, i) => ({ walletId: w, amount: usdcBefore[i] / 2n }));
  const R5 = new BulkRunner({ engine: M5.engine, chain: M5.chain, spec: spec([...sellLegs, { walletId: poor, amount: 1_000_000n }], { id: 'sell1', side: 'sell' }) }); const s5 = await run(R5);
  check('B8 five wallets each sold half their USDC through the engine and finalized; the nearly empty wallet, which holds no USDC, was skipped with a reason and nothing was sent for it', s5.filled === 5 && s5.skipped === 1 && s5.legs[5].status === 'skipped' && /balance 0 is below/.test(s5.legs[5].reason ?? ''), `filled ${s5.filled}, skipped ${s5.skipped}: ${s5.legs[5].reason}`);
  const usdcAfter = await Promise.all(wallets.map(usdcOf)), solAfter = await Promise.all(wallets.map(lamports));
  check('B9 each wallet gave up exactly its leg of USDC, and its SOL rose by the proceeds its own engine record reports (minus the network fee)', usdcAfter.every((u, i) => usdcBefore[i] - u === sellLegs[i].amount) && solAfter.every((a, i) => { const rec = M5.store.records.get(`bulk:sell1:${wallets[i]}`)!; return a - solBefore[i] === rec.fill!.received - rec.fill!.networkFee; }), 'sold ' + sellLegs.map(l => l.amount).join(', '));
  const per2 = s5.legs.slice(0, 5).map(l => Number(l.received!) / Number(l.spent!));
  check('B10 sells ran one after another on the pool as the earlier legs left it: SOL per USDC fell with every leg (price moved down)', per2.every((p, i) => i === 0 || p < per2[i - 1]), per2.map(p => (p * 1e3).toFixed(6)).join(' > '));
  const nonce5 = (await Promise.all(wallets.map(w => rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 100, commitment: 'confirmed' }])))).reduce((a, x) => a + x.length, 0);
  const R6 = new BulkRunner({ engine: M5.engine, chain: M5.chain, spec: spec(sellLegs, { id: 'sell1', side: 'sell' }) }); await run(R6, 20_000);
  const nonce6 = (await Promise.all(wallets.map(w => rpc.call<any[]>('getSignaturesForAddress', [w, { limit: 100, commitment: 'confirmed' }])))).reduce((a, x) => a + x.length, 0);
  check('B11 running the same sell id again sends nothing more and sells nothing more', nonce6 === nonce5 && (await Promise.all(wallets.map(usdcOf))).every((u, i) => u === usdcAfter[i]));
  return { checks, facts };
}

function report(url: string, r: { checks: Check[]; facts: string[] }) {
  const pass = r.checks.every(c => c.pass);
  return { pass, text: ['# Bulk buy and bulk sell (multi-wallet) on a local Solana validator', '', `Run: ${new Date().toISOString()}`, `Node: local solana-test-validator (${url}) with Raydium AMM v4 and the mainnet SOL/USDC pool cloned. Throwaway keys, fake SOL.`, '',
    'What this shows: one BulkRunner request buys the same token from several wallets. Each leg is an ordinary Engine intent from its own wallet with its own policy and idempotency key. Default mode is sequential: each leg is quoted on the pool as the earlier legs left it.', '',
    '## Observed', ...r.facts.map(f => `- ${f}`), '', '## Checks', '| Check | Result | Detail |', '|---|---|---|', ...r.checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`), '',
    '## Not covered', '- NOT atomic: legs are independent transactions. Any can fail while others land; the summary lists each leg.', '- Parallel mode (all legs at once) was shown to fail later legs by design in the simulated-chain unit tests, not on this validator.', '- One pool, one token, one chain, our own throwaway wallets. No wallet creation or management: the caller supplies existing wallet ids.', '- Sequential legs are slower: each waits for the previous one to settle. Not suitable where every leg must land in the same block.'].join('\n') + '\n' };
}

async function main() {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) { console.error('ALCHEMY_API_KEY is not set. Put it in .env (see .env.example) and run again.'); process.exit(2); }
  let env: Awaited<ReturnType<typeof startSolValidator>> | undefined;
  try {
    env = await startSolValidator(key, PORT);
    const r = await runBulkFork(env), rep = report(env.url, r);
    mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-bulk-buy-validator.md`; writeFileSync(file, env.redact(rep.text));
    for (const c of r.checks) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.name}${c.pass ? '' : '  -> ' + env!.redact(c.detail)}`);
    console.log(`\nreport: ${file}`); env.stop(); process.exit(rep.pass ? 0 : 1);
  } catch (e) { console.error(env ? env.redact((e as Error).stack ?? (e as Error).message) : (e as Error).message.split(key).join('***')); env?.stop(); process.exit(1); }
}
void splitEqual;
if (process.argv[1]?.endsWith('bulkfork.ts')) main();
