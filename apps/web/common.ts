import { NATIVE } from '../../packages/core/src/index.ts';

// ---------- plain-language failure explanations ----------
export function explain(reason = '', sent = false): { title: string; why: string; fix: string } {
  const r = reason.toLowerCase();
  if (r.includes('minout') || r.includes('insufficient output')) return { title: 'Price moved past your limit', why: 'The price changed by more than your slippage setting (or the token takes a fee), so the trade was stopped before it filled. ' + (sent ? 'It was sent, so you paid the network fee but nothing else.' : 'It was stopped in a pre-check, so nothing was sent and nothing was spent.'), fix: 'Try again with a smaller amount, or raise slippage if you accept a worse price. Slippage is never raised for you.' };
  if (r.includes('transfer blocked')) return { title: 'This token cannot be sold', why: 'A test sale was blocked by the token itself. This is the classic "honeypot" pattern.', fix: 'Do not buy this token. Check the safety report before trading.' };
  if (r.includes('trading not enabled')) return { title: 'Trading is not open yet', why: 'The token exists but its trading has not been switched on.', fix: 'Wait for the open block shown in the Launch sniper page, then try again.' };
  if (r.includes('daily limit')) return { title: 'Daily spending limit reached', why: 'This wallet has used its daily allowance set by its signing policy.', fix: 'Wait until tomorrow or lower the amount. Limits can only be raised by you in wallet settings.' };
  if (r.includes('per-tx limit')) return { title: 'Amount above the per-trade limit', why: 'This wallet is limited in how much it can spend in one trade.', fix: 'Reduce the amount or split it into smaller trades.' };
  if (r.includes('automation revoked')) return { title: 'Automation is paused', why: 'Automatic strategies are switched off for this wallet, so the trade was not signed.', fix: 'Turn automation back on in Wallets, or trade manually.' };
  if (r.includes('insufficient balance') || r.includes('insufficient gas')) return { title: 'Not enough balance', why: 'The wallet does not hold enough to cover the amount plus the network fee.', fix: 'Lower the amount or add funds to the wallet.' };
  if (r.includes('deadline')) return { title: 'Trade expired', why: 'It was not included in time, so it was dropped and nothing was spent.', fix: 'Submit it again.' };
  if (r.includes('no authorized direct route')) return { title: 'No trading route found', why: 'None of your allowed venues has a pool for this pair.', fix: 'Check the token address.' };
  return { title: 'Trade did not complete', why: reason || 'Unknown reason.', fix: 'Open Activity for the technical details.' };
}
export const STAGE: Record<string, string> = { created: 'preparing', validated: 'preparing', quoted: 'preparing', simulated: 'preparing', awaiting_authorization: 'preparing', signed: 'preparing',
  submitted: 'sent', observed: 'sent', confirmed: 'confirmed', finalized: 'final', failed: 'failed', expired: 'expired', unresolved: 'checking' };


/** Shared by the simulated and the real-node terminal: turns an engine record into what the UI shows. `symOf` maps a token id to its ticker. */
export const makeTxView = (symOf: (t: string) => string | undefined) => (r: any) => {
  const i = r.intent, sell = i.tokenIn !== NATIVE, token = sell ? i.tokenIn : i.tokenOut, stage = STAGE[r.state];
  const sentOnChain = r.history.some((h: any) => h.state === 'submitted'); const ex = r.state === 'failed' || r.state === 'expired' ? explain(r.failure || r.history.at(-1)?.note, sentOnChain) : undefined;
  const sym = symOf(token) ?? token;
  const headline = stage === 'final' ? `${sell ? 'Sold' : 'Bought'} ${sym}` : stage === 'confirmed' ? `${sell ? 'Sell' : 'Buy'} ${sym} confirmed, waiting for final` : stage === 'sent' ? `${sell ? 'Sell' : 'Buy'} ${sym} sent, waiting for the network` : stage === 'failed' ? `${sell ? 'Sell' : 'Buy'} ${sym} failed` : stage === 'expired' ? `${sell ? 'Sell' : 'Buy'} ${sym} expired` : stage === 'checking' ? `Checking ${sym} ${sell ? 'sell' : 'buy'} status` : `Preparing ${sell ? 'sell' : 'buy'} of ${sym}`;
  return { key: r.key, side: sell ? 'sell' : 'buy', token, sym, origin: i.origin, wallet: i.walletId, amountIn: i.amountIn, stage, state: r.state, headline, fill: r.fill, explain: ex,
    history: r.history, venue: r.quote?.venue, quoteBlock: r.quote?.block, minOut: r.minOut, quotedOut: r.quote?.amountOut, raw: r.failure };
};
