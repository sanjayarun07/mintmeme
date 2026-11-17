/** HTTP client for the Meme execution API. Same method names as `Trader`, but over the network: amounts go out as decimal strings (bigint is fine to pass) and come back as decimal strings.
 *  `fetch` is injectable for tests. Every method throws `SdkError` carrying the server's code, message and fix. Trade, order, bulk and TWAP ids are returned as stored by the server (`<userId>.<id>`). */
import { SdkError, toJson } from './wire.js';
export class MemeClient {
    o;
    constructor(o) {
        this.o = o;
        if (!o.apiKey)
            throw new SdkError('config', 'apiKey is required');
    }
    async req(method, path, body, headers = {}) {
        const f = this.o.fetch ?? fetch, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 30_000);
        try {
            const r = await f(this.o.baseUrl.replace(/\/$/, '') + path, { method, signal: ctl.signal, headers: { authorization: `Bearer ${this.o.apiKey}`, ...(this.o.userId ? { 'x-user-id': this.o.userId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : toJson(body) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok)
                throw new SdkError(j?.error?.code ?? 'http_' + r.status, j?.error?.message ?? `request failed with ${r.status}`, j?.error?.fix, r.status);
            return j;
        }
        catch (e) {
            if (e instanceof SdkError)
                throw e;
            throw new SdkError('network', `could not reach the API: ${e.message}`, 'Check baseUrl and that the server is running.', 0);
        }
        finally {
            clearTimeout(t);
        }
    }
    /** With an app key: the same client acting for another end user. */
    forUser(userId) { return new MemeClient({ ...this.o, userId }); }
    // ── app keys only: the app's webhook (signed POSTs of every end user's events) and its end users ──
    appWebhook() { return this.req('GET', '/v1/app/webhook'); }
    /** Returns the signing secret once (generated unless you pass one). Verify each delivery: x-memedesk-signature t=..,v1=HMAC-SHA256(secret, "t.body"). */
    setAppWebhook(url, secret) { return this.req('PUT', '/v1/app/webhook', secret ? { url, secret } : { url }); }
    deleteAppWebhook() { return this.req('DELETE', '/v1/app/webhook'); }
    testAppWebhook() { return this.req('POST', '/v1/app/webhook/test', {}); }
    appUsers() { return this.req('GET', '/v1/app/users'); }
    /** The app's own fee on its users' trades (MODE=solana-mainnet): bps of each trade, paid in SOL to `wallet` inside the trade, capped by the operator. */
    appFees() { return this.req('GET', '/v1/app/fees'); }
    setAppFees(wallet, bps) { return this.req('PUT', '/v1/app/fees', { wallet, bps }); }
    deleteAppFees() { return this.req('DELETE', '/v1/app/fees'); }
    overview() { return this.req('GET', '/v1/overview'); }
    // ── plain units (servers in MODE=solana-mainnet): one call per action, amounts as decimal strings, the linked wallet by default ──
    /** Buy with `sol`, or sell `pct` of the holding or `tokens`. Resolves with the trade (state, fill, failure). Same `key` again never trades twice. */
    swap(p) { const { side, key, ...b } = p; return this.req('POST', `/v1/trades/${side === 'sell' ? 'sell' : 'buy'}`, b, key ? { 'idempotency-key': key } : {}); }
    /** A standing order that trades by itself: `limit-buy` (with `sol`), `limit-sell`, `take-profit`, `stop-loss` (with `tokens` or `pct`), trigger `priceUsd` or `price` (SOL per token);
     *  `trailing-stop` with `trailPct`; `bracket` with `tpUsd` and/or `slUsd`. */
    placeOrder(p) { const { type, ...b } = p; return this.req('POST', `/v1/orders/${type}`, b); }
    /** The linked wallet (MODE=solana-mainnet): address, and whether the server may trade it now (and why not). */
    wallet() { return this.req('GET', '/v1/wallet'); }
    linkStart(address) { return this.req('POST', '/v1/wallet/link/start', { address }); }
    linkFinish(address, signatureBase64) { return this.req('POST', '/v1/wallet/link/finish', { address, signature: signatureBase64 }); }
    unlink() { return this.req('DELETE', '/v1/wallet'); }
    /** Trading settings (MODE=solana-mainnet). `mevProtection: true` sends trades privately through Jito with a tip of at most `maxTipSol` (default 0.0001). Off by default. */
    settings() { return this.req('GET', '/v1/settings'); }
    updateSettings(p) { return this.req('PATCH', '/v1/settings', p); }
    quote(p) { return this.req('POST', '/v1/quote', p); }
    /** `key` becomes the Idempotency-Key: retrying the same key never trades twice. */
    buy(p) { const { key, ...b } = p; return this.req('POST', '/v1/trades/buy', b, key ? { 'idempotency-key': key } : {}); }
    sell(p) { const { key, ...b } = p; return this.req('POST', '/v1/trades/sell', b, key ? { 'idempotency-key': key } : {}); }
    trades(q = {}) { return this.req('GET', '/v1/trades' + qs(q)); }
    trade(key) { return this.req('GET', `/v1/trades/${enc(key)}`); }
    advance(key) { return this.req('POST', `/v1/trades/${enc(key)}/advance`, {}); }
    cancelStuck(walletId, opts = {}) { return this.req('POST', `/v1/wallets/${enc(walletId)}/cancel-stuck`, { force: opts.force === true }); } // same shape as Trader.cancelStuck
    limitBuy(p) { return this.req('POST', '/v1/orders/limit-buy', p); }
    limitSell(p) { return this.req('POST', '/v1/orders/limit-sell', p); }
    takeProfit(p) { return this.req('POST', '/v1/orders/take-profit', p); }
    stopLoss(p) { return this.req('POST', '/v1/orders/stop-loss', p); }
    trailingStop(p) { return this.req('POST', '/v1/orders/trailing-stop', p); }
    bracket(p) { return this.req('POST', '/v1/orders/bracket', p); }
    orders(q = {}) { return this.req('GET', '/v1/orders' + qs(q)); }
    order(id) { return this.req('GET', `/v1/orders/${enc(id)}`); }
    /** Move an active order's trigger: priceE18 (quote token) or priceUsd (dollars). */
    editOrder(id, p) { return this.req('PATCH', `/v1/orders/${enc(id)}`, p); }
    cancelOrder(id) { return this.req('DELETE', `/v1/orders/${enc(id)}`); }
    bulkBuy(p) { return this.req('POST', '/v1/bulk/buy', p); }
    bulkSell(p) { return this.req('POST', '/v1/bulk/sell', p); }
    bulk(id) { return this.req('GET', `/v1/bulk/${enc(id)}`); }
    twap(p) { return this.req('POST', '/v1/twap', p); }
    twapStatus(id) { return this.req('GET', `/v1/twap/${enc(id)}`); }
    cancelTwap(id) { return this.req('DELETE', `/v1/twap/${enc(id)}`); }
    addPriceAlert(p) { return this.req('POST', '/v1/alerts', p); }
    cancelPriceAlert(id) { return this.req('DELETE', `/v1/alerts/${enc(id)}`); }
    positions() { return this.req('GET', '/v1/positions'); }
    history(token) { return this.req('GET', '/v1/history' + qs({ token })); }
    pauseEntries() { return this.req('POST', '/v1/entries/pause', {}); }
    resumeEntries() { return this.req('POST', '/v1/entries/resume', {}); }
    snipes() { return this.req('GET', '/v1/snipes'); }
    addSnipe(p) { return this.req('POST', '/v1/snipes', p); }
    copies() { return this.req('GET', '/v1/copies'); }
    addCopy(p) { return this.req('POST', '/v1/copies', p); }
    /** Server-sent events: order, trade, bulk, twap, snipe and alert changes. Resolves when the stream ends; pass an AbortSignal to stop listening. */
    async events(on, signal) {
        const f = this.o.fetch ?? fetch, r = await f(this.o.baseUrl.replace(/\/$/, '') + '/v1/events', { headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'text/event-stream' }, signal });
        if (!r.ok || !r.body)
            throw new SdkError('http_' + r.status, `event stream refused (${r.status})`, undefined, r.status);
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const d = block.split('\n').find(l => l.startsWith('data: '));
                if (d) {
                    try {
                        on(JSON.parse(d.slice(6)));
                    }
                    catch { /* ignore a bad frame */ }
                }
            }
        }
    }
}
const enc = encodeURIComponent;
const qs = (q) => { const p = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join('&'); return p ? '?' + p : ''; };
/** For an app's webhook endpoint: true when `signatureHeader` (x-memedesk-signature) matches the RAW request body for `secret` and is at most `toleranceS` old. */
export async function verifyWebhook(secret, rawBody, signatureHeader, toleranceS = 300, nowS = Math.floor(Date.now() / 1000)) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader ?? '');
    if (!m || Math.abs(nowS - Number(m[1])) > toleranceS)
        return false;
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const want = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
    return timingSafeEqual(want, Buffer.from(m[2], 'hex'));
}
