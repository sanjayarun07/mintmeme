/** GUARDED TRADING PATH, END TO END, ON A LOCAL SOLANA VALIDATOR WITH FAKE SOL. The same `SolMainnet` module the terminal uses (key connect, limits, kill switch, prepare, confirm) is pointed at a loopback
 *  solana-test-validator that has the pump.fun program and one live curve cloned into it. Throwaway key, fake funds, nothing reaches mainnet and no mainnet trade is made.
 *  usage: npm run verify:sol-guard (needs ALCHEMY_API_KEY in .env and solana-test-validator). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { base58, SolJsonRpc, DevSolSigner } from '../../sol/src/index.ts';
import { startPumpValidator } from './pumpenv.ts';
import { SolMainnet } from '../../../apps/web/solmainnet.ts';

const SOLN = 1_000_000_000n;
async function main() {
  const key = process.env.ALCHEMY_API_KEY; if (!key) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  const checks: { name: string; pass: boolean; detail: string }[] = []; const check = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass, detail }); console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${pass ? '' : '  -> ' + detail}`); };
  const env = await startPumpValidator(key, 8990); const rpc = new SolJsonRpc(env.url);
  try {
    const mint = env.mint, seed = randomBytes(32), sm = new SolMainnet(mkdtempSync(join(tmpdir(), 'memedesk-solguard-')), env.url, ['pump'])   // pump.fun only: a Jupiter route points at mainnet accounts that do not exist on the local clone;
    const refused = async (f: () => Promise<unknown>, re: RegExp) => { try { await f(); return false; } catch (e) { return re.test((e as Error).message); } };
    check('G1 a wallet cannot trade before one is connected', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01' }), /connect a wallet/));
    check('G2 a malformed key is refused and nothing is connected', await refused(() => sm.connect({ key: 'not a key' }), /private key|bytes/) && !(await sm.status()).connected);
    const st = await sm.connect({ key: base58(seed) }); const S = { __session: (st as any).__setSession as string }; check('G3 connecting a key shows the wallet address and never echoes the key', st.connected && !!st.address && !JSON.stringify(st).includes(base58(seed)), JSON.stringify(st).slice(0, 120));
    const sig = await rpc.call<string>('requestAirdrop', [st.address, Number(5n * SOLN)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) break; await new Promise(r => setTimeout(r, 250)); }
    const tokOf = async () => (await rpc.call<any>('getTokenAccountsByOwner', [st.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((s: bigint, a: any) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const lamports = async () => BigInt((await rpc.call<any>('getBalance', [st.address, { commitment: 'confirmed' }])).value);
    await sm.setLimits({ ...S, maxTradeSol: '0.05', dailyCapSol: '0.08', maxSlippagePct: '5' });
    check('G4 an amount above the per-trade limit is refused before any quote', await refused(() => sm.prepare({ ...S, mint, side: 'buy', sol: '0.06', slippagePct: 3 }), /per-trade limit/));
    check('G5 slippage above the limit is refused', await refused(() => sm.prepare({ ...S, mint, side: 'buy', sol: '0.01', slippagePct: 9 }), /slippage/));
    const p = await sm.prepare({ ...S, mint, side: 'buy', sol: '0.04', slippagePct: 5 }); check('G6 prepare returns a ticket with a route, a quote and a successful simulation, and spends nothing', !!p.ticketId && p.simulation.status === 'success' && p.canConfirm && (await tokOf()) === 0n && (await lamports()) >= 5n * SOLN - 10_000n, JSON.stringify(p).slice(0, 220));
    check('G7 confirming without the explicit acknowledgement is refused', await refused(() => sm.confirm({ ...S, ticketId: p.ticketId }), /ack/));
    const before = await lamports(), r = await sm.confirm({ ...S, ticketId: p.ticketId, ack: true });
    check('G8 confirming runs the trade: it is sent, finalizes, and the wallet receives tokens for its SOL', r.ok && r.sent && !!r.signature && (await tokOf()) > 0n && before - (await lamports()) >= 40_000_000n, JSON.stringify(r).slice(0, 220));
    check('G9 the same ticket cannot be used twice', await refused(() => sm.confirm({ ...S, ticketId: p.ticketId, ack: true }), /unknown or already used|already used/));
    check('G10 the daily cap counts the confirmed buy and refuses the next one that would pass it', (await sm.status()).spentTodayLamports === '40000000' && await refused(() => sm.prepare({ ...S, mint, side: 'buy', sol: '0.05', slippagePct: 5 }), /daily cap/));
    await sm.killSwitch(true); check('G11 the kill switch refuses new trades', await refused(() => sm.prepare({ ...S, mint, side: 'buy', sol: '0.01', slippagePct: 3 }), /kill switch/));
    await sm.killSwitch(false, S); const p2 = await sm.prepare({ ...S, mint, side: 'buy', sol: '0.01', slippagePct: 5 }); await sm.killSwitch(true);
    check('G12 a ticket prepared before the kill switch cannot be confirmed after it', await refused(() => sm.confirm({ ...S, ticketId: p2.ticketId, ack: true }), /kill switch/));
    await sm.killSwitch(false, S); const tk = await tokOf(), s = await sm.prepare({ ...S, mint, side: 'sell', pct: 50, slippagePct: 5 }), sr = await sm.confirm({ ...S, ticketId: s.ticketId, ack: true });
    check('G13 a sell of half the position runs through the same guarded path and the wallet holds less', sr.ok && sr.sent && (await tokOf()) < tk && (await tokOf()) > 0n, JSON.stringify(sr).slice(0, 220));
    const d = await sm.disconnect(S); check('G14 disconnecting drops the wallet: trades are refused again', !d.connected && await refused(() => sm.prepare({ ...S, mint, side: 'buy', sol: '0.01' }), /connect a wallet/));

    // ---- wallet login: the key stays in a simulated browser wallet; the server only ever sees signatures ----
    const wallet = new DevSolSigner(), addr = wallet.add(randomBytes(32)); const sigAirdrop = await rpc.call<string>('requestAirdrop', [addr, Number(3n * SOLN)]); for (let i = 0; i < 80; i++) { const s2: any = await rpc.call('getSignatureStatuses', [[sigAirdrop]]); if (s2.value[0]?.confirmationStatus) break; await new Promise(r => setTimeout(r, 250)); }
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const n1 = sm.authNonce({ address: addr }); const wrongSig = b64(wallet.sign(addr, new TextEncoder().encode('some other message')));
    check('L1 a sign-in with a signature over a different message is refused and connects nothing', await refused(() => sm.authVerify({ address: addr, signature: wrongSig }), /does not match/) && !(await sm.status()).connected);
    const n2 = sm.authNonce({ address: addr }), li = await sm.authVerify({ address: addr, signature: b64(wallet.sign(addr, new TextEncoder().encode(n2.message))) }); const LS = { __session: (li as any).__setSession as string };
    check('L2 signing the one-time message connects that address without any private key reaching the server', li.connected && li.address === addr && !!LS.__session && n1.message !== n2.message);
    check('L3 a request without the session cookie value is refused as not signed in', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01', slippagePct: 3 }), /sign in again/));
    const browser = async (mode: 'approve' | 'decline' | 'tamper') => { for (let i = 0; i < 200; i++) { const items = (sm.pendingSigns(LS) as any).items; if (items.length) { const it = items[0], msg = Uint8Array.from(Buffer.from(it.message, 'base64')); if (mode === 'decline') { sm.rejectSign({ ...LS, id: it.id }); return 'declined'; } if (mode === 'tamper') { let bad: string | undefined; try { sm.submitSign({ ...LS, id: it.id, signature: b64(wallet.sign(addr, new Uint8Array([...msg, 1]))) }); } catch (e) { bad = (e as Error).message; } sm.submitSign({ ...LS, id: it.id, signature: b64(wallet.sign(addr, msg)) }); return bad ?? 'accepted-bad'; } sm.submitSign({ ...LS, id: it.id, signature: b64(wallet.sign(addr, msg)) }); return 'signed'; } await new Promise(r => setTimeout(r, 100)); } return 'none'; };
    await sm.setLimits({ ...LS, maxTradeSol: '0.05', dailyCapSol: '0.2', maxSlippagePct: '5' });
    const lt = async () => (await rpc.call<any>('getTokenAccountsByOwner', [addr, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const lp = await sm.prepare({ ...LS, mint, side: 'buy', sol: '0.02', slippagePct: 5 }); const bp = browser('approve'), lr = await sm.confirm({ ...LS, ticketId: lp.ticketId, ack: true });
    check('L4 a buy asks the wallet to sign, lands on the validator, and the wallet receives tokens', (await bp) === 'signed' && lr.ok && lr.sent && (await lt()) > 0n, JSON.stringify(lr).slice(0, 200));
    const sp0 = (await sm.status()).spentTodayLamports; const lp2 = await sm.prepare({ ...LS, mint, side: 'buy', sol: '0.02', slippagePct: 5 }), t0 = await lt(); const bp2 = browser('decline'), lr2 = await sm.confirm({ ...LS, ticketId: lp2.ticketId, ack: true });
    check('L5 a wallet that declines the signature ends the trade with nothing sent and the daily budget given back', (await bp2) === 'declined' && !lr2.ok && !lr2.sent && (await lt()) === t0 && (await sm.status()).spentTodayLamports === sp0, JSON.stringify(lr2).slice(0, 200));
    const lp3 = await sm.prepare({ ...LS, mint, side: 'buy', sol: '0.02', slippagePct: 5 }); const bp3 = browser('tamper'), lr3 = await sm.confirm({ ...LS, ticketId: lp3.ticketId, ack: true });
    check('L6 a signature over a changed transaction is rejected by the server, and the right signature afterwards still completes the trade', /does not match this transaction/.test(String(await bp3)) && lr3.ok && lr3.sent, String(JSON.stringify(lr3)).slice(0, 200));
    await sm.killSwitch(true); check('L7 the emergency stop works without a session', await refused(() => sm.prepare({ ...LS, mint, side: 'buy', sol: '0.01', slippagePct: 3 }), /kill switch/));
    check('L8 turning it back off needs the session', await refused(async () => { sm.killSwitch(false, {}); }, /sign in again/)); await sm.killSwitch(false, LS);
    const ld = await sm.disconnect(LS); check('L9 signing out disconnects the wallet and clears the session', !ld.connected && (ld as any).__setSession === '');

    // ---- standing orders and TWAP (pasted-key mode: nothing needs a browser to approve a fire) ----
    const k2 = await sm.connect({ key: base58(seed) }); const K = { __session: (k2 as any).__setSession as string };
    await sm.setLimits({ ...K, maxTradeSol: '0.05', dailyCapSol: '0.5', maxSlippagePct: '5' });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)); const ords = async () => (await sm.listOrders(K)) as any;
    const until = async (f: () => Promise<boolean>, ms = 60_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(500); } return false; };
    const ctx = await sm.orderContext({ ...K, mint }); const px = ctx.priceSol as number, hold = async () => (await rpc.call<any>('getTokenAccountsByOwner', [k2.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    check('O1 the order form gets the live price, decimals and balance', typeof px === 'number' && px > 0 && ctx.decimals >= 0 && BigInt(ctx.balanceRaw) > 0n, JSON.stringify(ctx).slice(0, 160));
    check('O2 an order is refused without the acknowledgement, and a limit buy above the per-trade limit is refused', await refused(() => sm.createOrder({ ...K, type: 'limit_buy', mint, sol: '0.01', price: px * 0.5 }), /ack/) && await refused(() => sm.createOrder({ ...K, ack: true, type: 'limit_buy', mint, sol: '0.06', price: px * 0.5 }), /per-trade limit/));
    const far = await sm.createOrder({ ...K, ack: true, type: 'limit_sell', mint, pct: 10, price: px * 5 }) as any; await sleep(6000);
    check('O3 a limit sell far above the market is accepted and stays active', far.order.status === 'active' && (await ords()).orders.find((o: any) => o.id === far.order.id)?.status === 'active', JSON.stringify(far).slice(0, 200));
    const h0 = await hold(), lb = await sm.createOrder({ ...K, ack: true, type: 'limit_buy', mint, sol: '0.02', price: px * 1.5 }) as any;
    check('O4 a limit buy whose trigger is already met fires by itself and the wallet receives tokens', await until(async () => (await ords()).orders.find((o: any) => o.id === lb.order.id)?.status === 'fired') && await until(async () => (await hold()) > h0), JSON.stringify((await ords()).orders.find((o: any) => o.id === lb.order.id)).slice(0, 220));
    const br = await sm.createOrder({ ...K, ack: true, type: 'bracket', mint, pct: 10, tpPrice: px * 4, slPrice: px * 0.2 }) as any;
    check('O5 a bracket (take profit and stop loss) places two linked orders', br.orders?.length === 2 && br.orders[0].oco === br.orders[1].oco, JSON.stringify(br).slice(0, 200));
    const tr = await sm.createOrder({ ...K, ack: true, type: 'trailing_stop', mint, pct: 10, trailPct: 20 }) as any; check('O6 a trailing stop is accepted', tr.order.kind === 'trailing_stop' && tr.order.trailPct === 20);
    await sm.cancelOrder({ ...K, id: far.order.id }); check('O7 cancelling an order frees it', (await ords()).orders.find((o: any) => o.id === far.order.id)?.status === 'cancelled');
    (sm as any).ticking = true; await sleep(2500);   // hold the order loop while the order is placed, so the order cannot fire before the kill switch is on
    const h1 = await hold(), lb2 = await sm.createOrder({ ...K, ack: true, type: 'limit_buy', mint, sol: '0.01', price: px * 2 }) as any; await sm.killSwitch(true); (sm as any).ticking = false; await sleep(7000);
    const heldKilled = (await ords()).orders.find((o: any) => o.id === lb2.order.id)?.status === 'active' && (await hold()) === h1;
    await sm.killSwitch(false, K); const fired2 = await until(async () => (await ords()).orders.find((o: any) => o.id === lb2.order.id)?.status === 'fired');
    check('O8 while the kill switch is on no order fires; when it is turned off the waiting order fires', heldKilled && fired2, `heldKilled ${heldKilled} fired ${fired2}`);
    const h2 = await hold(), tw = await sm.createOrder({ ...K, ack: true, type: 'twap', side: 'buy', mint, sol: '0.02', slices: 2, intervalMin: 0.2 }) as any;
    check('O9 a TWAP buy of 2 slices spaced 12 seconds apart fills both slices and the wallet receives tokens', await until(async () => ((await ords()).twaps.find((t: any) => t.id === tw.twap.id)?.filled ?? 0) >= 2, 90_000) && (await hold()) > h2, JSON.stringify((await ords()).twaps).slice(0, 200));
    check('O10 a TWAP whose slices exceed the per-trade limit is refused', await refused(() => sm.createOrder({ ...K, ack: true, type: 'twap', side: 'buy', mint, sol: '0.2', slices: 2, intervalMin: 1 }), /per-trade limit/));
    await sm.disconnect(K);

    // ---- trading key: a server-held throwaway wallet so orders fire with no browser open. Local validator, fake SOL. ----
    const air = async (addr: string, sol: number) => { const sg = await rpc.call<string>('requestAirdrop', [addr, Math.round(sol * 1e9)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sg]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } };
    const kd = (sm as any).dir as string, kf = join(kd, 'trading-key.json');
    check('K1 before creation there is no trading key', (sm.tradingKeyInfo() as any).exists === false);
    const ki = sm.tradingKeyCreate({ hours: 24 }) as any, kj = JSON.parse(readFileSync(kf, 'utf8')), kp = Uint8Array.from(kj.keypair as number[]);
    check('K2 creating a key saves a Solana CLI keypair file readable only by the owner, and the response never contains the key', ki.exists && (statSync(kf).mode & 0o777) === 0o600 && kp.length === 64 && base58(kp.slice(32)) === ki.address && !JSON.stringify(ki).includes(String(kj.keypair[0]) + ',' + String(kj.keypair[1])), JSON.stringify(ki).slice(0, 160));
    check('K3 a second create is refused so a funded key is never overwritten', await refused(async () => { sm.tradingKeyCreate({}); }, /already exists/));
    const ku = await sm.tradingKeyUse() as any, KS = { __session: ku.__setSession as string };
    check('K4 using it connects that address as a key signer and lowers the limits to the key ceilings', ku.connected && ku.address === ki.address && ku.signer === 'key' && ku.tradingKey.active && ku.limits.dailyCapLamports === '250000000', JSON.stringify(ku.limits));
    check('K5 limits above the trading-key ceilings are refused', await refused(async () => { sm.setLimits({ ...KS, maxTradeSol: '0.06', dailyCapSol: '0.1', maxSlippagePct: '5' }); }, /cannot exceed/));
    await air(ki.address, 0.3); await sm.killSwitch(false, KS).catch(() => {});
    const holdK = async () => (await rpc.call<any>('getTokenAccountsByOwner', [ki.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const kh0 = await holdK(), kord = await sm.createOrder({ ...KS, ack: true, type: 'limit_buy', mint, sol: '0.01', price: px * 1.5 }) as any;
    check('K6 with the trading key a limit buy fires by itself, with no browser and no wallet approval, and the key receives tokens', await until(async () => (await sm.listOrders(KS) as any).orders.find((o: any) => o.id === kord.order.id)?.status === 'fired') && await until(async () => (await holdK()) > kh0), JSON.stringify((await sm.listOrders(KS) as any).orders.find((o: any) => o.id === kord.order.id)).slice(0, 200));
    (sm as any).keyExpiry = Date.now() - 1; check('K7 when the key expires the server disconnects it by itself', await until(async () => !(await sm.status()).connected, 15_000));
    const kj2 = JSON.parse(readFileSync(kf, 'utf8')); kj2.expiresAt = Date.now() - 1000; writeFileSync(kf, JSON.stringify(kj2), { mode: 0o600 });
    check('K8 an expired key cannot be used', await refused(() => sm.tradingKeyUse(), /expired/));
    kj2.expiresAt = Date.now() + 3_600_000; writeFileSync(kf, JSON.stringify(kj2), { mode: 0o600 }); await air(ki.address, 0.6);
    check('K9 a key holding more than the balance ceiling is refused and nothing stays connected', await refused(() => sm.tradingKeyUse(), /limited to/) && !(await sm.status()).connected);
    const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-sol-guard.md`;
    writeFileSync(file, ['# Guarded Solana trading path on a local validator', '', `Run: ${new Date().toISOString()}`, 'Node: local solana-test-validator with the pump.fun program and a live curve cloned. NOT mainnet. Fake SOL, throwaway key.', `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length})`, '', ...checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' - ' + c.detail}`), '',
      '## Not covered', '- No mainnet trade has been made. Real fills differ from a local clone: price impact, competing bots, fees and Jupiter routes are not exercised here (this run uses a pump.fun curve).', '- The terminal has no login: the cross-site request check is not exercised by this script.', ''].join('\n'));
    console.log(`\nreport: ${file}`); process.exitCode = pass ? 0 : 1;
  } finally { env.stop(); }
}
main().catch(e => { console.error(String((e as Error).stack ?? e).replace(/[A-Za-z0-9_-]{24,}/g, m => m.length > 40 ? '***' : m)); process.exit(1); });
