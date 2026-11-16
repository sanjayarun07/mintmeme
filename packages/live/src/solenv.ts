/** Starts a LOCAL solana-test-validator that clones the Raydium AMM v4 program, the SOL/USDC pool and its serum market from Solana mainnet.
 *  The Alchemy key stays in this process: the validator fetches through a loopback proxy that adds the key (never in argv). Everything run against it is local with fake SOL. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc } from './rpc.ts';
import { SOL, SOL_POOL, urls } from './config.ts';
import { loadPoolKeys, SolJsonRpc } from '../../sol/src/index.ts';
import type { PoolKeys } from '../../sol/src/index.ts';

export interface SolEnv { rpc: SolJsonRpc; url: string; keys: PoolKeys; redact: (s: string) => string; stop: () => void; log: () => string }
export async function startSolValidator(key: string, port: number): Promise<SolEnv> {
  const redact = (s: string) => s.split(key).join('***');
  const upstream = urls(key).sol, programId = SOL.programs[0].address;
  const main = new Rpc(upstream, key, fetch, 150);
  const { keys } = await loadPoolKeys(main as any, SOL_POOL.id, programId);
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    try { const u = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) }); res.writeHead(u.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await u.arrayBuffer())); }
    catch { res.writeHead(502); res.end('{"error":"upstream unreachable"}'); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const accounts = [keys.id, keys.openOrders, keys.targetOrders, keys.baseVault, keys.quoteVault, keys.market, keys.bids, keys.asks, keys.eventQueue, keys.marketBaseVault, keys.marketQuoteVault, SOL_POOL.usdc.mint];
  const args = ['--reset', '--quiet', '--ledger', mkdtempSync(join(tmpdir(), 'memedesk-sol-')), '--rpc-port', String(port), '--faucet-port', String(port + 1), '--bind-address', '127.0.0.1', '--url', proxyUrl,
    '--clone-upgradeable-program', programId, '--clone-upgradeable-program', keys.marketProgram, ...accounts.flatMap(a => ['--clone', a])];
  const child = spawn('solana-test-validator', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = ''; child.stdout.on('data', d => { buf += d; }); child.stderr.on('data', d => { buf += d; });
  const url = `http://127.0.0.1:${port}`, rpc = new SolJsonRpc(url), stop = () => { child.kill(); proxy.close(); };
  let up = false; for (let i = 0; i < 120 && !up; i++) { await new Promise(r => setTimeout(r, 500)); try { up = (await rpc.call('getHealth')) === 'ok'; } catch { up = false; } }
  if (!up) { stop(); throw new Error(`solana-test-validator did not start: ${redact(buf).slice(-500)}`); }
  return { rpc, url, keys, redact, stop, log: () => redact(buf) };
}
