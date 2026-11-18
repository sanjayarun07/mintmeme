/** The Solana test UI: the /solana page and its /api/sol/* routes, on mainnet with real funds. Single user, this machine only.
 *  usage: npm run web   (needs ALCHEMY_API_KEY in .env; PRIVY_APP_ID optional, for Privy sign-in; build the Privy bundle with npm run build:privy)
 *  Safety: listens on 127.0.0.1 only. Every POST to /api/sol/* must be JSON, with a localhost Host and (when present) an Origin of that same host, so a web page you
 *  visit cannot drive the connected wallet. The wallet session is an HttpOnly cookie; it is never read from the request body. The RPC relay only forwards read-only
 *  methods and keeps the RPC key on the server. Trades are prepared and simulated first and need an explicit confirmation; limits and the kill switch live in solmainnet.ts. */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { realError } from './realerror.ts';
import type { SolMainnet } from './solmainnet.ts';

const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
/** State folder of the wallet session (default .state/sol-mainnet). Tests pass a temporary folder so they can never touch the real kill switch, limits or keys. */
let stateDir: string | undefined;
let solMainInst: SolMainnet | undefined; const solMain = async () => solMainInst ??= new (await import('./solmainnet.ts')).SolMainnet(stateDir);
const routes = () => import('./solroutes.ts');

export const SOL_ROUTES: Record<string, (body: any) => Promise<any>> = {
  '/api/sol/config': async () => ({ privyAppId: process.env.PRIVY_APP_ID || null, /* public ids, for adding the server signer on Base (MODE=base-mainnet); never the secret or the key */ privySignerId: process.env.PRIVY_AUTH_KEY_ID || null, privyBasePolicyId: process.env.PRIVY_BASE_POLICY_ID || null, privyBundle: existsSync(new URL('./privy.bundle.js', import.meta.url)) }),
  '/api/sol/search': async b => (await routes()).solSearch(b), '/api/sol/token': async b => (await routes()).solToken(b), '/api/sol/simulate': async b => (await routes()).solSimulate(b),
  '/api/sol/auth/nonce': async b => (await solMain()).authNonce(b), '/api/sol/auth/verify': async b => (await solMain()).authVerify(b),
  '/api/sol/sign/pending': async b => (await solMain()).pendingSigns(b), '/api/sol/sign/submit': async b => (await solMain()).submitSign(b), '/api/sol/sign/reject': async b => (await solMain()).rejectSign(b),
  '/api/sol/wallet/status': async b => (await solMain()).status(b), '/api/sol/wallet/disconnect': async b => (await solMain()).disconnect(b),
  '/api/sol/settings': async b => { const m = await solMain(); return b && b.maxTradeSol !== undefined ? m.setLimits(b) : m.status(); },
  '/api/sol/kill': async b => (await solMain()).killSwitch(b?.on !== false, b),
  '/api/sol/trade/prepare': async b => (await solMain()).prepare(b), '/api/sol/trade/confirm': async b => (await solMain()).confirm(b),
  '/api/sol/holdings': async b => (await solMain()).holdings(b), '/api/sol/history': async b => (await solMain()).history(b),
  '/api/sol/orders/context': async b => (await solMain()).orderContext(b), '/api/sol/orders/list': async b => (await solMain()).listOrders(b),
  '/api/sol/orders/create': async b => (await solMain()).createOrder(b), '/api/sol/orders/cancel': async b => (await solMain()).cancelOrder(b), '/api/sol/orders/edit': async b => (await solMain()).editOrder(b),
  '/api/sol/privy/use': async b => (await solMain()).privyUse(b),
  '/api/sol/tradingkey/create': async b => (await solMain()).tradingKeyCreate(b),
  '/api/sol/tradingkey/use': async () => (await solMain()).tradingKeyUse(), '/api/sol/tradingkey/fund': async b => (await solMain()).fundTradingKey(b),
  '/api/sol/tradingkey/return': async b => (await solMain()).tradingKeyReturn(b), '/api/sol/tradingkey/funders': async () => ({ funders: await (await solMain()).keyFunders() }),
};
/** The only routes a plain GET may call: they read and change nothing, so a cross-site link or image cannot do harm with them. Everything that acts is POST-only behind the origin check. */
const READ_ONLY_GET = new Set(['/api/sol/config', '/api/sol/wallet/status']);
/** The page and the files it loads (see solana.html). */
const STATIC: Record<string, string> = { '/styles.css': 'text/css', '/solana.css': 'text/css', '/solcore.js': 'text/javascript', '/views3.js': 'text/javascript', '/views4.js': 'text/javascript',
  '/solpro.js': 'text/javascript', '/solboot.js': 'text/javascript', '/privy.bundle.js': 'text/javascript' };
