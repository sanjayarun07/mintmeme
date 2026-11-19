/** The Meme MCP server's tools, without the MCP SDK: their JSON Schemas, argument checks, the real-funds gate, secret redaction and the HTTP calls.
 *  main.ts wires these to the SDK over stdio; tests drive `callTool` with a fake `fetch`.
 *
 *  Two backends:
 *  - the execution server (apps/server): every trading tool takes `chain` and calls /v1/<chain>/... (practice: MEME_PRACTICE_URL, unprefixed, when set);
 *  - the RFQ desk (apps/rfq): read-only. The desk's /api/execute (needs a wallet in the browser) and its RPC relay are never called.
 *
 *  Safety: tools that spend real funds (buy, sell, orders, TWAP, bulk) need `confirm: true`, and on every chain but practice also MCP_ALLOW_TRADES=1 in the
 *  server's environment. Every answer and error passes `redact`, which removes the values of secret-looking environment variables, bearer tokens and api-key query values. */

export type Json = any;
export interface Env { [k: string]: string | undefined }
export interface Config {
  apiUrl: string; apiKey?: string; userId?: string; practiceUrl?: string; practiceKey?: string; deskUrl: string;
  allowTrades: boolean; timeoutMs: number; deskTimeoutMs: number;
}
export interface Ctx { cfg: Config; fetch: typeof fetch; secrets: string[]; now?: () => number }
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }
interface Tool { name: string; title: string; description: string; inputSchema: Json; readOnly: boolean; spends?: boolean; run: (a: Json, c: Ctx) => Promise<unknown> }

export const CHAINS = ['solana', 'base', 'robinhood', 'bnb', 'practice'] as const;
/** The plain-units field a trade takes for the chain's native coin (GET /v1/chains `amountKey`); practice takes raw `amount`. */
export const AMOUNT_KEY: Record<string, string | null> = { solana: 'sol', base: 'eth', robinhood: 'eth', bnb: 'bnb', practice: null };
export const DESK_EVM_CHAINS = ['base', 'bnb', 'robinhood'] as const;
const MAX_TEXT = 60_000;

export function configFromEnv(e: Env): Config {
  return {
    apiUrl: (e.MEME_API_URL ?? 'http://127.0.0.1:3501').replace(/\/+$/, ''), apiKey: e.MEME_API_KEY || undefined, userId: e.MEME_USER_ID || undefined,
    practiceUrl: e.MEME_PRACTICE_URL ? e.MEME_PRACTICE_URL.replace(/\/+$/, '') : undefined, practiceKey: e.MEME_PRACTICE_API_KEY || undefined,
    deskUrl: (e.RFQ_DESK_URL ?? 'http://127.0.0.1:3700').replace(/\/+$/, ''),
    allowTrades: e.MCP_ALLOW_TRADES === '1', timeoutMs: Number(e.MCP_TIMEOUT_MS ?? 30_000), deskTimeoutMs: Number(e.MCP_DESK_TIMEOUT_MS ?? 180_000),
  };
}

