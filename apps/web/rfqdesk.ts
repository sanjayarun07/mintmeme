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

/** One size-ladder rung: for `usd` worth, the JupiterZ price and the routers' price. */
export async function deskLadder(b: any, d: Deps = {}) { return (await call(d, 'POST', '/api/ladder', pick(b, ['mint', 'side', 'pay', 'usd']), 60_000)).json(); }
