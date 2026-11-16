/** Shared by the practice and real-node terminals: how a BulkRunner (multi-wallet buy or sell) is shown to the page. Plain facts only; no simulated numbers. */
import type { BulkRunner } from '../../packages/core/src/index.ts';

export function bulkView(id: string, r: BulkRunner, o: { token: string; walletName: (w: string) => string }) {
  const sm = r.summary(), sp = (r as any).d.spec, sell = sp.side === 'sell';
  const st = sm.refused ? 'Refused' : sm.done ? 'Finished' : sm.legs.some(l => l.status === 'inflight') ? 'Sending' : sp.mode === 'parallel' ? 'Starting' : 'Working through the wallets one at a time';
  return { id, side: sell ? 'sell' : 'buy', tokenAddr: sp.token, token: o.token, mode: sp.mode ?? 'sequential', slippageBps: sp.slippageBps, maxImpactBps: sp.maxImpactBps ?? null,
    filled: sm.filled, failed: sm.failed, skipped: sm.skipped, open: sm.open, spent: sm.spent, received: sm.received, done: sm.done, refused: sm.refused ?? null, statusText: st, error: r.lastError ?? null,
    legs: sm.legs.map(l => ({ walletId: l.walletId, wallet: o.walletName(l.walletId), amount: l.amount, status: l.status, reason: l.reason ?? null, spent: l.spent ?? null, received: l.received ?? null })) };
}

/** Whole-number percent (like "2.5") to basis points; undefined when blank. Throws a plain message when not a sensible number. */
export function pctToBps(v: unknown, what: string, max = 100): number | undefined {
  if (v === undefined || v === null || v === '') return undefined; const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${what} must be a number between 0 and ${max}`); return Math.round(n * 100);
}