/* ---------------- secrets ---------------- */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH/i;
/** The values to scrub from every answer: each secret-looking env var (8+ characters), longest first so a value inside another is not half-replaced. */
export function secretsFromEnv(e: Env): string[] {
  const v = Object.entries(e).filter(([k, x]) => SECRET_NAME.test(k) && !/_ID$/.test(k) && typeof x === 'string' && x.length >= 8).map(([, x]) => x as string);
  return [...new Set(v)].sort((a, b) => b.length - a.length);
}
export function redact(text: string, secrets: string[]): string {
  let t = text; for (const s of secrets) t = t.split(s).join('[redacted]');
  return t.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/([?&](?:api[-_]?key|apikey|key|token|access_token|secret)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^\s"'/]*(?:alchemy|infura|quiknode|ankr)[^\s"'/]*\/(?:v\d\/)?)[A-Za-z0-9_-]{24,}/gi, '$1[redacted]');   // RPC URLs with the key in the path
}

/* ---------------- argument checks (the subset of JSON Schema the tools use) ---------------- */
export class ToolError extends Error { constructor(public code: string, message: string, public fix?: string) { super(message); } }
export function validate(schema: Json, value: Json, at = 'arguments'): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at} must be an object`];
    for (const r of schema.required ?? []) if (value[r] === undefined) errs.push(`${at}.${r} is required`);
    for (const [k, v] of Object.entries(value)) {
      const p = schema.properties?.[k];
      if (!p) { if (schema.additionalProperties === false) errs.push(`${at}.${k} is not an argument of this tool`); continue; }
      if (v !== undefined) errs.push(...validate(p, v, `${at}.${k}`));
    }
    return errs;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return [`${at} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at} takes at most ${schema.maxItems} items`);
    value.forEach((x, i) => errs.push(...validate(schema.items ?? {}, x, `${at}[${i}]`)));
    return errs;
  }
  if (t === 'string' && typeof value !== 'string') return [`${at} must be a string`];
  if ((t === 'number' || t === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) return [`${at} must be a number`];
  if (t === 'integer' && !Number.isInteger(value)) return [`${at} must be a whole number`];
  if (t === 'boolean' && typeof value !== 'boolean') return [`${at} must be true or false`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at} is not valid${schema.description ? ` (${schema.description})` : ''}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at} is longer than ${schema.maxLength} characters`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at} is shorter than ${schema.minLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at} must be at most ${schema.maximum}`);
  }
  return errs;
}

/* ---------------- schema helpers ---------------- */
const DEC = '^[0-9]+(\\.[0-9]+)?$', RAW = '^[0-9]+$', ID = '^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$';
const str = (description: string, extra: Json = {}) => ({ type: 'string', description, maxLength: 256, ...extra });
const num = (description: string, extra: Json = {}) => ({ type: 'number', description, ...extra });
const int = (description: string, extra: Json = {}) => ({ type: 'integer', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const chainArg = { type: 'string', enum: [...CHAINS], description: 'The chain: solana, base, robinhood or bnb (real funds), or practice (simulated, fake funds). Calls go to /v1/<chain>/...' };
const tokenArg = str('Token: a Solana mint, a 0x token address on an EVM chain, or a stock ticker such as TSLAx (Solana). Practice: 0xMEME.', { pattern: '^[A-Za-z0-9._-]{1,64}$' });
const confirmArg = { type: 'boolean', description: 'Must be true, and only after the user has explicitly approved this exact trade in the conversation.' };
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SPEND = 'SPENDS REAL FUNDS on solana, base, robinhood and bnb (practice uses fake funds). Needs confirm: true after the user approved this exact trade, and on real chains the operator flag MCP_ALLOW_TRADES=1. ';

/* ---------------- HTTP ---------------- */
const enc = encodeURIComponent;
const qs = (q: Record<string, unknown>) => { const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join('&'); return p ? '?' + p : ''; };

/** The URL of an execution-server path (`/v1/...`) on `chain`, and the key for it. Practice goes to MEME_PRACTICE_URL (a practice server has no chain prefix) when set. */
export function routeFor(cfg: Config, chain: string, path: string): { url: string; key?: string } {
  if (!(CHAINS as readonly string[]).includes(chain)) throw new ToolError('bad_chain', `unknown chain ${chain}: one of ${CHAINS.join(', ')}`);
  if (!path.startsWith('/v1/')) throw new Error('internal: path must start with /v1/');
  if (chain === 'practice' && cfg.practiceUrl) return { url: cfg.practiceUrl + path, key: cfg.practiceKey ?? cfg.apiKey };
  return { url: `${cfg.apiUrl}/v1/${chain}/${path.slice(4)}`, key: cfg.apiKey };
}

async function http(c: Ctx, method: string, url: string, o: { key?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; raw?: boolean } = {}): Promise<Json> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), o.timeoutMs ?? c.cfg.timeoutMs);
  let r: Response;
  try {
    r = await c.fetch(url, { method, signal: ctl.signal, headers: { accept: 'application/json', ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), ...(c.cfg.userId && o.key ? { 'x-user-id': c.cfg.userId } : {}), ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  } catch (e) { clearTimeout(t); throw new ToolError('network', `could not reach ${new URL(url).origin}: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`, 'Check that the server is running and the URL env var (MEME_API_URL, MEME_PRACTICE_URL or RFQ_DESK_URL).'); }
  try {
    if (o.raw) { if (!r.ok) throw new ToolError('http_' + r.status, `HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`); return await r.text(); }
    const text = await r.text(); let j: Json; try { j = text ? JSON.parse(text) : {}; } catch { j = { text: text.slice(0, 2000) }; }
    if (!r.ok) { const e = j?.error; throw new ToolError(e?.code ?? 'http_' + r.status, typeof e === 'string' ? e : e?.message ?? `request failed with HTTP ${r.status}`, e?.fix ?? (r.status === 401 ? 'Set MEME_API_KEY (or MEME_PRACTICE_API_KEY) in the MCP server\'s environment.' : undefined)); }
    return j;
  } finally { clearTimeout(t); }
}

function needKey(k?: string) { if (!k) throw new ToolError('no_api_key', 'no API key is configured for the execution server', 'Set MEME_API_KEY in the MCP server\'s environment (and MEME_PRACTICE_API_KEY for a separate practice server).'); return k; }
const api = (c: Ctx, method: string, chain: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number) => { const r = routeFor(c.cfg, chain, path); return http(c, method, r.url, { key: needKey(r.key), body, headers, timeoutMs }); };

/** Desk paths the MCP server may call. Anything else (notably /api/execute and the /api/sol/rpc relay) is refused before a request is made. */
export const DESK_ALLOWED = new Set(['GET /api/config', 'POST /api/quote', 'POST /api/ladder', 'POST /api/gate', 'POST /api/evm/quote', 'GET /api/liquidity', 'GET /api/evm/price', 'GET /api/token-price']);
const desk = (c: Ctx, method: string, path: string, body?: unknown, raw = false) => {
  if (!DESK_ALLOWED.has(`${method} ${path.split('?')[0]}`)) throw new ToolError('desk_path_refused', `the MCP server does not call ${method} ${path.split('?')[0]} on the desk (read-only)`);
  return http(c, method, c.cfg.deskUrl + path, { body, raw, timeoutMs: c.cfg.deskTimeoutMs });
};

/* ---------------- the real-funds gate ---------------- */
/** Refuses a spending call unless `confirm` is true and, off practice, MCP_ALLOW_TRADES=1. Returns nothing when the call may go ahead. */
export function tradeGate(cfg: Config, tool: string, a: Json) {
  if (a.confirm !== true) throw new ToolError('confirm_required', `${tool} spends ${a.chain === 'practice' ? 'fake (practice) funds' : 'REAL funds'} and was not sent: it needs confirm: true`, 'Show the user the exact trade (chain, token, side, amount, slippage) and call again with confirm: true only after they approve it.');
  if (a.chain !== 'practice' && !cfg.allowTrades) throw new ToolError('trades_disabled', `${tool} on ${a.chain} would spend real funds, and real-funds trading is turned off in this MCP server`, 'The operator can enable it by starting the MCP server with MCP_ALLOW_TRADES=1. Read-only tools and the practice chain work without it.');
}

/** The native-coin amount on a real chain goes in its plain-units field (sol, eth, bnb); practice takes raw `amount`. */
function nativeAmount(chain: string, a: Json, b: Json) {
  if (a.amount === undefined) return;
  const k = AMOUNT_KEY[chain]; if (k) b[k] = a.amount; else b.amount = a.amount;
}
const pick = (a: Json, keys: string[]) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
const idemKey = (a: Json, c: Ctx, tool: string) => a.key ?? `mcp-${tool}-${(c.now ?? Date.now)()}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------------- NDJSON quote from the desk ---------------- */
/** The desk's /api/quote stages, minus base64 transactions (an AI client cannot sign them, and they are large). */
export function parseNdjson(text: string): Json[] {
  return text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return { stage: 'unparsed', line: l.slice(0, 500) }; } }).map(s => { if (s && typeof s === 'object' && 'transaction' in s) { const { transaction, ...rest } = s; return { ...rest, transaction: transaction ? '(omitted: sign it in the desk page)' : undefined }; } return s; });
}

