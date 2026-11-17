/** A SIGNER THAT ASKS THE USER'S OWN WALLET. The private key never reaches this process: the engine builds the transaction, this signer parks the message as a pending request, the browser wallet (any Wallet Standard
 *  wallet: Phantom, Solflare, Backpack, Privy's embedded wallet) signs it, and the signature comes back through `submit`. Every signature is checked against the wallet's public key and the exact message before it is accepted.
 *  A request nobody answers in time fails, and a failed signing means nothing was sent. */
import { base58 } from './tx.js';
import { verifySignature } from './signer.js';
import { randomUUID } from 'node:crypto';
export class SignRequestError extends Error {
    constructor(msg) { super(msg); }
}
export class RemoteSolSigner {
    o;
    waiting = new Map();
    constructor(o = {}) {
        this.o = o;
    }
    now() { return (this.o.now ?? Date.now)(); }
    sign(wallet, message) {
        const id = randomUUID(), ttl = this.o.timeoutMs ?? 90_000; // a Solana blockhash lives roughly 60 to 90 seconds, so waiting longer would only produce a transaction that cannot land
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.waiting.delete(id); reject(new SignRequestError('the wallet did not sign in time: nothing was sent')); }, ttl);
            this.waiting.set(id, { id, wallet, message, createdAt: this.now(), expiresAt: this.now() + ttl, resolve, reject, timer });
        });
    }
    pending(wallet) { return [...this.waiting.values()].filter(w => !wallet || w.wallet === wallet).map(({ id, wallet: w, message, createdAt, expiresAt }) => ({ id, wallet: w, message, createdAt, expiresAt })); }
    /** Deliver the wallet's signature for request `id`. Throws, and keeps the request open, if the signature does not verify. */
    submit(id, signature) {
        const w = this.waiting.get(id);
        if (!w)
            throw new SignRequestError('unknown or expired signing request');
        if (signature.length !== 64 || !verifySignature(w.wallet, w.message, signature))
            throw new SignRequestError(`the signature does not match this transaction for wallet ${base58(new Uint8Array(0)) || ''}${w.wallet.slice(0, 6)}...: the wallet may have changed the transaction`);
        clearTimeout(w.timer);
        this.waiting.delete(id);
        w.resolve(signature);
    }
    /** The user declined in the wallet. */
    reject(id, why = 'the wallet declined to sign: nothing was sent') { const w = this.waiting.get(id); if (!w)
        return; clearTimeout(w.timer); this.waiting.delete(id); w.reject(new SignRequestError(why)); }
    cancelAll(why = 'wallet disconnected: nothing was sent') { for (const id of [...this.waiting.keys()])
        this.reject(id, why); }
}
