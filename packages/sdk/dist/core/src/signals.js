const RX = [
    ['evm', /\b0x[a-fA-F0-9]{40}\b/g],
    ['ton', /\b(?:EQ|UQ)[A-Za-z0-9_-]{46}\b/g],
    ['tron', /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g],
    ['solana', /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g],
];
/** Pure extraction of CANDIDATES from untrusted text. Output is data only: cannot change limits, wallets or config. */
export function extract(text) {
    const out = [], seen = new Set();
    for (const [family, rx] of RX)
        for (const m of text.matchAll(rx)) {
            const a = m[0];
            if (seen.has(a))
                continue;
            if (family === 'solana' && (/^T/.test(a) && a.length === 34))
                continue; // tron overlap
            seen.add(a);
            out.push({ family, address: a });
        }
    return out;
}
export class SignalFilter {
    maxAgeS;
    validate;
    seen = new Set();
    constructor(maxAgeS, validate) {
        this.maxAgeS = maxAgeS;
        this.validate = validate;
    }
    /** Returns a trade PREVIEW candidate or a rejection reason. Never trades by itself. */
    process(channel, text, msgTs, now) {
        if (now - msgTs > this.maxAgeS)
            return 'signal too old';
        const res = [];
        for (const c of extract(text)) {
            const key = c.address.toLowerCase();
            if (this.seen.has(key))
                continue;
            const v = this.validate(c);
            if (!v)
                continue; // must exist on target chain before any trade
            this.seen.add(key);
            res.push({ chain: v.chain, address: c.address });
        }
        return res.length ? res : 'no valid new contract';
    }
}
