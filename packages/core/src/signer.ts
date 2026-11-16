import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Origin } from './types.ts';

export interface WalletPolicy {
  userId: string; chains: string[]; allowedVenues: string[]; maxPerTx: Record<string, bigint>;
  dailyLimit: Record<string, bigint>; destinations: string[]; automationRevoked?: boolean;
  deviceSecret: string;   // user's separate secure-confirmation device key (NOT the Telegram session)
}
export interface SignRequest {
  userId: string; walletId: string; chain: string; kind: 'swap' | 'transfer' | 'noop' | 'approve'; token: string; amount: bigint;
  venue?: string; to?: string; digest: string; origin: Origin; approval?: string; day: number;
}
/** Optional persistence seam for the spend ledger (survives signer restart). Values are opaque strings. */
export interface SpentLedger { get(key: string): string | undefined; set(key: string, value: string): void }
export class MemoryLedger implements SpentLedger {
  m = new Map<string, string>();
  get(k: string) { return this.m.get(k); }
  set(k: string, v: string) { this.m.set(k, v); }
  snapshot() { return JSON.stringify([...this.m]); }
  static restore(s: string) { const l = new MemoryLedger(); l.m = new Map(JSON.parse(s)); return l; }
}
export class PolicyRejection extends Error {}
export interface AuditEntry { at: number; walletId: string; kind: string; decision: 'allow' | 'deny'; reason: string; digest: string }

/** Isolated signer (in-process stand-in for HSM/MPC service). Holds keys; callers get only signatures. Audits every decision. */
export class PolicySigner {
  audit: AuditEntry[] = [];
  /**
   * Spend accounting (daily limit): `sign` CHARGES amount against (wallet, token, day), idempotently per digest
   * (re-signing the same digest never double-charges). `release(digest)` refunds a charge and must be called ONLY when the
   * tx can never be included (rejected / expired-and-absent / nonce consumed by another tx / cancelled-replaced).
   * A charge is KEPT once the tx was included, even if it reverted: a reverted tx spent gas and its outcome was
   * economically attempted, so we stay conservative (fail-closed) rather than refunding on revert.
   * Ledger writes order: charge = spent then marker; release = marker tombstone then spent. A crash between the two
   * writes can only leave the daily counter too HIGH (fail-closed), never too low.
   */
  constructor(private keys: Map<string, string>, private policies: Map<string, WalletPolicy>, private ledger: SpentLedger = new MemoryLedger()) {}
  private spentOf(dk: string) { const v = this.ledger.get('spent:' + dk); return v ? BigInt(v) : 0n; }
  private chargeOf(digest: string): { dk: string; amount: bigint; day: number } | undefined {
    const v = this.ledger.get('charge:' + digest); if (!v) return undefined;
    const o = JSON.parse(v); return { dk: o.dk, amount: BigInt(o.amount), day: o.day };
  }
  spentFor(walletId: string, token: string, day: number) { return this.spentOf(`${walletId}:${token}:${day}`); }
  /** Refund the daily-limit charge of a tx that can never be included. Returns false if nothing (more) to release. */
  release(digest: string): boolean {
    const c = this.chargeOf(digest); if (!c) return false;
    this.ledger.set('charge:' + digest, '');
    this.ledger.set('spent:' + c.dk, (this.spentOf(c.dk) - c.amount).toString());
    this.audit.push({ at: c.day, walletId: c.dk.split(':')[0], kind: 'release', decision: 'allow', reason: 'charge released (tx never included)', digest });
    return true;
  }
  static approve(deviceSecret: string, digest: string) { return createHmac('sha256', deviceSecret).update('approve:' + digest).digest('hex'); }
  revokeAutomation(walletId: string) { const p = this.policies.get(walletId); if (p) p.automationRevoked = true; }

  sign(r: SignRequest): string {
    const deny = (reason: string): never => { this.audit.push({ at: r.day, walletId: r.walletId, kind: r.kind, decision: 'deny', reason, digest: r.digest }); throw new PolicyRejection(reason); };
    const p = this.policies.get(r.walletId), key = this.keys.get(r.walletId);
    if (!p || !key) return deny('unknown wallet');
    if (p.userId !== r.userId) return deny('wallet belongs to another user');       // tenant isolation
    if (!p.chains.includes(r.chain)) return deny('chain not allowed');
    if (r.kind === 'noop') {
      // Nonce-consuming housekeeping (cancel/replace): moves no value, so no venue/limit/automation checks and no charge. Gas only.
      this.audit.push({ at: r.day, walletId: r.walletId, kind: r.kind, decision: 'allow', reason: 'noop nonce replacement', digest: r.digest });
      return createHmac('sha256', key).update(r.digest).digest('hex');
    }
    if (r.kind === 'approve') {
      // Token allowance for a venue router: grants the venue the right to pull `amount` (exact, never unlimited). Same venue/automation/per-tx rules as the swap it enables;
      // NOT charged to the daily limit (the swap itself is), so approve+swap never counts twice.
      if (p.automationRevoked && r.origin !== 'manual') return deny('automation revoked');
      if (!r.venue || !p.allowedVenues.includes(r.venue)) return deny('venue not allowed');
      const cap = p.maxPerTx[r.token]; if (cap === undefined || r.amount > cap) return deny('exceeds per-tx limit');
      this.audit.push({ at: r.day, walletId: r.walletId, kind: r.kind, decision: 'allow', reason: 'approval within per-tx limit (not charged to daily limit)', digest: r.digest });
      return createHmac('sha256', key).update(r.digest).digest('hex');
    }
    if (r.kind === 'swap') {
      if (p.automationRevoked && r.origin !== 'manual') return deny('automation revoked');
      if (!r.venue || !p.allowedVenues.includes(r.venue)) return deny('venue not allowed');
    } else {
      // Transfers/withdrawals: destination allowlist AND out-of-band approval from user's device key. Telegram origin alone never suffices.
      if (!r.to || !p.destinations.includes(r.to)) return deny('destination not allowlisted');
      const ok = r.approval && safeEq(r.approval, PolicySigner.approve(p.deviceSecret, r.digest));
      if (!ok) return deny('missing or invalid secure confirmation');
    }
    const max = p.maxPerTx[r.token]; if (max === undefined || r.amount > max) return deny('exceeds per-tx limit');
    const dk = `${r.walletId}:${r.token}:${r.day}`, used = this.spentOf(dk), lim = p.dailyLimit[r.token];
    const prior = this.chargeOf(r.digest);
    if (!prior) {
      if (lim === undefined || used + r.amount > lim) return deny('exceeds daily limit');
      this.ledger.set('spent:' + dk, (used + r.amount).toString());
      this.ledger.set('charge:' + r.digest, JSON.stringify({ dk, amount: r.amount.toString(), day: r.day }));
    }
    this.audit.push({ at: r.day, walletId: r.walletId, kind: r.kind, decision: 'allow', reason: 'policy ok', digest: r.digest });
    return createHmac('sha256', key).update(r.digest).digest('hex');
  }
}
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
