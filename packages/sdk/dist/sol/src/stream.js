/** EVENT-DRIVEN TRIGGER FOR SOLANA. Instead of waiting for the once-a-second poll, subscribe to account changes (a bonding curve, a pool's vaults) over the node's WebSocket and run the trader the moment one changes.
 *  Standard Solana `accountSubscribe`, so it works with any node that offers a WebSocket (Alchemy, Helius, a local validator, devnet). It makes a trigger fire sooner after a price change; it does not make the network
 *  or the node faster, and an RPC WebSocket is not a validator-level feed (Yellowstone gRPC is faster and is not implemented here).
 *  Safety: a missed or dropped message only costs speed. Orders still evaluate on every tick, so the 1-second poll stays on as a backstop (see `ChangeTrigger`). */
export class SolanaStream {
    o;
    ws;
    subs = new Map();
    reqToAcct = new Map();
    subToAcct = new Map();
    next = 1;
    backoff;
    stopped = true;
    timer;
    watchdog;
    connected = false;
    reconnects = 0;
    lastMessageAt = 0;
    events = 0;
    constructor(o) {
        this.o = o;
        this.backoff = o.minBackoffMs ?? 500;
    }
    now() { return (this.o.now ?? Date.now)(); }
    mk() { return this.o.makeSocket ? this.o.makeSocket(this.o.wsUrl) : new globalThis.WebSocket(this.o.wsUrl); }
    /** Watch one account. Returns a function that stops watching it. Subscribing before `start()` is fine. */
    watch(account, h) {
        let set = this.subs.get(account);
        if (!set) {
            set = new Set();
            this.subs.set(account, set);
            if (this.connected)
                this.sendSub(account);
        }
        set.add(h);
        return () => { const s = this.subs.get(account); if (!s)
            return; s.delete(h); if (!s.size) {
            this.subs.delete(account);
            for (const [id, a] of this.subToAcct)
                if (a === account) {
                    this.subToAcct.delete(id);
                    if (this.connected)
                        this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: this.next++, method: 'accountUnsubscribe', params: [id] }));
                }
        } };
    }
    sendSub(account) { const id = this.next++; this.reqToAcct.set(id, account); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [account, { encoding: 'base64', commitment: this.o.commitment ?? 'confirmed' }] })); }
    start() { if (!this.stopped)
        return; this.stopped = false; this.open(); const every = Math.max(1000, Math.floor((this.o.staleAfterMs ?? 30_000) / 3)); this.watchdog = setInterval(() => { if (this.connected && this.subs.size && this.now() - this.lastMessageAt > (this.o.staleAfterMs ?? 30_000) && this.lastMessageAt) {
        this.o.log?.('stream quiet for too long: reconnecting');
        try {
            this.ws?.close();
        }
        catch { /* already closed */ }
    } }, every); this.watchdog.unref?.(); }
    stop() { this.stopped = true; this.connected = false; if (this.timer)
        clearTimeout(this.timer); if (this.watchdog)
        clearInterval(this.watchdog); try {
        this.ws?.close();
    }
    catch { /* already closed */ } }
    open() {
        let ws;
        try {
            ws = this.mk();
        }
        catch (e) {
            this.o.log?.(`stream: cannot open socket: ${e.message}`);
            return this.retry();
        }
        this.ws = ws;
        this.reqToAcct.clear();
        this.subToAcct.clear();
        ws.onopen = () => { this.connected = true; this.backoff = this.o.minBackoffMs ?? 500; this.lastMessageAt = this.now(); for (const a of this.subs.keys())
            this.sendSub(a); };
        ws.onmessage = ev => {
            let m;
            try {
                m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
            }
            catch {
                return;
            }
            this.lastMessageAt = this.now();
            if (m.id !== undefined && typeof m.result === 'number') {
                const a = this.reqToAcct.get(m.id);
                if (a) {
                    this.reqToAcct.delete(m.id);
                    this.subToAcct.set(m.result, a);
                }
                return;
            }
            if (m.method === 'accountNotification') {
                const a = this.subToAcct.get(m.params?.subscription);
                if (!a)
                    return;
                this.events++;
                const slot = Number(m.params?.result?.context?.slot ?? 0), at = this.now();
                for (const h of [...(this.subs.get(a) ?? [])]) {
                    try {
                        h(a, slot, at);
                    }
                    catch (e) {
                        this.o.log?.(`stream handler error: ${e.message}`);
                    }
                }
            }
        };
        ws.onclose = () => { this.connected = false; if (!this.stopped)
            this.retry(); };
        ws.onerror = () => { };
    }
    retry() { if (this.stopped || this.timer)
        return; this.reconnects++; const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 10_000); this.timer = (this.o.setTimer ?? setTimeout)(() => { this.timer = undefined; if (!this.stopped)
        this.open(); }, wait); this.timer?.unref?.(); }
}
/** Run `fire` after a watched account changes, never more than once per `minIntervalMs`, never two at once, and with one trailing run if more changes arrive meanwhile (so the last change is never lost). */
export class ChangeTrigger {
    fire;
    o;
    running = false;
    again = false;
    last = 0;
    timer;
    fired = 0;
    errors = 0;
    lastLatencyMs;
    eventAt = 0;
    constructor(fire, o = {}) {
        this.fire = fire;
        this.o = o;
    }
    now() { return (this.o.now ?? Date.now)(); }
    /** Pass this to `SolanaStream.watch`. */
    onChange = (_account, _slot, receivedAt = this.now()) => { if (!this.eventAt)
        this.eventAt = receivedAt; void this.run(); };
    async run() {
        if (this.running) {
            this.again = true;
            return;
        }
        const gap = (this.o.minIntervalMs ?? 150) - (this.now() - this.last);
        if (gap > 0) {
            if (!this.timer) {
                this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, gap);
                this.timer.unref?.();
            }
            return;
        }
        this.running = true;
        this.last = this.now();
        const at = this.eventAt;
        this.eventAt = 0;
        try {
            await this.fire();
            this.fired++;
            if (at)
                this.lastLatencyMs = this.now() - at;
        }
        catch (e) {
            this.errors++;
            this.o.onError?.(e);
        }
        finally {
            this.running = false;
            if (this.again) {
                this.again = false;
                void this.run();
            }
        }
    }
}
