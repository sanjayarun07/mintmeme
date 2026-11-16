/** TEST CONSOLE: a browser page to drive the SDK by hand against a LOCAL pump.fun bonding curve on a loopback solana-test-validator (the real pump program cloned from mainnet, fake SOL, throwaway keys).
 *  Everything the page does goes through the real HTTP API (`/v1/...`) of the same `Trader` the verification scripts use; the server only injects the API key, ticks the Trader once a second and advances open trades.
 *  usage: npm run ui [-- <mint>]   or   PUMP_MINT=<mint> npm run ui   (without a mint it picks a recent live curve; needs ALCHEMY_API_KEY in .env and solana-test-validator), then open http://127.0.0.1:8950 . Local only: nothing here can touch real funds. */
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { WalletPolicy } from '../../core/src/index.ts';
import { SolanaChain, DevSolSigner } from '../../sol/src/index.ts';
import { startPumpValidator } from './pumpenv.ts';
import { Trader } from '../../sdk/src/trader.ts';
import { createApi } from '../../../apps/api/server.ts';

const UI_PORT = Number(process.env.UI_PORT ?? 8950), SOLN = 10n ** 9n, KEY = 'test-console-local-key-0123456789', J = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const akey = process.env.ALCHEMY_API_KEY; if (!akey) { console.error('ALCHEMY_API_KEY is not set (see .env.example).'); process.exit(2); }
  console.log('starting local validator with the pump.fun program and one live curve cloned ...');
  const wanted = (process.argv[2] ?? process.env.PUMP_MINT ?? '').trim() || undefined; if (wanted) console.log(`using the mint you gave: ${wanted}`);
  const env = await startPumpValidator(akey, 8960, wanted), T = env.mint, rpc = env.rpc, signer = new DevSolSigner();
  const airdrop = async (a: string, l: bigint) => { const sig = await rpc.call<string>('requestAirdrop', [a, Number(l)]); for (let i = 0; i < 80; i++) { const s: any = await rpc.call('getSignatureStatuses', [[sig]]); if (s.value[0]?.confirmationStatus) return; await sleep(500); } };
  const policy = (): WalletPolicy => ({ userId: 'u1', chains: ['sol-local'], allowedVenues: ['pump'], maxPerTx: { [NATIVE]: 50n * SOLN, [T]: 10n ** 21n }, dailyLimit: { [NATIVE]: 100_000n * SOLN, [T]: 10n ** 22n }, destinations: [], deviceSecret: 'dev' });
  const names = ['Wallet A', 'Wallet B', 'Wallet C', 'Market mover']; const wallets = names.map(label => ({ label, id: signer.add() })); const pols = new Map<string, WalletPolicy>();
  for (const w of wallets) { await airdrop(w.id, 40n * SOLN); pols.set(w.id, policy()); }
  const chain = new SolanaChain({ id: 'sol-local', wsol: 'So11111111111111111111111111111111111111112', pools: [], pump: { mints: [T] } }, rpc, signer);
  const dir = mkdtempSync(join(tmpdir(), 'memedesk-ui-')); await chain.refresh('venues');
  const engine = new Engine({ store: Store.open(join(dir, 'engine.json')), chain, signer: new PolicySigner(new Map([...pols.keys()].map(w => [w, 'x'])), pols), router: new Router(chain), platformFeeBps: 0 });
  const trader = new Trader({ engine, chain, userId: 'u1', venues: ['pump'], persistDir: join(dir, 'trader') });
  const api = createApi({ keys: [{ key: KEY, userId: 'u1' }], traderFor: u => (u === 'u1' ? trader : undefined) }); const apiPort = await api.listen(0);
  let busy = false; const loop = setInterval(async () => { if (busy) return; busy = true; try { await trader.tick(); for (const t of trader.trades({ limit: 30 })) if (!['finalized', 'failed', 'expired'].includes(t.state)) await trader.advance(t.key).catch(() => {}); } catch { /* shown by the trade rows */ } busy = false; }, 1000);
  const tokOf = (w: string) => rpc.call<any>('getTokenAccountsByOwner', [w, { mint: T }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).then(r => (r.value as any[]).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)).catch(() => 0n);
  const lam = async (a: string) => BigInt((await rpc.call<any>('getBalance', [a, { commitment: 'confirmed' }])).value);
  const html = readFileSync(new URL('../../../apps/testui/index.html', import.meta.url), 'utf8');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'), send = (code: number, body: unknown, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : J(body)); };
    try {
      if (url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
      if (url.pathname === '/ui/state') {
        const spot = trader.spotE18(T), ov = trader.overview();
        return send(200, { chain: 'Solana (local validator, pump.fun curve)', mint: T, nativeSymbol: 'SOL', nativeDecimals: 9, tokenDecimals: 6, priceE18: spot ?? null, entriesPaused: ov.entriesPaused,
          priceNative: spot ? Number(spot) / 1e18 * 1e6 / 1e9 : null, wallets: await Promise.all(wallets.map(async w => ({ ...w, native: await lam(w.id), token: await tokOf(w.id) }))),
          orders: trader.listOrders().slice(-40).reverse().map(o => ({ id: o.id, kind: o.kind, status: o.status, walletId: o.walletId, amount: o.amount, triggerPriceE18: o.triggerPriceE18, trailBps: (o as any).trailBps, peakE18: (o as any).peakE18, attempts: o.attempts })),
          trades: trader.trades({ limit: 25 }).map(t => ({ key: t.key, state: t.state, walletId: t.walletId, origin: t.origin, tokenIn: t.tokenIn === 'NATIVE' ? 'SOL' : 'token', amountIn: t.amountIn, received: t.fill?.received, failure: t.failure, txHash: t.txHash })) });
      }
      if (url.pathname === '/ui/move' && req.method === 'POST') {   // the market mover wallet trades the same curve, to push the price for testing orders
        const b = JSON.parse(await new Promise<string>(r => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => r(s)); })), mover = wallets[3].id;
        const t = b.dir === 'up' ? await trader.buy({ walletId: mover, token: T, amount: BigInt(Math.round(Number(b.sol) * 1e9)), slippageBps: 2000, key: `move-${Date.now()}` }) : await trader.sell({ walletId: mover, token: T, pctBps: 10000, slippageBps: 2000, key: `move-${Date.now()}` });
        return send(200, { key: t.key, state: t.state });
      }
      if (url.pathname.startsWith('/api/')) {   // same-origin proxy to the real API with the key added here, so the page never holds it
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const up = httpRequest({ host: '127.0.0.1', port: apiPort, path: url.pathname.slice(4) + url.search, method: req.method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(req.headers['idempotency-key'] ? { 'idempotency-key': String(req.headers['idempotency-key']) } : {}) } }, r => { res.writeHead(r.statusCode ?? 502, { 'content-type': 'application/json' }); r.pipe(res); });
        up.on('error', () => send(502, { error: 'api unreachable' })); up.end(Buffer.concat(chunks)); return;
      }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: env.redact((e as Error).message) }); }
  });
  await new Promise<void>(r => server.listen(UI_PORT, '127.0.0.1', r));
  console.log(`\nTest console ready: http://127.0.0.1:${UI_PORT}   (local validator, fake SOL, throwaway keys; Ctrl-C to stop)`);
  const stop = () => { clearInterval(loop); trader.stop(); env.stop(); server.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(e => { console.error(String((e as Error).message ?? e)); process.exit(1); });
