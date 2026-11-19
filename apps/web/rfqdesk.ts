/** The RFQ desk (apps/rfq, its own server) inside the trading app: a READ-ONLY pass-through from the page server to the desk at RFQ_DESK_URL (default http://127.0.0.1:3700).
 *  Only the desk's quote and price routes are reachable here, the same set the MCP server allows (apps/mcp/tools.ts DESK_ALLOWED). /api/execute, /api/gate, /api/status and the
 *  desk's RPC relay are never forwarded: nothing here can sign or send. The desk itself is not changed. A quote's streamed stages (NDJSON) come back as one list. */

export type Deps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv };
class DeskError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
const base = (env: NodeJS.ProcessEnv) => (env.RFQ_DESK_URL?.trim() || 'http://127.0.0.1:3700').replace(/\/+$/, '');
async function call(d: Deps, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000) {
  const env = d.env ?? process.env; let r: Response;
  try { r = await (d.fetch ?? fetch)(base(env) + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new DeskError('The RFQ desk is not running (start it with npm run rfq, or set RFQ_DESK_URL).', 503); }
  if (!r.ok) { const j: any = await r.json().catch(() => ({})); throw new DeskError(String(j?.error ?? j?.why ?? `The RFQ desk answered HTTP ${r.status}.`), r.status >= 500 ? 502 : 400); }
  return r;
}
const pick = (b: any, keys: string[]) => Object.fromEntries(keys.filter(k => b?.[k] !== undefined).map(k => [k, b[k]]));

/** The desk's stock lists (Solana stocks with mint and liquidity, EVM symbols per chain) and its limits. No Privy or wallet details. */
export async function deskConfig(_b: any, d: Deps = {}) {
  const j: any = await (await call(d, 'GET', '/api/config')).json();
  return { maxUsd: j.maxUsd ?? null, solUsd: j.solUsd ?? null, stocks: Array.isArray(j.stocks) ? j.stocks.map((s: any) => pick(s, ['symbol', 'mint', 'issuer', 'underlying', 'liquidityUsd', 'decimals'])) : [],
    evm: Object.fromEntries(Object.entries(j.evmStocks ?? {}).map(([c, v]: [string, any]) => [c, { label: v?.label ?? c, native: v?.native ?? '', symbols: Array.isArray(v?.symbols) ? v.symbols : [] }])) };
}

/** A Solana RFQ comparison (JupiterZ market maker against the routers): every stage the desk streams, collected. The 'trade' stage's transaction is dropped: this tab never signs. */
export async function deskQuote(b: any, d: Deps = {}) {
  const body = pick(b, ['mint', 'side', 'pay', 'amount', 'minUsd', 'marginBps']);
  if (typeof body.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.mint)) throw new DeskError('Pick a stock first.');
  if (!/^\d{1,30}$/.test(String(body.amount ?? ''))) throw new DeskError('Set an amount.');
  const r = await call(d, 'POST', '/api/quote', body, 120_000);
  const text = await r.text(), stages: any[] = [];
  for (const line of text.split('\n')) { const s = line.trim(); if (!s) continue; try { const x = JSON.parse(s); if (x?.stage === 'trade') delete x.transaction; stages.push(x); } catch { /* a partial line is skipped */ } }
  return { stages };
}

/** EVM venue comparison for a stock token on Base, Robinhood Chain or BNB Chain (Relay, KyberSwap, LI.FI, OpenOcean, Bebop, 0x, UniswapX). */
export async function deskEvmQuote(b: any, d: Deps = {}) {
  const body = pick(b, ['chain', 'symbol', 'side', 'amount']);
  if (!['base', 'robinhood', 'bnb'].includes(String(body.chain))) throw new DeskError('Pick Base, Robinhood Chain or BNB Chain.');
  if (!(Number(body.amount) > 0)) throw new DeskError('Set an amount.');
  return (await call(d, 'POST', '/api/evm/quote', body, 60_000)).json();
}

/** The whole desk (every tab and option, its own UI) inside the trading app, READ-ONLY, without changing the desk: its page is served at /rfqdesk with its API calls pointed at
 *  /rfqdesk/api/ and the wallet button hidden, and only these desk routes are forwarded. /api/execute (the only one that sends), /api/status and the desk's RPC relay are refused. */
export const DESK_READ_ONLY: Record<string, 'GET' | 'POST'> = { '/api/config': 'GET', '/api/liquidity': 'GET', '/api/evm/price': 'GET', '/api/token-price': 'GET',
  '/api/quote': 'POST', '/api/ladder': 'POST', '/api/gate': 'POST', '/api/evm/quote': 'POST', '/api/base/quote': 'POST' };
const READ_ONLY_STYLE = `<style id="mint-readonly">#connect,#wallet-pop{display:none!important}</style>`;
/** The desk's page, made read-only for the app: API paths rewritten to /rfqdesk/api/, the wallet button hidden, the trade route pointed at a path that is refused. */
export async function deskPage(d: Deps = {}) {
  const r = await call(d, 'GET', '/', undefined, 10_000); let html = await r.text();
  html = html.replace(/fetch\((['`])\/api\//g, 'fetch($1/rfqdesk/api/');
  html = html.includes('</head>') ? html.replace('</head>', READ_ONLY_STYLE + '</head>') : READ_ONLY_STYLE + html;
  return html;
}
/** Forward one read-only desk call; anything else is refused. The response body is passed through as is (a quote streams NDJSON). */
export async function deskApi(method: string, path: string, query: string, body: Buffer | undefined, d: Deps = {}): Promise<{ status: number; type: string; body: ReadableStream<Uint8Array> | string }> {
  const allowed = DESK_READ_ONLY[path];
  if (!allowed) return { status: 403, type: 'application/json', body: JSON.stringify({ error: 'This view of the RFQ desk is read-only: it compares quotes and never signs or sends.' }) };
  if (method !== allowed) return { status: 405, type: 'application/json', body: JSON.stringify({ error: `Use ${allowed}.` }) };
  const env = d.env ?? process.env; let r: Response;
  try { r = await (d.fetch ?? fetch)(base(env) + path + query, { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(120_000) }); }
  catch { return { status: 503, type: 'application/json', body: JSON.stringify({ error: 'The RFQ desk is not running (start it with npm run rfq, or set RFQ_DESK_URL).' }) }; }
  return { status: r.status, type: r.headers.get('content-type') ?? 'application/json', body: r.body ?? '' };
}

/** One size-ladder rung: for `usd` worth, the JupiterZ price and the routers' price. */
export async function deskLadder(b: any, d: Deps = {}) { return (await call(d, 'POST', '/api/ladder', pick(b, ['mint', 'side', 'pay', 'usd']), 60_000)).json(); }
