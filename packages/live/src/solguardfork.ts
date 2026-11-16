/** GUARDED TRADING PATH, END TO END, ON A LOCAL SOLANA VALIDATOR WITH FAKE SOL. The same `SolMainnet` module the terminal uses (key connect, limits, kill switch, prepare, confirm) is pointed at a loopback
 *  solana-test-validator that has the pump.fun program and one live curve cloned into it. Throwaway key, fake funds, nothing reaches mainnet and no mainnet trade is made.
 *  usage: npm run verify:sol-guard (needs ALCHEMY_API_KEY in .env and solana-test-validator). Writes a redacted report to docs/live-verification/. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { base58, SolJsonRpc } from '../../sol/src/index.ts';
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
    const st = await sm.connect({ key: base58(seed) }); check('G3 connecting a key shows the wallet address and never echoes the key', st.connected && !!st.address && !JSON.stringify(st).includes(base58(seed)), JSON.stringify(st).slice(0, 120));
    const sig = await rpc.call<string>('requestAirdrop', [st.address, Number(5n * SOLN)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) break; await new Promise(r => setTimeout(r, 250)); }
    const tokOf = async () => (await rpc.call<any>('getTokenAccountsByOwner', [st.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))).value.reduce((s: bigint, a: any) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const lamports = async () => BigInt((await rpc.call<any>('getBalance', [st.address, { commitment: 'confirmed' }])).value);
    await sm.setLimits({ maxTradeSol: '0.05', dailyCapSol: '0.08', maxSlippagePct: '5' });
    check('G4 an amount above the per-trade limit is refused before any quote', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.06', slippagePct: 3 }), /per-trade limit/));
    check('G5 slippage above the limit is refused', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01', slippagePct: 9 }), /slippage/));
    const p = await sm.prepare({ mint, side: 'buy', sol: '0.04', slippagePct: 5 }); check('G6 prepare returns a ticket with a route, a quote and a successful simulation, and spends nothing', !!p.ticketId && p.simulation.status === 'success' && p.canConfirm && (await tokOf()) === 0n && (await lamports()) >= 5n * SOLN - 10_000n, JSON.stringify(p).slice(0, 220));
    check('G7 confirming without the explicit acknowledgement is refused', await refused(() => sm.confirm({ ticketId: p.ticketId }), /ack/));
    const before = await lamports(), r = await sm.confirm({ ticketId: p.ticketId, ack: true });
    check('G8 confirming runs the trade: it is sent, finalizes, and the wallet receives tokens for its SOL', r.ok && r.sent && !!r.signature && (await tokOf()) > 0n && before - (await lamports()) >= 40_000_000n, JSON.stringify(r).slice(0, 220));
    check('G9 the same ticket cannot be used twice', await refused(() => sm.confirm({ ticketId: p.ticketId, ack: true }), /unknown or already used|already used/));
    check('G10 the daily cap counts the confirmed buy and refuses the next one that would pass it', (await sm.status()).spentTodayLamports === '40000000' && await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.05', slippagePct: 5 }), /daily cap/));
    await sm.killSwitch(true); check('G11 the kill switch refuses new trades', await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01', slippagePct: 3 }), /kill switch/));
    await sm.killSwitch(false); const p2 = await sm.prepare({ mint, side: 'buy', sol: '0.01', slippagePct: 5 }); await sm.killSwitch(true);
    check('G12 a ticket prepared before the kill switch cannot be confirmed after it', await refused(() => sm.confirm({ ticketId: p2.ticketId, ack: true }), /kill switch/));
    await sm.killSwitch(false); const tk = await tokOf(), s = await sm.prepare({ mint, side: 'sell', pct: 50, slippagePct: 5 }), sr = await sm.confirm({ ticketId: s.ticketId, ack: true });
    check('G13 a sell of half the position runs through the same guarded path and the wallet holds less', sr.ok && sr.sent && (await tokOf()) < tk && (await tokOf()) > 0n, JSON.stringify(sr).slice(0, 220));
    const d = await sm.disconnect(); check('G14 disconnecting drops the wallet: trades are refused again', !d.connected && await refused(() => sm.prepare({ mint, side: 'buy', sol: '0.01' }), /connect a wallet/));
    const pass = checks.every(c => c.pass); mkdirSync('docs/live-verification', { recursive: true });
    const file = `docs/live-verification/${new Date().toISOString().replace(/[:.]/g, '-')}-sol-guard.md`;
    writeFileSync(file, ['# Guarded Solana trading path on a local validator', '', `Run: ${new Date().toISOString()}`, 'Node: local solana-test-validator with the pump.fun program and a live curve cloned. NOT mainnet. Fake SOL, throwaway key.', `Result: **${pass ? 'PASS' : 'FAIL'}** (${checks.filter(c => c.pass).length}/${checks.length})`, '', ...checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' - ' + c.detail}`), '',
      '## Not covered', '- No mainnet trade has been made. Real fills differ from a local clone: price impact, competing bots, fees and Jupiter routes are not exercised here (this run uses a pump.fun curve).', '- The terminal has no login: the cross-site request check is not exercised by this script.', ''].join('\n'));
    console.log(`\nreport: ${file}`); process.exitCode = pass ? 0 : 1;
  } finally { env.stop(); }
}
main().catch(e => { console.error(String((e as Error).stack ?? e).replace(/[A-Za-z0-9_-]{24,}/g, m => m.length > 40 ? '***' : m)); process.exit(1); });