/** Read-only JSON-RPC methods the Privy approval screen needs (fees, balances, simulation). Sending is not allowed. */
const RPC_OK = new Set(['getLatestBlockhash', 'getBalance', 'getFeeForMessage', 'simulateTransaction', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getTokenAccountBalance', 'getSlot',
  'getBlockHeight', 'isBlockhashValid', 'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'getVersion', 'getEpochInfo']);

export function createSolServer(o: { stateDir?: string } = {}) {
  if (o.stateDir) { if (solMainInst) throw new Error('createSolServer: the wallet session already started with another state folder'); stateDir = o.stateDir; }
  // any error that escapes a request becomes a 500 for that request; it must never stop the server (standing orders are watched by this process)
  return http.createServer((req, res) => { handle(req, res).catch(e => { console.error('[solana] request failed:', (e as Error)?.message); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(ser(realError(500, 'internal error'))); } else res.end(); }); });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://localhost');
    let setCookie: string | undefined;
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache', ...(setCookie ? { 'set-cookie': setCookie } : {}) }); res.end(body); };
    if (u.pathname === '/' ) { res.writeHead(302, { location: '/solana' }); return res.end(); }
    if (u.pathname === '/solana' || u.pathname === '/solana.html') return send(200, readFileSync(new URL('./solana.html', import.meta.url), 'utf8'), 'text/html');
    if (STATIC[u.pathname]) { const f = new URL('.' + u.pathname, import.meta.url); if (!existsSync(f)) return send(404, '{}'); return send(200, readFileSync(f, 'utf8'), STATIC[u.pathname]); }
    if (!u.pathname.startsWith('/api/sol/')) return send(404, ser({ ok: false, title: 'Not found', why: `No page ${u.pathname}.`, fix: 'Open /solana.' }));
    // Host first, for every /api/sol route: a DNS-rebinding page arrives with its own host name and must not even read the wallet status
    const host = req.headers.host, origin = req.headers.origin;
    const refuse = () => send(403, ser({ ok: false, title: 'Refused', why: 'Wallet and trade calls only accept JSON posts from this page.', fix: 'Use the page at the address shown when the server started.' }));
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host ?? '')) return refuse();
    const session = /(?:^|;\s*)mint_sol=([A-Za-z0-9_-]{20,80})/.exec(String(req.headers.cookie ?? ''))?.[1];   // the session comes ONLY from the HttpOnly cookie
    if (req.method === 'GET' && READ_ONLY_GET.has(u.pathname)) { try { return send(200, ser(await SOL_ROUTES[u.pathname]({ __session: session }))); } catch (e) { return send((e as any).status ?? 500, ser(realError((e as any).status ?? 500, (e as Error).message))); } }
    if (req.method !== 'POST') return send(405, ser({ ok: false, title: 'Not allowed', why: 'Use POST with a JSON body.', fix: '' }));
    // an Origin, when sent, must be exactly this page ("null" from a sandboxed frame, or anything unparsable, is refused, never thrown)
    if ((origin !== undefined && origin !== `http://${host}`) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse();
    let body: any = {}; { const chunks: Buffer[] = []; let n = 0; for await (const c of req) { n += (c as Buffer).length; if (n > 256 * 1024) return send(413, '{}'); chunks.push(c as Buffer); } try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, '{}'); } }
    if (u.pathname === '/api/sol/rpc') {
      const key = process.env.ALCHEMY_API_KEY; if (!key) return send(503, ser({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32000, message: 'no RPC configured' } }));
      const one = (b: any) => b && typeof b.method === 'string' && RPC_OK.has(b.method);
      if (Array.isArray(body) ? !body.every(one) : !one(body)) return send(403, ser({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed by this relay' } }));
      try { const r = await fetch((await import('../../packages/live/src/config.ts')).urls(key).sol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); return send(r.status, await r.text()); }
      catch { return send(502, ser({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32000, message: 'RPC unreachable' } })); }
    }
    body = { ...body, __session: session };
    const route = SOL_ROUTES[u.pathname]; if (!route) return send(404, ser({ ok: false, title: 'Not found', why: `No route ${u.pathname}.`, fix: '' }));
    try {
      const r = await route(body);
      if (r && (r as any).__setSession !== undefined) { const t = (r as any).__setSession; delete (r as any).__setSession; setCookie = t ? `mint_sol=${t}; HttpOnly; SameSite=Strict; Path=/api/sol; Max-Age=86400` : 'mint_sol=; HttpOnly; SameSite=Strict; Path=/api/sol; Max-Age=0'; }
      return send(200, ser(r));
    } catch (e) { return send((e as any).status ?? 500, ser(realError((e as any).status ?? 500, (e as Error).message))); }
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  createSolServer().listen(port, '127.0.0.1', () => console.log(`Solana test UI on http://localhost:${port}/solana (mainnet, real funds; this machine only, single user)`));
  // automatic trading that was on before this restart resumes once Privy confirms the wallet still allows it
  void solMain().then(m => m.resumeAutomatic()).then(r => { if (r !== 'none') console.log(`automatic trading after restart: ${r}`); }, e => console.error('[solana] resume failed:', (e as Error).message));
}
