/** Starts a LOCAL anvil forked from Ethereum mainnet. The Alchemy key stays in this process: anvil forks a loopback proxy that adds the key
 *  (never in argv or anvil's environment). Everything run against the returned node is local with fake ETH. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { LocalNode } from './localnode.ts';

export async function startFork(key: string, port: number, upstreamUrl?: string): Promise<{ node: LocalNode; redact: (s: string) => string; stop: () => void }> {
  const upstream = upstreamUrl ?? `https://eth-mainnet.g.alchemy.com/v2/${key}`;
  const redact = (s: string) => s.split(upstream).join('***').split(key).join('***');
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    try { const u = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) }); res.writeHead(u.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await u.arrayBuffer())); }
    catch { res.writeHead(502); res.end('{"error":"upstream unreachable"}'); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = (proxy.address() as { port: number }).port;
  const child = spawn('anvil', ['--port', String(port), '--host', '127.0.0.1', '--silent', '--fork-url', `http://127.0.0.1:${proxyPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = ''; child.stderr.on('data', d => { errBuf += d; });
  const node = new LocalNode(`http://127.0.0.1:${port}`);
  const stop = () => { child.kill(); proxy.close(); };
  let up = false; for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 500)); up = (await node.tryCall('eth_chainId')).ok; }
  if (!up) { stop(); throw new Error(`anvil did not start: ${redact(errBuf).slice(0, 300)}`); }
  return { node, redact, stop };
}
