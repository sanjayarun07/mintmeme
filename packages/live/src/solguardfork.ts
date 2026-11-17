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
import { fakePrivy } from '../../sol/test/fakeprivy.ts';

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
    const wseed = randomBytes(32), wallet = new DevSolSigner(), addr = wallet.add(wseed); const sigAirdrop = await rpc.call<string>('requestAirdrop', [addr, Number(3n * SOLN)]); for (let i = 0; i < 80; i++) { const s2: any = await rpc.call('getSignatureStatuses', [[sigAirdrop]]); if (s2.value[0]?.confirmationStatus) break; await new Promise(r => setTimeout(r, 250)); }
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const n1 = sm.authNonce({ address: addr }); const wrongSig = b64(wallet.sign(addr, new TextEncoder().encode('some other message')));
    check('L1 a sign-in with a signature over a different message is refused and connects nothing', await refused(() => sm.authVerify({ address: addr, signature: wrongSig }), /does not match/) && !(await sm.status()).connected);
    const n2 = sm.authNonce({ address: addr }), li = await sm.authVerify({ address: addr, signature: b64(wallet.sign(addr, new TextEncoder().encode(n2.message))) }); const LS = { __session: (li as any).__setSession as string };
    check('L2 signing the one-time message connects that address without any private key reaching the server', li.connected && li.address === addr && !!LS.__session && n1.message !== n2.message);
    check('L3 a request without the session cookie value is refused as not signed in', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01', slippagePct: 3 }), /sign in again/));
    const browser = async (mode: 'approve' | 'decline' | 'tamper', S = LS) => { for (let i = 0; i < 200; i++) { const items = (sm.pendingSigns(S) as any).items; if (items.length) { const it = items[0], msg = Uint8Array.from(Buffer.from(it.message, 'base64')); if (mode === 'decline') { sm.rejectSign({ ...S, id: it.id }); return 'declined'; } if (mode === 'tamper') { let bad: string | undefined; try { sm.submitSign({ ...S, id: it.id, signature: b64(wallet.sign(addr, new Uint8Array([...msg, 1]))) }); } catch (e) { bad = (e as Error).message; } sm.submitSign({ ...S, id: it.id, signature: b64(wallet.sign(addr, msg)) }); return bad ?? 'accepted-bad'; } sm.submitSign({ ...S, id: it.id, signature: b64(wallet.sign(addr, msg)) }); return 'signed'; } await new Promise(r => setTimeout(r, 100)); } return 'none'; };
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

    // ---- Privy automatic trading: a stand-in Privy (same request signing and the README's policy) holds the same key; the engine builds, Privy signs, the validator runs it ----
    const fp = fakePrivy({ seed: wseed, delegated: false }), fsrv = await fp.listen(), saved = { ...process.env };
    Object.assign(process.env, { PRIVY_APP_ID: fp.cfg.appId, PRIVY_APP_SECRET: fp.cfg.appSecret, PRIVY_AUTH_PRIVATE_KEY: fp.cfg.authKey, PRIVY_AUTH_KEY_ID: fp.cfg.signerId, PRIVY_SOLANA_POLICY_ID: fp.cfg.policyId, PRIVY_API_URL: fsrv.url });
    try {
      check('P1 automatic trading needs a signed-in wallet', await refused(() => sm.privyUse({}), /connect a wallet/));
      const np = sm.authNonce({ address: addr }), lp1 = await sm.authVerify({ address: addr, signature: b64(wallet.sign(addr, new TextEncoder().encode(np.message))) }); const PS = { __session: (lp1 as any).__setSession as string };
      check('P2 without the server signer on the Privy wallet, automatic trading is refused and the wallet stays signed in', await refused(() => sm.privyUse(PS), /not allowed automatic trading/) && (await sm.status(PS)).signer === 'wallet');
      fp.state.delegated = 'other-policy'; check('P3 a server signer without this app\'s policy is refused', await refused(() => sm.privyUse(PS), /not limited by this app's trading policy/));
      fp.state.delegated = true; const pu = await sm.privyUse(PS) as any, PU = { __session: pu.__setSession as string };
      check('P4 with the signer and policy on the wallet, the session switches to Privy signing with automatic-trading limits', pu.signer === 'privy' && pu.address === addr && BigInt(pu.limits.maxTradeLamports) <= 50_000_000n && PU.__session !== PS.__session, JSON.stringify(pu).slice(0, 160));
      const t0 = await lt(), pp = await sm.prepare({ ...PU, mint, side: 'buy', sol: '0.02', slippagePct: 5 }), pr = await sm.confirm({ ...PU, ticketId: pp.ticketId, ack: true });
      check('P5 a buy is signed by Privy with no browser and lands on the validator', pr.ok && pr.sent && (await lt()) > t0 && fp.state.signed >= 1, JSON.stringify(pr).slice(0, 200));
      const signedBefore = fp.state.signed, tb = await lt(); await sm.createOrder({ ...PU, ack: true, mint, type: 'limit_buy', sol: '0.01', price: '1000' });
      for (let i = 0; i < 40 && fp.state.signed === signedBefore; i++) await new Promise(r => setTimeout(r, 500));
      for (let i = 0; i < 60 && (await lt()) === tb; i++) await new Promise(r => setTimeout(r, 500));   // the fired trade lands a moment later
      const po = (await sm.listOrders(PU) as any).orders.find((o: any) => o.kind === 'limit_buy');
      check('P6 a standing order fires by itself, Privy signs it, and the tokens arrive', fp.state.signed > signedBefore && po && po.status === 'fired' && (await lt()) > tb, JSON.stringify(po).slice(0, 200));
      fp.state.delegated = false; const t1 = await lt(), rp = await sm.prepare({ ...PU, mint, side: 'buy', sol: '0.01', slippagePct: 5 }), rr = await sm.confirm({ ...PU, ticketId: rp.ticketId, ack: true });
      check('P7 after the user revokes the signer, Privy refuses and nothing is sent', !rr.ok && !rr.sent && (await lt()) === t1, JSON.stringify(rr).slice(0, 200));
      await sm.disconnect(PU);
    } finally { fsrv.close(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }

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
    // ---- editing a trigger, and triggers fixed in USD ----
    const ed = await sm.createOrder({ ...K, ack: true, type: 'limit_sell', mint, pct: 5, price: px * 6 }) as any; await sleep(4000);
    const ed1 = await sm.editOrder({ ...K, id: ed.order.id, price: String(px * 8) }) as any;
    check('O11 editing an active order moves its trigger and it stays active; an edit to a trailing stop is refused', ed1.ok && Math.abs(ed1.order.triggerPriceSol / (px * 8) - 1) < 1e-6 && (await ords()).orders.find((o: any) => o.id === ed.order.id)?.status === 'active' && await refused(() => sm.editOrder({ ...K, id: tr.order.id, price: String(px) }), /trailing stop/), JSON.stringify(ed1.order).slice(0, 200));
    const hE = await hold(); await sm.editOrder({ ...K, id: ed.order.id, price: String(px * 0.5) });
    check('O12 an order edited to a trigger the market already meets fires at the new price and the wallet sells', await until(async () => (await ords()).orders.find((o: any) => o.id === ed.order.id)?.status === 'fired') && await until(async () => (await hold()) < hE), JSON.stringify((await ords()).orders.find((o: any) => o.id === ed.order.id)).slice(0, 200));
    const su = await sm.solUsd();
    if (su) {
      const hU = await hold(), ub = await sm.createOrder({ ...K, ack: true, type: 'limit_buy', mint, sol: '0.01', price: String(px * 1e-6), priceUsd: String(px * su * 1.5) }) as any;
      check('O13 a limit buy set in USD stores the dollar trigger, re-prices its SOL trigger from the live SOL price, and fires', ub.order.triggerUsd > 0 && await until(async () => (await ords()).orders.find((o: any) => o.id === ub.order.id)?.status === 'fired') && await until(async () => (await hold()) > hU), JSON.stringify((await ords()).orders.find((o: any) => o.id === ub.order.id)).slice(0, 220));
    } else check('O13 a limit buy set in USD (skipped: no SOL/USD price reachable from this machine)', false, 'no SOL/USD price');
    await sm.disconnect(K);

    // ---- trading key: a server-held throwaway wallet so orders fire with no browser open. Local validator, fake SOL. ----
    const air = async (addr: string, sol: number) => { const sg = await rpc.call<string>('requestAirdrop', [addr, Math.round(sol * 1e9)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sg]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } };
    const kd = (sm as any).dir as string, kf = join(kd, 'trading-key.json');
    check('K1 before creation there is no trading key', (sm.tradingKeyInfo() as any).exists === false);
    const ki = sm.tradingKeyCreate({ hours: 24 }) as any, kj = JSON.parse(readFileSync(kf, 'utf8')), kp = Uint8Array.from(kj.keypair as number[]);
    check('K2 creating a key saves a Solana CLI keypair file readable only by the owner, and the response never contains the key', ki.exists && (statSync(kf).mode & 0o777) === 0o600 && kp.length === 64 && base58(kp.slice(32)) === ki.address && !JSON.stringify(ki).includes(String(kj.keypair[0]) + ',' + String(kj.keypair[1])), JSON.stringify(ki).slice(0, 160));
    check('K3 a second create is refused so a funded key is never overwritten', await refused(async () => { sm.tradingKeyCreate({}); }, /already exists/));
    // ---- funding the key from the browser wallet (the "Fund trading key" button), exactly as the page does it ----
    const bal = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
    const nf = sm.authNonce({ address: addr }), lf = await sm.authVerify({ address: addr, signature: b64(wallet.sign(addr, new TextEncoder().encode(nf.message))) }); const FS = { __session: (lf as any).__setSession as string };
    check('F1 funding without the acknowledgement is refused and nothing is asked of the wallet', await refused(() => sm.fundTradingKey({ ...FS, sol: '0.03' }), /confirmation box/) && (sm.pendingSigns(FS) as any).items.length === 0);
    check('F2 funding above 0.05 SOL in one go is refused', await refused(() => sm.fundTradingKey({ ...FS, sol: '0.06', ack: true }), /at most 0.05/));
    const kb0 = await bal(ki.address), fsig = browser('approve', FS), fr = await sm.fundTradingKey({ ...FS, sol: '0.03', ack: true }) as any;
    check('F3 funding 0.03 SOL asks the wallet to sign, lands, and the key holds exactly 0.03 SOL more', (await fsig) === 'signed' && fr.ok && fr.to === ki.address && fr.from === addr && (await bal(ki.address)) - kb0 === 30_000_000n, JSON.stringify(fr).slice(0, 200));
    check('F4 a wallet that declines the funding sends nothing', await (async () => { const before = await bal(ki.address), d = browser('decline', FS); const ok = await refused(() => sm.fundTradingKey({ ...FS, sol: '0.01', ack: true }), /declined/); return ok && (await d) === 'declined' && (await bal(ki.address)) === before; })());
    check('F5 the funding wallet is found on chain as a funder of the key', (await sm.keyFunders()).includes(addr));
    await sm.disconnect(FS);
    const ku = await sm.tradingKeyUse() as any, KS = { __session: ku.__setSession as string };
    check('F6 the key cannot fund itself', await refused(() => sm.fundTradingKey({ ...KS, sol: '0.01', ack: true }), /signed-in wallet|cannot fund itself/));
    check('K4 using it connects that address as a key signer and lowers the limits to the key ceilings', ku.connected && ku.address === ki.address && ku.signer === 'key' && ku.tradingKey.active && ku.limits.dailyCapLamports === '250000000', JSON.stringify(ku.limits));
    check('K5 limits above the trading-key ceilings are refused', await refused(async () => { sm.setLimits({ ...KS, maxTradeSol: '0.06', dailyCapSol: '0.1', maxSlippagePct: '5' }); }, /cannot exceed/));
    await air(ki.address, 0.3); await sm.killSwitch(false, KS).catch(() => {});
    const holdK = async () => (await rpc.call<any>('getTokenAccountsByOwner', [ki.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((x: bigint, a: any) => x + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const kh0 = await holdK(), kord = await sm.createOrder({ ...KS, ack: true, type: 'limit_buy', mint, sol: '0.01', price: px * 1.5 }) as any;
    check('K6 with the trading key a limit buy fires by itself, with no browser and no wallet approval, and the key receives tokens', await until(async () => (await sm.listOrders(KS) as any).orders.find((o: any) => o.id === kord.order.id)?.status === 'fired') && await until(async () => (await holdK()) > kh0), JSON.stringify((await sm.listOrders(KS) as any).orders.find((o: any) => o.id === kord.order.id)).slice(0, 200));
    // ---- returning the key's SOL ("Return SOL to your wallet") ----
    const stranger = new DevSolSigner().add(randomBytes(32));
    check('R1 returning SOL to a wallet that never funded the key is refused', await refused(() => sm.tradingKeyReturn({ ...KS, to: stranger, ack: true }), /funded this key/) && (await bal(stranger)) === 0n);
    check('R2 returning without the acknowledgement is refused', await refused(() => sm.tradingKeyReturn({ ...KS, to: addr }), /confirmation box/));
    const wb0 = await bal(addr), kbr = await bal(ki.address), rr = await sm.tradingKeyReturn({ ...KS, to: addr, ack: true }) as any;
    check('R3 returning sends all of the key\'s SOL less the 0.000005 SOL fee to the funding wallet, signed by the key with no browser', rr.ok && (await bal(ki.address)) === 0n && (await bal(addr)) - wb0 === kbr - 5_000n, JSON.stringify(rr).slice(0, 200));
    check('R4 with no SOL left, a second return is refused', await refused(() => sm.tradingKeyReturn({ ...KS, to: addr, ack: true }), /no SOL/));
    (sm as any).keyExpiry = Date.now() - 1; check('K7 when the key expires the server disconnects it by itself', await until(async () => !(await sm.status()).connected, 15_000));
    const kj2 = JSON.parse(readFileSync(kf, 'utf8')); kj2.expiresAt = Date.now() - 1000; writeFileSync(kf, JSON.stringify(kj2), { mode: 0o600 });
    check('K8 an expired key cannot be used', await refused(() => sm.tradingKeyUse(), /expired/));
    kj2.expiresAt = Date.now() + 3_600_000; writeFileSync(kf, JSON.stringify(kj2), { mode: 0o600 }); await air(ki.address, 0.6);
    check('K9 a key holding more than the balance ceiling is refused and nothing stays connected', await refused(() => sm.tradingKeyUse(), /limited to/) && !(await sm.status()).connected);
    const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-sol-guard.md`;
    writeFileSync(file, ['# Guarded Solana trading path on a local validator', '', `Run: ${new Date().toISOString()}`, 'Node: local solana-test-validator with the pump.fun program and a live curve cloned. NOT mainnet. Fake SOL, throwaway key.', `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length})`, '', ...checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' - ' + c.detail}`), '',
      '## Not covered', '- Privy (P checks) is a local stand-in that signs requests and applies the README policy the way Privy documents it; the real Privy API and its TEE are not called here.', '- No mainnet trade has been made. Real fills differ from a local clone: price impact, competing bots, fees and Jupiter routes are not exercised here (this run uses a pump.fun curve).', '- The terminal has no login: the cross-site request check is not exercised by this script.', ''].join('\n'));
    console.log(`\nreport: ${file}`); process.exitCode = pass ? 0 : 1;
  } finally { env.stop(); }
}
main().catch(e => { console.error(String((e as Error).stack ?? e).replace(/[A-Za-z0-9_-]{24,}/g, m => m.length > 40 ? '***' : m)); process.exit(1); });