/* ---------------- the tools ---------------- */
const TOOLS: Tool[] = [];
const ro = (name: string, title: string, description: string, props: Json, req: string[], run: Tool['run']) => TOOLS.push({ name, title, description, inputSchema: obj(props, req), readOnly: true, run });
const spend = (name: string, title: string, description: string, props: Json, req: string[], run: Tool['run']) => TOOLS.push({ name, title, description: SPEND + description, inputSchema: obj({ ...props, confirm: confirmArg }, [...req, 'confirm']), readOnly: false, spends: true, run: (a, c) => { tradeGate(c.cfg, name, a); return run(a, c); } });

// ── execution server: reads ──
ro('meme_chains', 'List chains', 'The chains the execution server runs (GET /v1/chains): id, kind (practice, solana, evm), native coin, amountKey (the plain-units field for trades: sol, eth, bnb), EIP-155 chainId, default. No key needed. Also says whether real-funds trading is enabled in this MCP server.', {}, [],
  async (_a, c) => ({ ...(await http(c, 'GET', c.cfg.apiUrl + '/v1/chains')), mcp: { realTradesEnabled: c.cfg.allowTrades, practiceUrl: c.cfg.practiceUrl ? 'set' : 'not set (practice goes to /v1/practice/ on MEME_API_URL)' } }));
ro('meme_overview', 'Account overview', 'Account state on one chain (GET /v1/<chain>/overview): block, active orders, running bulk and TWAP jobs.', { chain: chainArg }, ['chain'], (a, c) => api(c, 'GET', a.chain, '/v1/overview'));
ro('meme_positions', 'Positions', 'Open positions on one chain with balance, cost basis and realized P&L (GET /v1/<chain>/positions). An unknown cost basis stays null.', { chain: chainArg }, ['chain'], (a, c) => api(c, 'GET', a.chain, '/v1/positions'));
ro('meme_quote', 'Quote (nothing sent)', 'Best venue price for a market trade, nothing is sent (POST /v1/<chain>/quote): output, guaranteed minimum, price impact, fees, alternatives. `amount` is in raw base units (lamports, wei, or the token\'s smallest unit for a sell).',
  { chain: chainArg, side: { type: 'string', enum: ['buy', 'sell'] }, token: tokenArg, amount: str('Raw base units, digits only: the native coin for a buy (1 SOL = 1000000000 lamports, 1 ETH = 1e18 wei), the token for a sell.', { pattern: RAW }), slippageBps: int('Slippage in basis points (100 = 1%).', { minimum: 1, maximum: 5000 }) },
  ['chain', 'side', 'token', 'amount'], (a, c) => api(c, 'POST', a.chain, '/v1/quote', pick(a, ['side', 'token', 'amount', 'slippageBps'])));
