/** HOW A SIGNED TRANSACTION REACHES THE NETWORK. The chain builds and signs the transaction; a submitter only sends the finished bytes. The engine's write-ahead record, idempotency and confirmation tracking
 *  do not change with the submitter, because all of them key on the transaction signature, which is fixed before anything is sent.
 *  - `RpcSubmitter`: the node's own `sendTransaction` (the default).
 *  - `JitoSubmitter`: sends the transaction as a one-transaction bundle to a Jito block engine, with a tip paid in the transaction itself. Faster landing and no public-mempool exposure, in exchange for a tip on every attempt.
 *  Jito is not validated end to end here: it exists only on mainnet, where this project sends nothing. What IS checked: the request format against a stand-in block engine, and the tip-account list read from the real one. */
import { systemTransfer } from './tx.js';
export class RpcSubmitter {
    rpc;
    o;
    name = 'rpc';
    constructor(rpc, o = {}) {
        this.rpc = rpc;
        this.o = o;
    }
    async send(raw, signature) {
        const h = await this.rpc.call('sendTransaction', [raw, { encoding: 'base64', skipPreflight: this.o.skipPreflight ?? false, preflightCommitment: 'confirmed', maxRetries: 0 }]);
        if (h !== signature)
            throw new Error(`node returned signature ${h} but we computed ${signature}: refusing to track a different transaction`);
        return h;
    }
}
export const JITO_MAINNET_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1'; // Jito's documented public block engine; override for a regional endpoint
export class JitoSubmitter {
    o;
    name = 'jito';
    accounts;
    constructor(o) {
        this.o = o;
        if (!(o.tipLamports > 0n))
            throw new Error('Jito needs a tip greater than zero');
        const cap = o.maxTipLamports ?? 10000000n;
        if (o.tipLamports > cap)
            throw new Error(`tip ${o.tipLamports} lamports is above the safety cap ${cap}: raise maxTipLamports on purpose if you mean it`);
    }
    async rpc(path, method, params) {
        const f = this.o.fetchFn ?? fetch, headers = { 'content-type': 'application/json', ...(this.o.uuid ? { 'x-jito-auth': this.o.uuid } : {}) };
        const r = await f(`${this.o.url ?? JITO_MAINNET_BLOCK_ENGINE}${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
        if (!r.ok)
            throw new Error(`jito ${method}: HTTP ${r.status}`);
        const j = await r.json();
        if (j.error)
            throw new Error(`jito ${method}: ${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}`);
        return j.result;
    }
    /** Tip accounts come from the block engine (getTipAccounts), never from a hard-coded list, and are cached briefly. A tip to an address that is not one of them would simply be a donation. */
    async tipAccounts() {
        const now = (this.o.now ?? Date.now)();
        if (this.accounts && now - this.accounts.at < (this.o.tipAccountsTtlMs ?? 600_000))
            return this.accounts.list;
        const list = await this.rpc('/bundles', 'getTipAccounts', []);
        if (!Array.isArray(list) || !list.length || list.some(a => typeof a !== 'string' || a.length < 32 || a.length > 44))
            throw new Error('jito returned an unusable tip account list');
        this.accounts = { list, at: now };
        return list;
    }
    async extraInstruction(payer) { const a = await this.tipAccounts(), to = (this.o.pickTip ?? (x => x[Math.floor(Math.random() * x.length)]))(a); if (!a.includes(to))
        throw new Error('chosen tip account is not in the block engine\'s list'); return systemTransfer(payer, to, this.o.tipLamports); }
    async send(raw, signature) {
        const id = await this.rpc('/bundles', 'sendBundle', [[raw], { encoding: 'base64' }]);
        if (typeof id !== 'string' || !id)
            throw new Error('jito accepted the bundle but returned no bundle id');
        return signature; // the network confirms by signature, exactly as for a normal send; the bundle id is only a receipt from the block engine
    }
}
