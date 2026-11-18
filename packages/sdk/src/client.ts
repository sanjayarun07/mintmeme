/** HTTP client for the Meme execution API. Same method names as `Trader`, but over the network: amounts go out as decimal strings (bigint is fine to pass) and come back as decimal strings.
 *  `fetch` is injectable for tests. Every method throws `SdkError` carrying the server's code, message and fix. Trade, order, bulk and TWAP ids are returned as stored by the server (`<userId>.<id>`). */
import { SdkError, toJson } from './wire.ts';
import type { Amount, PriceOrderInput, BulkInput, TwapInput, TraderEvent } from './trader.ts';

/** `userId`: with an APP key, the end user every call acts for (sent as X-User-Id). Use `forUser` to get a client per end user. */
export interface ClientOptions { baseUrl: string; apiKey: string; userId?: string; fetch?: typeof fetch; timeoutMs?: number }
type J = any;
export class MemeClient {
  constructor(private o: ClientOptions) { if (!o.apiKey) throw new SdkError('config', 'apiKey is required'); }
  private async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<J> {
    const f = this.o.fetch ?? fetch, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 30_000);
    try {
      const r = await f(this.o.baseUrl.replace(/\/$/, '') + path, { method, signal: ctl.signal, headers: { authorization: `Bearer ${this.o.apiKey}`, ...(this.o.userId ? { 'x-user-id': this.o.userId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : toJson(body) });
      const j: J = await r.json().catch(() => ({}));
      if (!r.ok) throw new SdkError(j?.error?.code ?? 'http_' + r.status, j?.error?.message ?? `request failed with ${r.status}`, j?.error?.fix, r.status);
      return j;
    } catch (e) { if (e instanceof SdkError) throw e; throw new SdkError('network', `could not reach the API: ${(e as Error).message}`, 'Check baseUrl and that the server is running.', 0); } finally { clearTimeout(t); }
  }
  /** With an app key: the same client acting for another end user. */
  forUser(userId: string) { return new MemeClient({ ...this.o, userId }); }
  // ── app keys only: the app's webhook (signed POSTs of every end user's events) and its end users ──
  appWebhook() { return this.req('GET', '/v1/app/webhook'); }
  /** Returns the signing secret once (generated unless you pass one). Verify each delivery: x-memedesk-signature t=..,v1=HMAC-SHA256(secret, "t.body"). */
  setAppWebhook(url: string, secret?: string) { return this.req('PUT', '/v1/app/webhook', secret ? { url, secret } : { url }); }
  deleteAppWebhook() { return this.req('DELETE', '/v1/app/webhook'); }
  testAppWebhook() { return this.req('POST', '/v1/app/webhook/test', {}); }
  appUsers() { return this.req('GET', '/v1/app/users'); }
  /** The app's own fee on its users' trades (MODE=solana-mainnet): bps of each trade, paid in SOL to `wallet` inside the trade, capped by the operator. */
  appFees() { return this.req('GET', '/v1/app/fees'); }
  setAppFees(wallet: string, bps: number) { return this.req('PUT', '/v1/app/fees', { wallet, bps }); }
  deleteAppFees() { return this.req('DELETE', '/v1/app/fees'); }
  // ── stored records (servers with PG_URL): newest first; `before` pages back (an updated_at for trades, an id for the audit log) ──
  recordTrades(q: { limit?: number; before?: string } = {}) { return this.req('GET', '/v1/records/trades' + qs(q)); }
  auditLog(q: { limit?: number; before?: string } = {}) { return this.req('GET', '/v1/records/audit' + qs(q)); }
  /** App keys: records of all the app's end users. */
  appRecordTrades(q: { limit?: number; before?: string } = {}) { return this.req('GET', '/v1/app/records/trades' + qs(q)); }
  appAuditLog(q: { limit?: number; before?: string } = {}) { return this.req('GET', '/v1/app/records/audit' + qs(q)); }
  overview() { return this.req('GET', '/v1/overview'); }
  // ── plain units (servers in MODE=solana-mainnet): one call per action, amounts as decimal strings, the linked wallet by default ──
  /** Buy with `sol`, or sell `pct` of the holding or `tokens`. Resolves with the trade (state, fill, failure). Same `key` again never trades twice. */
  swap(p: { side: 'buy' | 'sell'; mint: string; sol?: string; tokens?: string; pct?: number; slippagePct?: number; key?: string; /** this trade only: true = private (Jito), false = public; absent = your setting */ mevProtection?: boolean }) { const { side, key, ...b } = p; return this.req('POST', `/v1/trades/${side === 'sell' ? 'sell' : 'buy'}`, b, key ? { 'idempotency-key': key } : {}); }
  /** A standing order that trades by itself: `limit-buy` (with `sol`), `limit-sell`, `take-profit`, `stop-loss` (with `tokens` or `pct`), trigger `priceUsd` or `price` (SOL per token);
   *  `trailing-stop` with `trailPct`; `bracket` with `tpUsd` and/or `slUsd`. */
  placeOrder(p: { type: 'limit-buy' | 'limit-sell' | 'take-profit' | 'stop-loss' | 'trailing-stop' | 'bracket'; mint: string; sol?: string; tokens?: string; pct?: number; priceUsd?: string | number; price?: string;
    trailPct?: number; tpUsd?: string; slUsd?: string; slippagePct?: number; chase?: { stepBps: number; maxBps: number }; id?: string; ttlS?: number; mevProtection?: boolean }) { const { type, ...b } = p; return this.req('POST', `/v1/orders/${type}`, b); }
  /** The linked wallet (MODE=solana-mainnet): address, and whether the server may trade it now (and why not). */
  wallet() { return this.req('GET', '/v1/wallet'); }
  linkStart(address: string) { return this.req('POST', '/v1/wallet/link/start', { address }); }
  linkFinish(address: string, signatureBase64: string) { return this.req('POST', '/v1/wallet/link/finish', { address, signature: signatureBase64 }); }
  unlink() { return this.req('DELETE', '/v1/wallet'); }
  /** Trading settings (MODE=solana-mainnet). `mevProtection: true` sends trades privately through Jito with a tip of at most `maxTipSol` (default 0.0001). Off by default. */
  settings() { return this.req('GET', '/v1/settings'); }
  updateSettings(p: { mevProtection?: boolean; maxTipSol?: string }) { return this.req('PATCH', '/v1/settings', p); }
  quote(p: { side: 'buy' | 'sell'; token: string; amount: Amount; slippageBps?: number }) { return this.req('POST', '/v1/quote', p); }
  /** `key` becomes the Idempotency-Key: retrying the same key never trades twice. */
  buy(p: { walletId: string; token: string; amount: Amount; slippageBps?: number; minOut?: Amount; key?: string; deadlineS?: number; maxFeeBps?: number }) { const { key, ...b } = p; return this.req('POST', '/v1/trades/buy', b, key ? { 'idempotency-key': key } : {}); }
  sell(p: { walletId: string; token: string; amount?: Amount; pctBps?: number; slippageBps?: number; minOut?: Amount; key?: string; deadlineS?: number; maxFeeBps?: number }) { const { key, ...b } = p; return this.req('POST', '/v1/trades/sell', b, key ? { 'idempotency-key': key } : {}); }
  trades(q: { limit?: number; origin?: string; walletId?: string } = {}) { return this.req('GET', '/v1/trades' + qs(q)); }
  trade(key: string) { return this.req('GET', `/v1/trades/${enc(key)}`); }
  advance(key: string) { return this.req('POST', `/v1/trades/${enc(key)}/advance`, {}); }
  cancelStuck(walletId: string, opts: { force?: boolean } = {}) { return this.req('POST', `/v1/wallets/${enc(walletId)}/cancel-stuck`, { force: opts.force === true }); }   // same shape as Trader.cancelStuck
  limitBuy(p: PriceOrderInput) { return this.req('POST', '/v1/orders/limit-buy', p); }
  limitSell(p: PriceOrderInput) { return this.req('POST', '/v1/orders/limit-sell', p); }
  takeProfit(p: PriceOrderInput) { return this.req('POST', '/v1/orders/take-profit', p); }
  stopLoss(p: PriceOrderInput) { return this.req('POST', '/v1/orders/stop-loss', p); }
  trailingStop(p: Omit<PriceOrderInput, 'priceE18'> & { trailBps: number }) { return this.req('POST', '/v1/orders/trailing-stop', p); }
  bracket(p: Omit<PriceOrderInput, 'priceE18' | 'priceUsd'> & { takeProfitE18?: Amount; stopLossE18?: Amount; takeProfitUsd?: string; stopLossUsd?: string; trailBps?: number }) { return this.req('POST', '/v1/orders/bracket', p); }
  orders(q: { status?: string; token?: string } = {}) { return this.req('GET', '/v1/orders' + qs(q)); }
  order(id: string) { return this.req('GET', `/v1/orders/${enc(id)}`); }
  /** Move an active order's trigger: priceE18 (quote token) or priceUsd (dollars). */
  editOrder(id: string, p: { priceE18?: Amount; priceUsd?: string }) { return this.req('PATCH', `/v1/orders/${enc(id)}`, p); }
  cancelOrder(id: string) { return this.req('DELETE', `/v1/orders/${enc(id)}`); }
  bulkBuy(p: BulkInput) { return this.req('POST', '/v1/bulk/buy', p); }
  bulkSell(p: BulkInput & { pctBps?: number }) { return this.req('POST', '/v1/bulk/sell', p); }
  bulk(id: string) { return this.req('GET', `/v1/bulk/${enc(id)}`); }
  twap(p: TwapInput) { return this.req('POST', '/v1/twap', p); }
  twapStatus(id: string) { return this.req('GET', `/v1/twap/${enc(id)}`); }
  cancelTwap(id: string) { return this.req('DELETE', `/v1/twap/${enc(id)}`); }
  addPriceAlert(p: { id?: string; token: string; direction: 'above' | 'below'; threshold: number; oneShot?: boolean }) { return this.req('POST', '/v1/alerts', p); }
  cancelPriceAlert(id: string) { return this.req('DELETE', `/v1/alerts/${enc(id)}`); }
  positions() { return this.req('GET', '/v1/positions'); }
  history(token?: string) { return this.req('GET', '/v1/history' + qs({ token })); }
  pauseEntries() { return this.req('POST', '/v1/entries/pause', {}); }
  resumeEntries() { return this.req('POST', '/v1/entries/resume', {}); }
  snipes() { return this.req('GET', '/v1/snipes'); }
  addSnipe(p: J) { return this.req('POST', '/v1/snipes', p); }
  copies() { return this.req('GET', '/v1/copies'); }
  addCopy(p: J) { return this.req('POST', '/v1/copies', p); }
  /** Server-sent events: order, trade, bulk, twap, snipe and alert changes. Resolves when the stream ends; pass an AbortSignal to stop listening. */
  async events(on: (e: TraderEvent) => void, signal?: AbortSignal): Promise<void> {
    const f = this.o.fetch ?? fetch, r = await f(this.o.baseUrl.replace(/\/$/, '') + '/v1/events', { headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'text/event-stream' }, signal });
    if (!r.ok || !r.body) throw new SdkError('http_' + r.status, `event stream refused (${r.status})`, undefined, r.status);
    const dec = new TextDecoder(); let buf = ''; for await (const chunk of r.body as any) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const d = block.split('\n').find(l => l.startsWith('data: ')); if (d) { try { on(JSON.parse(d.slice(6))); } catch { /* ignore a bad frame */ } } } }
  }
}
const enc = encodeURIComponent;
const qs = (q: Record<string, unknown>) => { const p = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join('&'); return p ? '?' + p : ''; };

/** For an app's webhook endpoint: true when `signatureHeader` (x-memedesk-signature) matches the RAW request body for `secret` and is at most `toleranceS` old. */
export async function verifyWebhook(secret: string, rawBody: string, signatureHeader: string, toleranceS = 300, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? ''); if (!m || Math.abs(nowS - Number(m[1])) > toleranceS) return false;
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const want = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest(); return timingSafeEqual(want, Buffer.from(m[2], 'hex'));
}
