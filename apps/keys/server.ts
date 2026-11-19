/** The API key dashboard: make and revoke the keys of the execution server, for apps calling the HTTP API and for the MCP server (apps/mcp) alike.
 *  usage: API_KEYS_FILE=<the server's keys file> npm run keys      → http://127.0.0.1:3710
 *  Env: API_KEYS_FILE (required: the same file the execution server or the practice API reads; both re-read it within ~2 s), KEYS_PORT (3710),
 *       MEME_API_URL (the server those keys are for, shown in the snippets and checked for status; default http://127.0.0.1:3501), RFQ_DESK_URL (for the MCP snippet),
 *       KEYS_ADMIN_TOKEN (optional: then every call needs it; the page asks once per tab).
 *  It listens on 127.0.0.1 only, answers only for a localhost Host header and a same-origin page (no DNS rebinding, no cross-site requests), and never stores or
 *  logs a secret: a new key is shown once, in the answer to the request that made it. Docs: docs/API_KEYS.md. */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keyStore, KeyError } from './store.ts';

export interface DashboardOptions { file: string; apiUrl: string; deskUrl: string; adminToken?: string; fetch?: typeof fetch }
const PAGE = new URL('./index.html', import.meta.url), SCRIPT = new URL('./app.js', import.meta.url);
const MCP_MAIN = fileURLToPath(new URL('../mcp/main.ts', import.meta.url));
/** The node binary for the MCP snippets: Homebrew's stable link (…/bin/node) rather than a versioned Cellar path that a `brew upgrade` removes. */
const NODE = (() => { const m = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/.exec(process.execPath); return m && existsSync(m[1] + '/bin/node') ? m[1] + '/bin/node' : process.execPath; })();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const sha = (s: string) => createHash('sha256').update(s).digest();

export function createDashboard(o: DashboardOptions) {
  const store = keyStore(o.file), f = o.fetch ?? fetch, apiUrl = o.apiUrl.replace(/\/+$/, ''), deskUrl = o.deskUrl.replace(/\/+$/, '');
  const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': CSP });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });
  const readBody = (req: http.IncomingMessage) => new Promise<any>((ok, no) => { let n = 0; const ch: Buffer[] = []; req.on('data', d => { n += d.length; if (n > 16_384) { no(new KeyError('too_large', 'Request too large.', 413)); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { ok(n ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch { no(new KeyError('bad_json', 'The body is not JSON.')); } }); req.on('error', no); });
  /** What the page shows about the server the keys are for: reachable, and its chains (GET /v1/chains needs no key). */
  const status = async () => { try { const r = await f(apiUrl + '/v1/chains', { signal: AbortSignal.timeout(3000) }); if (!r.ok) return { reachable: true, http: r.status }; const j: any = await r.json(); return { reachable: true, default: j.default, chains: (j.chains ?? []).map((c: any) => ({ id: c.id, label: c.label, kind: c.kind })) }; } catch { return { reachable: false }; } };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x'), port = (server.address() as any)?.port;
      const host = String(req.headers.host ?? ''), local = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`);
      if (!local.test(host)) return err(res, 421, 'bad_host', 'This dashboard answers only on 127.0.0.1 / localhost.');
      if (req.method === 'GET' && u.pathname === '/') return send(res, 200, readFileSync(PAGE), 'text/html; charset=utf-8');
      if (req.method === 'GET' && u.pathname === '/app.js') return send(res, 200, readFileSync(SCRIPT), 'text/javascript; charset=utf-8');
      if (!u.pathname.startsWith('/api/')) return err(res, 404, 'not_found', 'Not found.');
      // the API: same-origin page only, JSON bodies only (a cross-site form or a rebinding page cannot call it), and the admin token when one is set
      const origin = req.headers.origin; if (origin !== undefined && !local.test(String(origin).replace(/^https?:\/\//, ''))) return err(res, 403, 'bad_origin', 'Cross-origin requests are refused.');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return err(res, 403, 'bad_origin', 'Cross-site requests are refused.');
      if (o.adminToken) { const t = String(req.headers['x-admin-token'] ?? ''); if (!timingSafeEqual(sha(t), sha(o.adminToken))) return err(res, 401, 'admin_token', 'This dashboard needs its admin token (KEYS_ADMIN_TOKEN).'); }
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json'))   // a cross-site form can POST, never DELETE; a DELETE from another site needs a preflight this server never grants
        return err(res, 415, 'json_only', 'Send application/json.');
      if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) return err(res, 405, 'method', 'Not allowed.');
      if (req.method === 'GET' && u.pathname === '/api/info') return send(res, 200, { file: o.file, apiUrl, deskUrl, mcpMain: MCP_MAIN, node: NODE, adminToken: !!o.adminToken, server: await status() });
      if (req.method === 'GET' && u.pathname === '/api/keys') return send(res, 200, { keys: store.list() });
      if (req.method === 'POST' && u.pathname === '/api/keys') { const b = await readBody(req); return send(res, 201, await store.create({ userId: b.userId, scope: b.scope, label: b.label })); }
      const m = /^\/api\/keys\/([0-9a-fA-F]{64})$/.exec(u.pathname);
      if (req.method === 'DELETE' && m) return send(res, 200, await store.revoke(m[1]));
      return err(res, 404, 'not_found', 'Not found.');
    } catch (e) {
      if (e instanceof KeyError) return err(res, e.status, e.code, e.message);
      console.error('[keys] error:', (e as Error).message); return err(res, 500, 'internal', 'The dashboard could not do that; see its log.');
    }
  });
  return { server, store, listen: (port = 0) => new Promise<number>(ok => server.listen(port, '127.0.0.1', () => ok((server.address() as any).port))), close: () => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections?.(); }) };
}

if (import.meta.main) {
  const e = process.env, file = e.API_KEYS_FILE;
  if (!file) { console.error('API_KEYS_FILE is not set: point it at the keys file of the execution server (or practice API) these keys are for.'); process.exit(2); }
  const d = createDashboard({ file, apiUrl: e.MEME_API_URL ?? 'http://127.0.0.1:3501', deskUrl: e.RFQ_DESK_URL ?? 'http://127.0.0.1:3700', adminToken: e.KEYS_ADMIN_TOKEN || undefined });
  const port = await d.listen(Number(e.KEYS_PORT ?? 3710));
  console.log(`API key dashboard on http://127.0.0.1:${port}  (keys file ${file}, ${d.store.list().length} key(s); for ${e.MEME_API_URL ?? 'http://127.0.0.1:3501'}${e.KEYS_ADMIN_TOKEN ? '; admin token required' : ''}; secrets are never stored or printed)`);
}
