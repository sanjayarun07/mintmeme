/** Local solana-test-validator that clones the pump.fun program, its fee program, the Global and fee-config accounts, and ONE live bonding curve (mint, curve, curve token account, creator vault) from Solana mainnet,
 *  found by reading recent pump program transactions. The Alchemy key stays in this process: the validator fetches through a loopback proxy that adds the key (never in argv). Everything run against it is local with fake SOL. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urls } from './config.ts';
import { SolJsonRpc, PUMP_PROGRAM, PUMP_FEE_PROGRAM, pumpAddresses, decodeCurve, decodeGlobal, untradableReason } from '../../sol/src/index.ts';
import type { CurveState, GlobalState } from '../../sol/src/index.ts';
import { b58decode, findProgramAddress, pubkeyBytes } from '../../sol/src/tx.ts';

export interface PumpEnv { rpc: SolJsonRpc; url: string; mint: string; tokenProgram: string; curve: CurveState; global: GlobalState; cloned: string[]; mainnetSlot: number; redact: (s: string) => string; stop: () => void; log: () => string }

/** Read-only: find a curve we can trade among the accounts touched by the most recent pump program transactions. */
export async function discoverCurve(call: (m: string, p: unknown[]) => Promise<any>, tries = 120) {
  const sigs: any[] = await call('getSignaturesForAddress', [PUMP_PROGRAM, { limit: tries }]); const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue; const t = await call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]).catch(() => null); if (!t) continue;
    const keys: string[] = [...t.transaction.message.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
    const ixs = [...t.transaction.message.instructions, ...(t.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)].filter((ix: any) => keys[ix.programIdIndex] === PUMP_PROGRAM);
    for (const ix of ixs) for (const ai of ix.accounts as number[]) {
      const mint = keys[ai]; if (seen.has(mint) || mint.length < 32) continue; seen.add(mint);
      let curveAddr: string; try { curveAddr = pumpAddresses(mint, mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').bondingCurve; } catch { continue; }
      if (!keys.includes(curveAddr)) continue;                                      // a real mint of this transaction has its curve in the same transaction
      const r = await call('getMultipleAccounts', [[curveAddr, mint], { encoding: 'base64' }]); const [c, m] = r.value; if (!c || !m || c.owner !== PUMP_PROGRAM) continue;
      let curve: CurveState; try { curve = decodeCurve(Buffer.from(c.data[0], 'base64')); } catch { continue; }
      if (untradableReason(curve, m.owner) || curve.realToken < 10n ** 12n) continue;
      return { mint, tokenProgram: m.owner as string, curve };
    }
  }
  throw new Error('no tradable pump.fun curve found among the most recent transactions (try again in a moment)');
}

/** Read-only: load the curve of ONE given mint, or explain exactly why it cannot be traded here. */
export async function loadCurve(call: (m: string, p: unknown[]) => Promise<any>, mint: string) {
  let curveAddr: string; try { curveAddr = pumpAddresses(mint, mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').bondingCurve; } catch { throw new Error(`"${mint}" is not a valid Solana address`); }
  const r = await call('getMultipleAccounts', [[curveAddr, mint], { encoding: 'base64' }]); const [c, m] = r.value;
  if (!m) throw new Error('that mint does not exist on Solana mainnet');
  if (!c || c.owner !== PUMP_PROGRAM) throw new Error('that mint has no pump.fun bonding curve (it was not launched on pump.fun, or the curve account is gone)');
  const curve = decodeCurve(Buffer.from(c.data[0], 'base64')); const why = untradableReason(curve, m.owner);
  if (why) throw new Error(`that curve cannot be traded here: ${why}`);
  return { mint, tokenProgram: m.owner as string, curve };
}

export async function startPumpValidator(key: string, port: number, mint?: string): Promise<PumpEnv> {
  const redact = (s: string) => s.split(key).join('***'), upstream = urls(key).sol;
  let n = 0; const call = async (m: string, p: unknown[]) => { const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: m, params: p }) }); if (!r.ok) throw new Error(`mainnet read HTTP ${r.status} on ${m}`); const j: any = await r.json(); if (j.error) throw new Error(redact(`${m}: ${j.error.message}`)); return j.result; };
  const mainnetSlot = await call('getSlot', []);
  const found = mint ? await loadCurve(call, mint) : await discoverCurve(call); const a = pumpAddresses(found.mint, found.curve.creator, found.tokenProgram);
  const gi = await call('getAccountInfo', [a.global, { encoding: 'base64' }]); const global = decodeGlobal(Buffer.from(gi.value.data[0], 'base64'));
  const want = [a.global, a.feeConfig, a.globalVolumeAccumulator, a.bondingCurve, found.mint, a.associatedBondingCurve, a.creatorVault, global.feeRecipient, ...global.buybackRecipients.slice(0, 1), findProgramAddress([new TextEncoder().encode('bonding-curve-v2'), pubkeyBytes(found.mint)], PUMP_PROGRAM).address];
  const have = await call('getMultipleAccounts', [want, { encoding: 'base64' }]); const cloned = want.filter((_, i) => have.value[i]);
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    try { const u = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) }); res.writeHead(u.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await u.arrayBuffer())); }
    catch { res.writeHead(502); res.end('{"error":"upstream unreachable"}'); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const args = ['--reset', '--quiet', '--ledger', mkdtempSync(join(tmpdir(), 'memedesk-pump-')), '--rpc-port', String(port), '--faucet-port', String(port + 2), '--bind-address', '127.0.0.1', '--url', proxyUrl,
    '--clone-upgradeable-program', PUMP_PROGRAM, '--clone-upgradeable-program', PUMP_FEE_PROGRAM, ...cloned.flatMap(x => ['--clone', x])];
  const child = spawn('solana-test-validator', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; child.stdout.on('data', d => { buf += d; }); child.stderr.on('data', d => { buf += d; });
  const url = `http://127.0.0.1:${port}`, rpc = new SolJsonRpc(url), stop = () => { child.kill(); proxy.close(); };
  let up = false; for (let i = 0; i < 160 && !up; i++) { await new Promise(r => setTimeout(r, 500)); try { up = (await rpc.call('getHealth')) === 'ok'; } catch { up = false; } }
  if (!up) { stop(); throw new Error(`solana-test-validator did not start: ${redact(buf).slice(-600)}`); }
  void b58decode;
  return { rpc, url, mint: found.mint, tokenProgram: found.tokenProgram, curve: found.curve, global, cloned, mainnetSlot, redact, stop, log: () => redact(buf) };
}
