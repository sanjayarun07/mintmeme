import { toBackend } from './durable.js';
export const rep = (_, v) => typeof v === 'bigint' ? { $big: v.toString() } : v;
export const rev = (_, v) => v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v;
/** Durable-state seam. In-memory with snapshot/restore for restart tests; Postgres impl would implement the same surface. */
export class Store {
    records = new Map();
    nonces = new Map();
    /** When set, checkpoint() writes the whole state to this file atomically. The engine checkpoints after every step, so a signed tx is on disk BEFORE it is sent. */
    persistPath;
    backend;
    checkpoint() { this.backend?.write(this.snapshot()); }
    /** Open (or create) a file-backed store. */
    static open(p) { const b = toBackend(p); const s = b.read(); const st = s ? Store.restore(s) : new Store(); st.backend = b; if (typeof p === 'string')
        st.persistPath = p; return st; }
    snapshot() { return JSON.stringify({ r: [...this.records], n: [...this.nonces] }, rep); }
    static restore(s) { const o = JSON.parse(s, rev); const st = new Store(); st.records = new Map(o.r); st.nonces = new Map(o.n); return st; }
}
