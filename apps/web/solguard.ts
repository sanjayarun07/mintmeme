/** LIMITS AND CONFIRMATION FOR REAL-FUNDS SOLANA TRADES. Pure logic, no network, so it can be tested on its own.
 *  Every trade goes through two steps: `prepare` checks the limits and records a short-lived, one-time ticket; `confirm` redeems it. Nothing is signed before a ticket is redeemed.
 *  A kill switch refuses new tickets and new confirmations. Limits live in the environment (see .env.example) and default to small amounts. */
import { randomUUID } from 'node:crypto';

export interface Limits { maxTradeLamports: bigint; dailyCapLamports: bigint; maxSlippageBps: number; ticketTtlMs: number }
export const DEFAULT_LIMITS: Limits = { maxTradeLamports: 10_000_000n, dailyCapLamports: 50_000_000n, maxSlippageBps: 500, ticketTtlMs: 60_000 };   // 0.01 SOL per trade, 0.05 SOL per UTC day, 5%, 60 s

export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  const big = (k: string, d: bigint) => { const v = env[k]; if (v === undefined || v === '') return d; if (!/^\d+$/.test(v)) throw new Error(`${k} must be a whole number of lamports`); return BigInt(v); };
  const num = (k: string, d: number, max: number) => { const v = env[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${k} must be a whole number from 0 to ${max}`); return n; };
  const l: Limits = { maxTradeLamports: big('SOL_MAX_TRADE_LAMPORTS', DEFAULT_LIMITS.maxTradeLamports), dailyCapLamports: big('SOL_DAILY_CAP_LAMPORTS', DEFAULT_LIMITS.dailyCapLamports), maxSlippageBps: num('SOL_MAX_SLIPPAGE_BPS', DEFAULT_LIMITS.maxSlippageBps, 5000), ticketTtlMs: DEFAULT_LIMITS.ticketTtlMs };
  if (l.maxTradeLamports <= 0n || l.dailyCapLamports < l.maxTradeLamports) throw new Error('SOL_DAILY_CAP_LAMPORTS must be at least SOL_MAX_TRADE_LAMPORTS, and both above zero');
  return l;
}

export interface TicketInput { side: 'buy' | 'sell'; mint: string; lamports: bigint; pctBps?: number; slippageBps: number; venue: string; summary: Record<string, unknown> }
export interface Ticket extends TicketInput { id: string; expiresAt: number; used: boolean }
export class GuardError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

export class TradeGuard {
  killed = false; private spent = new Map<string, bigint>(); private tickets = new Map<string, Ticket>();
  constructor(public limits: Limits, private now: () => number = Date.now, private onChange: (s: { killed: boolean; spent: Record<string, string> }) => void = () => {}, init?: { killed?: boolean; spent?: Record<string, string> }) {
    this.killed = !!init?.killed; for (const [k, v] of Object.entries(init?.spent ?? {})) this.spent.set(k, BigInt(v));
  }
  private day() { return new Date(this.now()).toISOString().slice(0, 10); }
  spentToday() { return this.spent.get(this.day()) ?? 0n; }
  snapshot() { return { killed: this.killed, spent: Object.fromEntries([...this.spent].map(([k, v]) => [k, v.toString()])) }; }
  private save() { this.onChange(this.snapshot()); }
  setKill(on: boolean) { this.killed = on; this.save(); }
  /** Check the limits and issue a one-time ticket. A buy counts its SOL against the daily cap when the ticket is CONFIRMED, not when it is prepared. Sells spend no SOL. */
  prepare(t: TicketInput): Ticket {
    if (this.killed) throw new GuardError('the kill switch is on: no new trades', 423);
    const sol = (l: bigint) => `${Number(l) / 1e9} SOL`;   // messages reach the user: SOL and percent, never lamports or bps
    if (t.slippageBps < 0 || t.slippageBps > this.limits.maxSlippageBps) throw new GuardError(`slippage ${t.slippageBps / 100}% is above the limit of ${this.limits.maxSlippageBps / 100}%`);
    if (t.side === 'buy') {
      if (t.lamports <= 0n) throw new GuardError('the amount must be above zero');
      if (t.lamports > this.limits.maxTradeLamports) throw new GuardError(`${sol(t.lamports)} is above the per-trade limit of ${sol(this.limits.maxTradeLamports)}`);
      if (this.spentToday() + t.lamports > this.limits.dailyCapLamports) throw new GuardError(`this would pass the daily cap of ${sol(this.limits.dailyCapLamports)} (already spent today: ${sol(this.spentToday())})`);
    } else if (!(t.pctBps && t.pctBps > 0 && t.pctBps <= 10_000)) throw new GuardError('a sell needs a percentage between 1 and 10000 basis points');
    for (const [id, x] of this.tickets) if (x.used || x.expiresAt < this.now()) this.tickets.delete(id);
    const ticket: Ticket = { ...t, id: randomUUID(), expiresAt: this.now() + this.limits.ticketTtlMs, used: false }; this.tickets.set(ticket.id, ticket); return ticket;
  }
  /** Redeem a ticket exactly once. Re-checks the kill switch and the daily cap at this moment. */
  redeem(id: string): Ticket {
    const t = this.tickets.get(id); if (!t) throw new GuardError('unknown or already used ticket: prepare the trade again', 404);
    if (t.used) throw new GuardError('this ticket was already used', 409);
    if (t.expiresAt < this.now()) { this.tickets.delete(id); throw new GuardError('this ticket expired: prepare the trade again', 410); }
    if (this.killed) throw new GuardError('the kill switch is on: no new trades', 423);
    if (t.side === 'buy') { if (this.spentToday() + t.lamports > this.limits.dailyCapLamports) throw new GuardError('this would pass the daily cap', 400); this.spent.set(this.day(), this.spentToday() + t.lamports); }
    t.used = true; this.save(); return t;
  }
  /** Give back the daily-cap amount of a buy that was refused before anything was sent. */
  refund(t: Ticket) { if (t.side === 'buy') { const left = this.spentToday() - t.lamports; this.spent.set(this.day(), left > 0n ? left : 0n); this.save(); } }   // never below zero (a refund after midnight UTC)
}
