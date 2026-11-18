/** ONE small, real JupiterZ (RFQ) trade on Solana MAINNET, run by YOU, through the same SolanaChain code the engine uses (tryRfq: quote, gate, simulate, sign slot 1,
 *  Jupiter /execute, then lookup and receipt by the user's signature). It uses a THROWAWAY wallet kept in .state/ (git-ignored), not your Privy wallet, so no Privy policy
 *  change is needed. Steps (each money-moving step asks you to type a confirmation first, and shows exactly what will be sent):
 *    npm run verify:jupiterz-live                      create or show the throwaway wallet and its balance (fund it with about 0.03 SOL)
 *    npm run verify:jupiterz-live -- --buy [0.02]      JupiterZ-only buy: SOL -> USDC for that many SOL (default 0.02)
 *    npm run verify:jupiterz-live -- --sell            JupiterZ-only sell: all USDC in the wallet -> SOL (tests the SOL-out path)
 *    npm run verify:jupiterz-live -- --refund <addr>   close the empty USDC account and send ALL remaining SOL to <addr> (a plain transfer)
 *  USDC and not a stock: JupiterZ makers quote SOL/USDC from 0.01 SOL, but tokenized stocks only from about $1,000 (checked 2026-11-18). The stock-specific checks
 *  (issuer pause, share price) are covered by unit tests and the RFQ Desk, not by this run. A redacted report goes to docs/live-verification/. Keys are never printed. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { SolJsonRpc, DevSolSigner, SolanaChain, JupiterVenue, ataAddress, closeAccount, systemTransfer, compileLegacy, wireTx, b58decode, base58, decodeRfqRaw, splitWire, gateRfq, PROGRAMS } from '../../sol/src/index.ts';
import { fetchBuild, parseMessage, resolveMessage } from '../../sol/src/jupiterswap.ts';
import { JUPITERZ } from '../../sol/src/jupiterz.ts';
import { NATIVE } from '../../core/src/index.ts';

const WSOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', KEYFILE = '.state/rfq-test-key.json';
const MAX_SOL = 0.1;   // a hard ceiling for this test, whatever is asked
const args = process.argv.slice(2), API_KEY = process.env.JUPITER_API_KEY || undefined;
const say = (s = '') => console.log(s);
const redact = (s: string) => s.replace(/api-key=[^&\s]+/g, 'api-key=***').replace(/v2\/[A-Za-z0-9_-]{16,}/g, 'v2/***');

/* the node: the first of SOL_RPC_URL, Helius, Alchemy, public RPC that answers */
async function node(): Promise<{ rpc: SolJsonRpc; kind: string }> {
  const c: [string, string | undefined][] = [['SOL_RPC_URL', process.env.SOL_RPC_URL || undefined], ['Helius', process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : undefined],
    ['Alchemy', process.env.ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : undefined], ['public mainnet RPC', 'https://api.mainnet-beta.solana.com']];
  for (const [kind, url] of c) { if (!url) continue; const rpc = new SolJsonRpc(url); try { await rpc.call('getSlot'); return { rpc, kind }; } catch (e) { say(`(node ${kind} skipped: ${redact((e as Error).message)})`); } }
  throw new Error('no Solana node answered');
}
function wallet(): { signer: DevSolSigner; address: string; created: boolean } {
  const signer = new DevSolSigner();
  if (existsSync(KEYFILE)) { const k = JSON.parse(readFileSync(KEYFILE, 'utf8')); return { signer, address: signer.add(Buffer.from(k.seed, 'hex')), created: false }; }
  mkdirSync('.state', { recursive: true }); const seed = randomBytes(32), address = signer.add(seed);
  writeFileSync(KEYFILE, JSON.stringify({ seed: seed.toString('hex'), address, note: 'Throwaway wallet for npm run verify:jupiterz-live. Holds only test funds.' }), { mode: 0o600 });
  return { signer, address, created: true };
}
async function confirm(what: string, word: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n${what}\nType ${word} to go ahead, anything else to stop: `)).trim(); rl.close(); return a === word;
}
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
async function balances(rpc: SolJsonRpc, w: string) {
  const lam = BigInt((await rpc.call<any>('getBalance', [w, { commitment: 'confirmed' }])).value);
  const ata = ataAddress(w, USDC), a: any = await rpc.call('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
  const usdc = a?.value ? Buffer.from(a.value.data[0], 'base64').readBigUInt64LE(64) : 0n;
  return { lam, usdc, ata, ataLamports: BigInt(a?.value?.lamports ?? 0), ataExists: !!a?.value };
}
function report(name: string, lines: string[]) {
  mkdirSync('docs/live-verification', { recursive: true });
  const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-jupiterz-${name}.md`; writeFileSync(file, lines.join('\n') + '\n'); say(`\nReport: ${file}`);
}

