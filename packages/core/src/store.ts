import type { Intent, TxState, Quote, Fill } from './types.ts';
import type { SimTx } from './simchain.ts';
import { toBackend } from './durable.ts';
import type { Backend, Persist } from './durable.ts';

export interface TxRecord {
  key: string; intent: Intent; state: TxState; history: { state: TxState; note?: string }[];
  quote?: Quote; minOut?: bigint; tx?: SimTx; signature?: string; fill?: Fill; failure?: string;
  resubmits: number; simBlock?: number;
  confirmedBlock?: number;   // block of the receipt the current fill was computed from (reorg detection)
  signDay?: number;
  authDigest?: string;       // digest the policy signer charged; release() must use it (a networked chain's real tx hash differs)          // day bucket charged at signing
}
export const rep = (_: string, v: unknown) => typeof v === 'bigint' ? { $big: v.toString() } : v;
export const rev = (_: string, v: any) => v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v;

/** Durable-state seam. In-memory with snapshot/restore for restart tests; Postgres impl would implement the same surface. */
export class Store {
  records = new Map<string, TxRecord>();
  nonces = new Map<string, number>();
  /** When set, checkpoint() writes the whole state to this file atomically. The engine checkpoints after every step, so a signed tx is on disk BEFORE it is sent. */
  persistPath?: string; backend?: Backend;
  checkpoint() { this.backend?.write(this.snapshot()); }
  /** Open (or create) a file-backed store. */
  static open(p: Persist): Store { const b = toBackend(p); const s = b.read(); const st = s ? Store.restore(s) : new Store(); st.backend = b; if (typeof p === 'string') st.persistPath = p; return st; }
  snapshot() { return JSON.stringify({ r: [...this.records], n: [...this.nonces] }, rep); }
  static restore(s: string) { const o = JSON.parse(s, rev); const st = new Store(); st.records = new Map(o.r); st.nonces = new Map(o.n); return st; }
}