ro('meme_wallet', 'Wallet status', 'The wallet linked on this chain (GET /v1/<chain>/wallet): address, and whether the server may trade it now and why not. Each chain links its own wallet.', { chain: chainArg }, ['chain'], (a, c) => api(c, 'GET', a.chain, '/v1/wallet'));
ro('meme_trades', 'Trade list', 'Your trades on one chain, newest first (GET /v1/<chain>/trades).', { chain: chainArg, limit: int('At most this many.', { minimum: 1, maximum: 200 }), origin: str('Only trades from this origin (manual, order, twap, bulk, copy...).', { pattern: '^[a-z-]{1,24}$' }), walletId: str('Practice: w1 or w2.', { pattern: ID }) }, ['chain'],
  (a, c) => api(c, 'GET', a.chain, '/v1/trades' + qs(pick(a, ['limit', 'origin', 'walletId']))));
ro('meme_trade', 'One trade', 'One trade by key (GET /v1/<chain>/trades/:key): state, fill, tx hash, failure, state history.', { chain: chainArg, key: str('The trade key.', { pattern: ID }) }, ['chain', 'key'], (a, c) => api(c, 'GET', a.chain, `/v1/trades/${enc(a.key)}`));
ro('meme_history', 'Trade history', 'Confirmed trade history on one chain (GET /v1/<chain>/history), optionally for one token.', { chain: chainArg, token: tokenArg }, ['chain'], (a, c) => api(c, 'GET', a.chain, '/v1/history' + qs({ token: a.token })));
ro('meme_orders', 'Order list', 'Standing orders on one chain (GET /v1/<chain>/orders).', { chain: chainArg, status: { type: 'string', enum: ['active', 'filled', 'cancelled', 'expired', 'failed', 'disabled'] }, token: tokenArg }, ['chain'], (a, c) => api(c, 'GET', a.chain, '/v1/orders' + qs(pick(a, ['status', 'token']))));
ro('meme_order', 'One order', 'One standing order (GET /v1/<chain>/orders/:id), with why it has not fired yet.', { chain: chainArg, id: str('The order id.', { pattern: ID }) }, ['chain', 'id'], (a, c) => api(c, 'GET', a.chain, `/v1/orders/${enc(a.id)}`));
ro('meme_twap_status', 'TWAP status', 'Slice-by-slice status of a TWAP (GET /v1/<chain>/twap/:id).', { chain: chainArg, id: str('The TWAP id.', { pattern: ID }) }, ['chain', 'id'], (a, c) => api(c, 'GET', a.chain, `/v1/twap/${enc(a.id)}`));
ro('meme_bulk_status', 'Bulk status', 'Per-wallet status of a bulk order (GET /v1/<chain>/bulk/:id).', { chain: chainArg, id: str('The bulk id.', { pattern: ID }) }, ['chain', 'id'], (a, c) => api(c, 'GET', a.chain, `/v1/bulk/${enc(a.id)}`));
ro('meme_events', 'Recent events', 'Listens to the account\'s event stream on one chain (GET /v1/<chain>/events) for a few seconds and returns what arrived: trade, order, bulk, twap, snipe, alert and error events.',
  { chain: chainArg, seconds: int('How long to listen, 1 to 30 (default 5).', { minimum: 1, maximum: 30 }), max: int('Stop after this many events (default 50).', { minimum: 1, maximum: 500 }) }, ['chain'],
  async (a, c) => {
    const r = routeFor(c.cfg, a.chain, '/v1/events'), key = needKey(r.key), ctl = new AbortController(), ms = (a.seconds ?? 5) * 1000, max = a.max ?? 50, events: Json[] = [];
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await c.fetch(r.url, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream', ...(c.cfg.userId ? { 'x-user-id': c.cfg.userId } : {}) }, signal: ctl.signal });
      if (!res.ok || !res.body) { const j: Json = await res.json().catch(() => ({})); throw new ToolError(j?.error?.code ?? 'http_' + res.status, j?.error?.message ?? `event stream refused (HTTP ${res.status})`); }
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const d = block.split('\n').find(l => l.startsWith('data: ')); if (d && events.length < max) { try { events.push(JSON.parse(d.slice(6))); } catch { /* skip a bad frame */ } } }
        if (events.length >= max) { ctl.abort(); break; }
      }
    } catch (e) { if (e instanceof ToolError) throw e; if ((e as Error).name !== 'AbortError') throw new ToolError('network', `event stream failed: ${(e as Error).message}`); }
    finally { clearTimeout(t); }
    return { chain: a.chain, listenedS: ms / 1000, count: events.length, events };
  });
ro('meme_stocks', 'Tokenized stocks', 'Registered tokenized stocks on Solana (GET /v1/solana/stocks): xStocks, Ondo, Backpack; tradable and most liquid first. Not offered to US persons.',
  { chain: { ...chainArg, description: 'solana (stocks are on Solana).' }, q: str('A ticker or underlying, e.g. TSLA.', { pattern: '^[A-Za-z0-9.]{1,16}$' }), issuer: str('Issuer filter.', { pattern: '^[A-Za-z0-9 -]{1,32}$' }), all: bool('Every verified mint, not only tradable ones.'), limit: int('Page size.', { minimum: 1, maximum: 200 }), offset: int('Page offset.', { minimum: 0 }) }, ['chain'],
  (a, c) => api(c, 'GET', a.chain, '/v1/stocks' + qs(pick(a, ['q', 'issuer', 'all', 'limit', 'offset']))));