async function rfqTrade(side: 'buy' | 'sell') {
  const { rpc, kind } = await node(), { signer, address: w } = wallet(), b = await balances(rpc, w);
  const amountIn = side === 'buy' ? BigInt(Math.round(Math.min(Number(args[1] ?? 0.02) || 0.02, MAX_SOL) * 1e9)) : b.usdc;
  if (side === 'buy' && b.lam < amountIn + 3_000_000n) { say(`The throwaway wallet ${w} holds ${sol(b.lam)} SOL. Send it at least ${sol(amountIn + 3_000_000n)} SOL first (the trade plus about 0.003 SOL for the USDC account rent).`); return; }
  if (side === 'sell' && amountIn === 0n) { say('The throwaway wallet holds no USDC. Run --buy first.'); return; }
  const [tin, tout, inM, outM] = side === 'buy' ? [NATIVE, USDC, WSOL, USDC] : [USDC, NATIVE, USDC, WSOL];
  const fz = { apiKey: API_KEY, timeoutMs: 15_000 };
  const ref = await fetchBuild({ ...fz, inputMint: inM, outputMint: outM, amount: amountIn, taker: w, slippageBps: 50 });
  const minOut = ref.outAmount * 99n / 100n;   // the engine minimum for this test: 1% below Jupiter's /build quote
  // the engine's own chain object, with RFQ on for any size and ANY margin (this run tests the path, not the pricing rule), and RFQ only: no /build send
  const chain = new SolanaChain({ id: 'sol-main', wsol: WSOL, pools: [], jupiter: { pairs: [], ...fz }, jupiterz: { minLamports: 0n, marginBps: -10_000, ...fz } }, rpc as any, signer);
  await chain.refresh('head');
  const vid = `jup:${inM.slice(0, 6)}>${outM.slice(0, 6)}`; chain.state.venues.set(vid, new JupiterVenue(vid, inM, outM, WSOL, amountIn, ref.outAmount, 0));
  const tx: any = { hash: '', wallet: w, nonce: 0, venue: vid, tokenIn: tin, tokenOut: tout, amountIn, minOut, deadline: chain.time + 600, platformFeeBps: 0, kind: 'swap' };
  say(`Node: ${kind}. Wallet ${w}: ${sol(b.lam)} SOL, ${Number(b.usdc) / 1e6} USDC.`);
  say(`Asking JupiterZ for ${side === 'buy' ? `${sol(amountIn)} SOL -> USDC` : `${Number(amountIn) / 1e6} USDC -> SOL`}; /build quotes ${side === 'buy' ? Number(ref.outAmount) / 1e6 + ' USDC' : sol(ref.outAmount) + ' SOL'}, minimum ${side === 'buy' ? Number(minOut) / 1e6 + ' USDC' : sol(minOut) + ' SOL'}.`);
  const p = await chain.prepare(tx); tx.hash = p.hash; tx.raw = p.raw;
  const z = decodeRfqRaw(p.raw);
  if (!z) { say(`\nJupiterZ was NOT used, so nothing will be sent. Reason: ${chain.rfqNote}`); return; }
  // show exactly what is about to go to /execute: decoded from the signed bytes themselves, and gated once more here
  const wire = Uint8Array.from(Buffer.from(z.wire, 'base64')), pm = parseMessage(splitWire(wire).message), ixs = resolveMessage(pm, []);
  const fill = ixs.find(i => i.programId === JUPITERZ.orderEngine)!, d = Buffer.from(fill.data), outAmt = d.readBigUInt64LE(16);
  const unsigned = new Uint8Array(wire); unsigned.fill(0, 1, 1 + 64 * 2);
  gateRfq(unsigned, { wallet: w, maker: pm.staticKeys[0], wsol: WSOL, inMint: inM, outMint: outM, amountIn, minOut, tokenProgram: () => PROGRAMS.token, nowSec: Math.floor(Date.now() / 1000) });
  const left = z.expireAt - Math.floor(Date.now() / 1000);
  say(`\n${chain.rfqNote}`);
  say(`Transaction: maker ${pm.staticKeys[0]} (pays the fee, signs during /execute), your wallet signed slot 1 (${p.hash}).`);
  say(`Instructions: ${ixs.map(i => ({ [JUPITERZ.orderEngine]: 'Order Engine fill', [PROGRAMS.ata]: 'create USDC account', ComputeBudget111111111111111111111111111111: 'compute budget' } as any)[i.programId] ?? i.programId).join(', ')}.`);
  if (!(await confirm(`SEND on MAINNET: ${side === 'buy' ? `${sol(amountIn)} SOL for ${Number(outAmt) / 1e6} USDC` : `${Number(amountIn) / 1e6} USDC for ${sol(outAmt)} SOL`}, through Jupiter /execute. The quote expires in ${left} s.`, 'SEND'))) { say('Stopped. Nothing was sent.'); return; }
  const t0 = Date.now(); let submitErr = '';
  for (let i = 0; i < 3; i++) { try { await chain.submit(tx); submitErr = ''; break; } catch (e) { submitErr = (e as Error).message; say(`/execute: ${submitErr}`); if (!/may still land|did not answer/.test(submitErr)) break; await new Promise(r => setTimeout(r, 3000)); } }
  let state = 'none'; for (let i = 0; i < 30 && state !== 'included'; i++) { state = await chain.lookup(tx.hash); if (state !== 'included') await new Promise(r => setTimeout(r, 2000)); }
  const rc = state === 'included' ? await chain.receipt(tx.hash) : undefined, after = await balances(rpc, w);
  const landed = (chain as any).rfq.get(tx.hash)?.landed as string | undefined;
  say(state === 'included' ? `\nLanded: ${landed}  (${rc?.status}) in ${((Date.now() - t0) / 1000).toFixed(1)} s` : `\nNot found on chain after 60 s${submitErr ? ` (${submitErr})` : ''}. It can no longer land once the quote expired at ${z.expireAt}.`);
  if (rc) say(`Receipt deltas: SOL ${sol(rc.deltas[NATIVE] ?? 0n)}, USDC ${Number(rc.deltas[USDC] ?? 0n) / 1e6}; network cost charged to you: ${sol(rc.network)} SOL.`);
  say(`Wallet now: ${sol(after.lam)} SOL, ${Number(after.usdc) / 1e6} USDC.`);
  report(side, [`# JupiterZ live ${side} (mainnet, throwaway wallet)`, '', `Run: ${new Date().toISOString()} by the operator (npm run verify:jupiterz-live -- --${side})`, `Node: ${kind}`, `Wallet: ${w}`,
    `Trade: ${side === 'buy' ? `${sol(amountIn)} SOL -> USDC` : `${Number(amountIn) / 1e6} USDC -> SOL`}, minimum ${side === 'buy' ? Number(minOut) / 1e6 + ' USDC' : sol(minOut) + ' SOL'}`, `Maker: ${pm.staticKeys[0]}`,
    `Request: ${z.requestId}, quote expiry ${new Date(z.expireAt * 1000).toISOString()}`, `User signature (engine hash): ${tx.hash}`, `Landed signature: ${landed ?? 'none'}`, `Result: ${state === 'included' ? rc?.status : 'not landed'}${submitErr ? ` (${submitErr})` : ''}`,
    rc ? `Receipt deltas: SOL ${sol(rc.deltas[NATIVE] ?? 0n)}, USDC ${Number(rc.deltas[USDC] ?? 0n) / 1e6}; network cost to the user ${sol(rc.network)} SOL` : '', `Balances before: ${sol(b.lam)} SOL, ${Number(b.usdc) / 1e6} USDC. After: ${sol(after.lam)} SOL, ${Number(after.usdc) / 1e6} USDC.`]);
}