ro('meme_stock', 'One stock', 'One tokenized stock (GET /v1/solana/stocks/:symbol): shares per token, issuer pause, share price, what the best route pays per share now, your holding.',
  { chain: { ...chainArg, description: 'solana.' }, symbol: str('Ticker: TSLAx, TSLAon or TSLA.', { pattern: '^[A-Za-z0-9.]{1,16}$' }) }, ['chain', 'symbol'], (a, c) => api(c, 'GET', a.chain, `/v1/stocks/${enc(a.symbol)}`));
ro('meme_token_safety', 'Token safety', 'Token safety report on Solana (GET /v1/solana/tokens/:mint/safety): freeze and mint authority, Token-2022 extensions, holder concentration, a sell route, 1-SOL impact, verdict.',
  { chain: { ...chainArg, description: 'solana.' }, mint: str('The token mint.', { pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' }) }, ['chain', 'mint'], (a, c) => api(c, 'GET', a.chain, `/v1/tokens/${enc(a.mint)}/safety`));

// ── execution server: wallet link (no funds move) ──
TOOLS.push({ name: 'meme_wallet_link_start', title: 'Start wallet link', readOnly: false, inputSchema: obj({ chain: chainArg, address: str('The user\'s own Privy wallet address on this chain (a Solana address, or 0x... on an EVM chain).', { pattern: '^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$' }) }, ['chain', 'address']),
  description: 'Starts linking the user\'s Privy wallet on one chain (POST /v1/<chain>/wallet/link/start). Moves no funds: it returns the message the user signs in their own wallet; finishing the link is done by the user\'s app with that signature.',
  run: (a, c) => api(c, 'POST', a.chain, '/v1/wallet/link/start', { address: a.address }) });

// ── execution server: cancels (no funds spent, but they remove protection such as a stop loss) ──
const cancelProps = (what: string) => ({ chain: chainArg, id: str(`The ${what} id.`, { pattern: ID }), confirm: { type: 'boolean', description: `Must be true, after the user approved cancelling this ${what}.` } });
const needConfirm = (tool: string, a: Json) => { if (a.confirm !== true) throw new ToolError('confirm_required', `${tool} was not sent: it needs confirm: true`, 'Ask the user to approve the cancel, then call again with confirm: true.'); };
TOOLS.push({ name: 'meme_cancel_order', title: 'Cancel order', readOnly: false, inputSchema: obj(cancelProps('order'), ['chain', 'id', 'confirm']),
  description: 'Cancels a standing order (DELETE /v1/<chain>/orders/:id) and releases its reserved balance. Spends nothing, but cancelling a stop loss or take profit removes that protection: needs confirm: true.',
  run: (a, c) => { needConfirm('meme_cancel_order', a); return api(c, 'DELETE', a.chain, `/v1/orders/${enc(a.id)}`); } });
TOOLS.push({ name: 'meme_cancel_twap', title: 'Stop TWAP', readOnly: false, inputSchema: obj(cancelProps('TWAP'), ['chain', 'id', 'confirm']),
  description: 'Stops a TWAP (DELETE /v1/<chain>/twap/:id): unsent slices are skipped, one already in flight finishes. Needs confirm: true.',
  run: (a, c) => { needConfirm('meme_cancel_twap', a); return api(c, 'DELETE', a.chain, `/v1/twap/${enc(a.id)}`); } });

// ── execution server: real-funds tools ──
const stockProps = { perShare: bool('Solana stocks: prices are per SHARE and `shares` is in shares.'), shares: str('Solana stocks, sells with perShare: shares to sell.', { pattern: DEC }), allowRiskyToken: bool('Skip the token safety and share-price checks for this one trade. Only if the user explicitly asks.') };
spend('meme_buy', 'Market buy', 'Market buy (POST /v1/<chain>/trades/buy). Real chains: `amount` is plain units of the native coin (SOL on solana, ETH on base and robinhood, BNB on bnb), sent as that chain\'s amountKey. Practice: `amount` is raw units and `walletId` w1 or w2. An idempotency key is sent, so a retry with the same `key` never trades twice.',
  { chain: chainArg, token: tokenArg, amount: str('Real chains: native coin in plain units, e.g. "0.01". Practice: raw units.', { pattern: DEC }), slippagePct: num('Slippage percent, up to 50 (real chains).', { minimum: 0.01, maximum: 50 }), slippageBps: int('Slippage in basis points (practice).', { minimum: 1, maximum: 5000 }),
    walletId: str('Practice only: w1 or w2.', { pattern: ID }), key: str('Idempotency key: the same key never trades twice.', { pattern: ID }), mevProtection: bool('Solana: send privately through Jito.'), ...stockProps }, ['chain', 'token', 'amount'],
  (a, c) => { const b: Json = { token: a.token, ...pick(a, ['slippagePct', 'slippageBps', 'mevProtection', 'perShare', 'allowRiskyToken']) }; nativeAmount(a.chain, a, b); if (a.chain === 'practice') b.walletId = a.walletId ?? 'w1'; return api(c, 'POST', a.chain, '/v1/trades/buy', b, { 'idempotency-key': idemKey(a, c, 'buy') }); });
spend('meme_sell', 'Market sell', 'Market sell (POST /v1/<chain>/trades/sell): `pct` of the holding, or `tokens` (plain token units), or (Solana stocks) `shares` with perShare. Practice: `amount` raw or `pctBps`, with `walletId`.',
  { chain: chainArg, token: tokenArg, pct: num('Percent of the holding to sell, 0.01 to 100.', { minimum: 0.01, maximum: 100 }), tokens: str('Plain token units to sell.', { pattern: DEC }), amount: str('Practice: raw token units.', { pattern: RAW }), pctBps: int('Practice: share of the balance in basis points (5000 = 50%).', { minimum: 1, maximum: 10000 }),
    slippagePct: num('Slippage percent, up to 50.', { minimum: 0.01, maximum: 50 }), slippageBps: int('Slippage in basis points (practice).', { minimum: 1, maximum: 5000 }), walletId: str('Practice only: w1 or w2.', { pattern: ID }), key: str('Idempotency key.', { pattern: ID }), mevProtection: bool('Solana: send privately through Jito.'), ...stockProps }, ['chain', 'token'],
  (a, c) => {
    if ([a.pct, a.tokens, a.amount, a.pctBps, a.shares].every(x => x === undefined)) throw new ToolError('bad_request', 'say how much to sell: pct, tokens, shares (stocks) or, on practice, amount or pctBps');
    const b: Json = pick(a, ['token', 'pct', 'tokens', 'amount', 'pctBps', 'shares', 'slippagePct', 'slippageBps', 'mevProtection', 'perShare', 'allowRiskyToken']);
    // the practice server takes a share of the balance as pctBps only: `pct` (what an assistant naturally sends) is turned into it (50 -> 5000), found in a live run
    if (a.chain === 'practice') { b.walletId = a.walletId ?? 'w1'; if (b.pct !== undefined && b.pctBps === undefined) { b.pctBps = Math.round(Number(b.pct) * 100); delete b.pct; } }
    return api(c, 'POST', a.chain, '/v1/trades/sell', b, { 'idempotency-key': idemKey(a, c, 'sell') });
  });
spend('meme_place_order', 'Place standing order', 'A standing order that trades by itself when its trigger is hit (POST /v1/<chain>/orders/<type>): limit-buy (with `amount` of the native coin), limit-sell, take-profit, stop-loss (with `tokens` or `pct`), trigger `priceUsd` or `price` (native per token); trailing-stop with `trailPct`; bracket with `tpUsd` and/or `slUsd`. Practice uses raw `amount`, `priceE18`/`trailBps` and `walletId`.',
  { chain: chainArg, type: { type: 'string', enum: ['limit-buy', 'limit-sell', 'take-profit', 'stop-loss', 'trailing-stop', 'bracket'] }, token: tokenArg,
    amount: str('limit-buy: native coin in plain units (real chains) or raw units (practice); practice sells: raw token units.', { pattern: DEC }), tokens: str('Plain token units to sell.', { pattern: DEC }), pct: num('Percent of the holding to sell.', { minimum: 0.01, maximum: 100 }),
    priceUsd: str('Trigger price in USD per token.', { pattern: DEC }), price: str('Trigger price in native coin per token.', { pattern: DEC }), priceE18: str('Practice: raw trigger (quote units per token x1e18).', { pattern: RAW }),
    trailPct: num('trailing-stop: percent below the peak.', { minimum: 0.1, maximum: 90 }), trailBps: int('Practice trailing stop in bps.', { minimum: 10, maximum: 9000 }), tpUsd: str('bracket: take-profit price in USD.', { pattern: DEC }), slUsd: str('bracket: stop-loss price in USD.', { pattern: DEC }),
    slippagePct: num('Slippage percent.', { minimum: 0.01, maximum: 50 }), slippageBps: int('Slippage bps (practice).', { minimum: 1, maximum: 5000 }), ttlS: int('Expire after this many seconds.', { minimum: 60, maximum: 31_536_000 }), id: str('Your own order id.', { pattern: ID }), walletId: str('Practice only: w1 or w2.', { pattern: ID }),
    mevProtection: bool('Solana: send privately through Jito.'), ...stockProps }, ['chain', 'type', 'token'],
  (a, c) => {
    const b: Json = pick(a, ['token', 'tokens', 'pct', 'priceUsd', 'price', 'priceE18', 'trailPct', 'trailBps', 'tpUsd', 'slUsd', 'slippagePct', 'slippageBps', 'ttlS', 'id', 'mevProtection', 'perShare', 'shares', 'allowRiskyToken']);
    if (a.type === 'limit-buy') nativeAmount(a.chain, a, b); else if (a.amount !== undefined) b.amount = a.amount;
    if (a.chain === 'practice') b.walletId = a.walletId ?? 'w1';
    return api(c, 'POST', a.chain, `/v1/orders/${a.type}`, b);
  });
spend('meme_twap', 'TWAP', 'Buys or sells `total` in equal `slices` (2 to 100), `intervalS` apart (POST /v1/<chain>/twap). Each slice is a real trade. `total`: native coin for a buy, token for a sell (raw units on practice; see docs/HTTP_API.md for real chains).',
  { chain: chainArg, token: tokenArg, side: { type: 'string', enum: ['buy', 'sell'] }, total: str('Total to trade.', { pattern: DEC }), slices: int('Number of slices.', { minimum: 2, maximum: 100 }), intervalS: int('Seconds between slices.', { minimum: 1, maximum: 86_400 }),
    slippageBps: int('Slippage in basis points.', { minimum: 1, maximum: 5000 }), limitPriceE18: str('Skip slices above/below this raw price.', { pattern: RAW }), id: str('Your own TWAP id.', { pattern: ID }), walletId: str('Practice: w1 or w2.', { pattern: ID }) }, ['chain', 'token', 'side', 'total', 'slices', 'intervalS'],
  (a, c) => { const b: Json = pick(a, ['token', 'side', 'total', 'slices', 'intervalS', 'slippageBps', 'limitPriceE18', 'id']); b.walletId = a.walletId ?? (a.chain === 'practice' ? 'w1' : undefined); if (b.walletId === undefined) delete b.walletId; return api(c, 'POST', a.chain, '/v1/twap', b); });
spend('meme_bulk', 'Bulk trade', 'One token from up to 10 wallets at once (POST /v1/<chain>/bulk/buy or /bulk/sell): exact `legs`, or `wallets` + `total` for an equal split, or (sell) `pctBps` of each balance. Not atomic: meme_bulk_status says which legs landed.',
  { chain: chainArg, side: { type: 'string', enum: ['buy', 'sell'] }, token: tokenArg, legs: { type: 'array', maxItems: 10, items: obj({ walletId: str('Wallet id.', { pattern: ID }), amount: str('Amount (raw units).', { pattern: RAW }) }, ['walletId', 'amount']) },
    wallets: { type: 'array', minItems: 1, maxItems: 10, items: str('Wallet id.', { pattern: ID }) }, total: str('Total for an equal split (raw units).', { pattern: RAW }), pctBps: int('Sell: share of each balance in bps.', { minimum: 1, maximum: 10000 }),
    slippageBps: int('Slippage bps.', { minimum: 1, maximum: 5000 }), maxImpactBps: int('Refuse a leg above this price impact.', { minimum: 1, maximum: 10000 }), onFailure: { type: 'string', enum: ['continue', 'stop'] }, id: str('Your own bulk id.', { pattern: ID }) }, ['chain', 'side', 'token'],
  (a, c) => api(c, 'POST', a.chain, `/v1/bulk/${a.side}`, pick(a, ['token', 'legs', 'wallets', 'total', 'pctBps', 'slippageBps', 'maxImpactBps', 'onFailure', 'id'])));

// ── RFQ desk (read-only) ──
const solMint = str('A Solana token mint (the desk lists its stocks in rfq_config).', { pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' });
const deskChain = { type: 'string', enum: [...DESK_EVM_CHAINS], description: 'base, bnb or robinhood.' };
ro('rfq_config', 'Desk config', 'The RFQ desk\'s setup (GET /api/config): the Solana stocks it quotes, the EVM stocks per chain (base, bnb, robinhood), SOL price, max USD per trade, RPC kind. Read-only.', {}, [], (_a, c) => desk(c, 'GET', '/api/config'));
ro('rfq_quote', 'JupiterZ RFQ quote (Solana)', 'Compares a JupiterZ market-maker quote with Jupiter\'s routes for a Solana stock (POST /api/quote) and returns every stage: context, rfq, other, build, xray (decoded maker transaction and its gate), sim, decision, venues, capacity (how much the maker fills at market and the split it suggests). Read-only: nothing is signed or sent; the transaction itself is omitted.',
  { mint: solMint, side: { type: 'string', enum: ['buy', 'sell'], description: 'buy (default): pay asset in; sell: the stock in.' }, pay: { type: 'string', enum: ['SOL', 'USDC'], description: 'The quote asset (default SOL).' },
    amount: str('Raw units of the input: lamports (SOL) or 1e-6 USDC for a buy; the stock\'s raw units for a sell.', { pattern: RAW }), minUsd: num('RFQ threshold in USD (default 7500).', { minimum: 0 }), marginBps: int('Capacity search margin (default 20).', { minimum: 0, maximum: 1000 }),
    taker: str('A taker wallet to quote for (default: the desk picks one).', { pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' }), stages: { type: 'array', items: { type: 'string', pattern: '^[a-z]{2,16}$' }, description: 'Only return these stages, e.g. ["rfq","decision","capacity"].' } }, ['mint', 'amount'],
  async (a, c) => { const out = parseNdjson(await desk(c, 'POST', '/api/quote', pick(a, ['mint', 'side', 'pay', 'amount', 'minUsd', 'marginBps', 'taker']), true)); const err = out.find(s => s?.stage === 'error'); if (err) throw new ToolError('desk_error', String(err.error)); return a.stages ? out.filter(s => a.stages.includes(s?.stage)) : out; });
ro('rfq_ladder', 'Size ladder rung', 'One rung of the desk\'s size ladder (POST /api/ladder): for `usd` worth, the JupiterZ (RFQ) price and the other routers\' price, buy or sell.',
  { mint: solMint, side: { type: 'string', enum: ['buy', 'sell'] }, pay: { type: 'string', enum: ['SOL', 'USDC'] }, usd: num('Trade size in USD.', { minimum: 1, maximum: 10_000_000 }) }, ['mint', 'usd'], (a, c) => desk(c, 'POST', '/api/ladder', pick(a, ['mint', 'side', 'pay', 'usd'])));
ro('rfq_gate', 'Gate check', 'Runs the desk\'s gate on a JupiterZ /order transaction (POST /api/gate): pass a base64 `transaction`, or none to check the recorded one with an optional `tamper` (amount, redirect, drain, signer) to see the gate refuse it. Read-only.',
  { transaction: { type: 'string', description: 'Base64 wire transaction.', maxLength: 20_000, pattern: '^[A-Za-z0-9+/=\\s]+$' }, tamper: { type: 'string', enum: ['none', 'amount', 'redirect', 'drain', 'signer'] }, asOfQuote: bool('Check a pasted transaction as of 30 s before its own expiry.') }, [],
  (a, c) => desk(c, 'POST', '/api/gate', pick(a, ['transaction', 'tamper', 'asOfQuote'])));
ro('rfq_evm_quote', 'EVM venue comparison', 'Compares venues for a tokenized stock on an EVM chain (POST /api/evm/quote): Relay, KyberSwap, LI.FI, OpenOcean and Bebop RFQ, each with output, fee, gas, price impact and slippage. Read-only.',
  { chain: deskChain, symbol: str('The stock symbol on that chain (rfq_config lists them).', { pattern: '^[A-Za-z0-9.]{1,16}$' }), side: { type: 'string', enum: ['buy', 'sell'] }, amount: num('Plain units of the input: the native coin (ETH, BNB) for a buy, the stock for a sell.', { minimum: 0, maximum: 1e7 }) }, ['chain', 'symbol', 'amount'],
  (a, c) => desk(c, 'POST', '/api/evm/quote', pick(a, ['chain', 'symbol', 'side', 'amount'])));
ro('rfq_liquidity', 'Pool liquidity', 'Every public pool that holds a token on solana, base, bnb or robinhood (GET /api/liquidity, from DexScreener): DEX, pair and USD liquidity. Market makers with no public pool are not in it.',
  { chain: { type: 'string', enum: ['solana', 'base', 'bnb', 'robinhood'] }, token: str('A Solana mint or a 0x address.', { pattern: '^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$' }) }, ['chain', 'token'],
  (a, c) => desk(c, 'GET', '/api/liquidity' + qs({ chain: a.chain, token: a.token })));
ro('rfq_evm_price', 'EVM stock price', 'The USD price of a tokenized stock on an EVM chain (GET /api/evm/price): native coin price, token price, share price and multiplier.',
  { chain: deskChain, symbol: str('The stock symbol.', { pattern: '^[A-Za-z0-9.]{1,16}$' }) }, ['chain', 'symbol'], (a, c) => desk(c, 'GET', '/api/evm/price' + qs({ chain: a.chain, symbol: a.symbol })));
ro('rfq_token_price', 'Solana token price', 'The USD price of a Solana token (GET /api/token-price).', { mint: solMint }, ['mint'], (a, c) => desk(c, 'GET', '/api/token-price' + qs({ mint: a.mint })));

/** The tools as MCP lists them. */
export function listTools() {
  return TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, idempotentHint: t.readOnly, openWorldHint: true } }));
}
export const SPENDING_TOOLS = TOOLS.filter(t => t.spends).map(t => t.name);

const text = (s: string, c: Ctx) => { const r = redact(s, c.secrets); return r.length > MAX_TEXT ? r.slice(0, MAX_TEXT) + `\n… (${r.length - MAX_TEXT} more characters cut)` : r; };
/** Runs one tool. Never throws: bad arguments, refusals and HTTP errors come back as isError results, with secrets removed. */
export async function callTool(name: string, args: Json, c: Ctx): Promise<ToolResult> {
  const t = TOOLS.find(x => x.name === name);
  if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  const a = args ?? {};
  // a spending call without confirm gets the gate's explanation (what to show the user), not a bare "confirm is required"
  if (t.spends && a && typeof a === 'object' && a.confirm === undefined && (CHAINS as readonly string[]).includes(a.chain)) a.confirm = false;
  const errs = validate(t.inputSchema, a);
  if (errs.length) return { isError: true, content: [{ type: 'text', text: text(JSON.stringify({ error: { code: 'bad_arguments', message: errs.join('; ') } }), c) }] };
  try {
    const out = await t.run(a, c);
    return { content: [{ type: 'text', text: text(typeof out === 'string' ? out : JSON.stringify(out, null, 1), c) }] };
  } catch (e) {
    const err = e instanceof ToolError ? { code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) } : { code: 'internal', message: (e as Error).message };
    return { isError: true, content: [{ type: 'text', text: text(JSON.stringify({ error: err }), c) }] };
  }
}