async function refund(to: string) {
  if (!to) { say('Give the address to send the SOL to: --refund <address>'); return; } b58decode(to);
  const { rpc, kind } = await node(), { signer, address: w } = wallet(), b = await balances(rpc, w);
  if (b.usdc > 0n) { say(`The wallet still holds ${Number(b.usdc) / 1e6} USDC. Run --sell first (or it stays in the throwaway wallet).`); return; }
  const total = b.lam + (b.ataExists ? b.ataLamports : 0n), send = total - 5000n;
  if (send <= 0n) { say('Nothing to send back.'); return; }
  if (!(await confirm(`SEND on MAINNET: ${b.ataExists ? 'close the empty USDC account, then ' : ''}transfer ${sol(send)} SOL (everything) from ${w} to ${to}. Node: ${kind}.`, 'SEND'))) { say('Stopped. Nothing was sent.'); return; }
  const bh: any = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = compileLegacy(w, [...(b.ataExists ? [closeAccount(b.ata, w, w)] : []), systemTransfer(w, to, send)], b58decode(bh.value.blockhash)), sig = signer.sign(w, msg);
  const h = await rpc.call<string>('sendTransaction', [Buffer.from(wireTx(msg, [sig])).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  say(`Sent: ${h}`); report('refund', [`# JupiterZ live test: refund`, '', `Run: ${new Date().toISOString()}`, `From ${w} to ${to}: ${sol(send)} SOL`, `Signature: ${h}`]);
}

async function main() {
  if (args[0] === '--buy') return rfqTrade('buy');
  if (args[0] === '--sell') return rfqTrade('sell');
  if (args[0] === '--refund') return refund(args[1] ?? '');
  const { rpc, kind } = await node(), { address, created } = wallet(), b = await balances(rpc, address);
  say(`${created ? 'Created a new' : 'Using the'} throwaway wallet (key in ${KEYFILE}, git-ignored):\n  ${address}\nBalance (${kind}): ${sol(b.lam)} SOL, ${Number(b.usdc) / 1e6} USDC.`);
  say(`\nNext: send about 0.03 SOL to that address, then: npm run verify:jupiterz-live -- --buy 0.02`);
}
main().catch(e => { console.error(redact((e as Error).message)); process.exit(1); });
export { base58 };
