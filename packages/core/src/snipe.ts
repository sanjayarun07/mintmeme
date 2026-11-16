import { NATIVE } from './types.ts';
import type { Intent } from './types.ts';
import type { SimChain } from './simchain.ts';
/** The part of a chain the Sniper reads (sync). SimChain satisfies it; a networked chain supplies a snapshot adapter. */
export interface SnipeView { block: number; time: number; balance(w: string, t: string): bigint; tokens: Pick<SimChain['tokens'], 'get'>; state: { venues: Map<string, import('./types.ts').Venue> } }
import { analyze } from './risk.ts';
import type { TokenFacts, RiskReport } from './risk.ts';
import type { Order } from './orders.ts';

/** LAUNCH SNIPING (bounded, eligibility-respecting).
 *  Design rules enforced here:
 *   - participates only once trading is enabled (chain tokenBehavior.tradingOpenBlock reached AND any trading-enabled event openBlock reached); never tries to bypass restrictions
 *   - at most `maxAttempts` buys, at most one in flight, at most one per block, total committed spend never exceeds maxSpend, slippage never widened
 *   - no mempool inspection / no front- or back-running / no sandwich logic: decisions use only confirmed launch events and current chain state
 *   - runs the risk analyzer (buy+sell simulation) as a pre-trade check; a passing check is NOT a safety certification */

export type LaunchEventType = 'pool-created' | 'liquidity-added' | 'trading-enabled' | 'curve-created' | 'graduated';
export interface LaunchEvent {
  type: LaunchEventType; chain: string; token: string; txHash: string; logIndex: number; block: number;
  venueId?: string;           // pool-created / curve-created: the venue; liquidity-added: pool id
  quoteLiquidity?: bigint;    // liquidity-added / pool-created: quote-side liquidity added
  openBlock?: number;         // trading-enabled: first block in which trading is permitted
  successor?: string;         // graduated: successor venue id
}
export interface Launch {
  key: string; chain: string; token: string; kind: 'pool' | 'curve' | 'unknown'; venueId?: string; venueHistory: string[];
  status: 'detected' | 'tradable' | 'graduated' | 'revoked'; eventLiquidity: bigint; tradingOpenBlock?: number; tradingEnabledSeen: boolean;
  detectedBlock: number; tradableSinceBlock?: number; graduatedTo?: string; events: LaunchEvent[];
}
const evId = (e: LaunchEvent) => `${e.chain}:${e.txHash}:${e.logIndex}:${e.type}`;

export class LaunchDetector {
  private evs = new Map<string, LaunchEvent[]>(); private seen = new Set<string>(); private revokedTx = new Set<string>();
  log: { id: string; decision: string }[] = [];
  constructor(private opts: { requireTradingEnabledEvent?: boolean } = {}) {}
  snapshot() { return { evs: [...this.evs], seen: [...this.seen], revokedTx: [...this.revokedTx], log: this.log }; }
  load(s: ReturnType<LaunchDetector['snapshot']>) { this.evs = new Map(s.evs); this.seen = new Set(s.seen); this.revokedTx = new Set(s.revokedTx); this.log = s.log; }

  /** Idempotent: duplicates (same chain/tx/log/type, any provider) and events from revoked txs are ignored. Returns the updated launch, or undefined if ignored. */
  onEvent(e: LaunchEvent): Launch | undefined {
    const id = evId(e);
    if (this.seen.has(id)) { this.log.push({ id, decision: 'duplicate' }); return undefined; }
    if (this.revokedTx.has(`${e.chain}:${e.txHash}`)) { this.log.push({ id, decision: 'from reorged tx' }); return undefined; }
    this.seen.add(id);
    const k = `${e.chain}:${e.token}`; const list = this.evs.get(k) ?? []; list.push(e); this.evs.set(k, list);
    this.log.push({ id, decision: 'accepted' });
    return this.get(e.chain, e.token);
  }
  /** Reorg: every event of this tx is revoked and launch state is recomputed from the surviving events. */
  revoke(chain: string, txHash: string): Launch[] {
    this.revokedTx.add(`${chain}:${txHash}`); const out: Launch[] = [];
    for (const [k, list] of this.evs) {
      const keep = list.filter(e => !(e.chain === chain && e.txHash === txHash));
      if (keep.length !== list.length) { this.evs.set(k, keep); const [c, ...t] = k.split(':'); out.push(this.get(c, t.join(':'))!); }
    }
    return out;
  }
  /** Every launch the detector knows (one per chain+token). */
  launches(): Launch[] { return [...this.evs.keys()].map(k => { const [c, ...t] = k.split(':'); return this.get(c, t.join(':'))!; }); }
  get(chain: string, token: string): Launch | undefined {
    const list = this.evs.get(`${chain}:${token}`); if (!list) return undefined;
    const evs = [...list].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const L: Launch = { key: `${chain}:${token}`, chain, token, kind: 'unknown', venueHistory: [], status: 'revoked', eventLiquidity: 0n, tradingEnabledSeen: false,
      detectedBlock: evs[0]?.block ?? 0, events: evs };
    let created = false; const blocks: number[] = [];
    for (const e of evs) {
      if (e.type === 'pool-created' || e.type === 'curve-created') {
        created = true; L.kind = e.type === 'pool-created' ? 'pool' : 'curve'; blocks.push(e.block);
        if (e.venueId) this.setVenue(L, e.venueId);
        if (e.quoteLiquidity) L.eventLiquidity += e.quoteLiquidity;
      } else if (e.type === 'liquidity-added') {
        L.eventLiquidity += e.quoteLiquidity ?? 0n; blocks.push(e.block); if (e.venueId && !L.venueId) this.setVenue(L, e.venueId);
        if (L.kind === 'unknown') L.kind = 'pool';
      } else if (e.type === 'trading-enabled') {
        L.tradingEnabledSeen = true; L.tradingOpenBlock = e.openBlock ?? e.block; blocks.push(L.tradingOpenBlock);
      } else if (e.type === 'graduated') {
        // token identity is unchanged; only the venue id moves to the successor
        if (e.successor) { this.setVenue(L, e.successor); L.graduatedTo = e.successor; }
        L.status = 'graduated';
      }
    }
    if (!evs.length) return L;
    const liquidOrCurve = L.kind === 'curve' || L.eventLiquidity > 0n || L.graduatedTo !== undefined;
    const gate = !this.opts.requireTradingEnabledEvent || L.tradingEnabledSeen || L.kind === 'curve';
    if (L.graduatedTo) { L.status = 'graduated'; L.tradableSinceBlock = Math.max(...blocks, 0); }
    else if ((created || L.venueId) && liquidOrCurve && gate) { L.status = 'tradable'; L.tradableSinceBlock = Math.max(...blocks); }
    else L.status = created || L.venueId || L.tradingEnabledSeen ? 'detected' : 'revoked';
    return L;
  }
  private setVenue(L: Launch, v: string) { if (L.venueId !== v) { L.venueId = v; if (!L.venueHistory.includes(v)) L.venueHistory.push(v); } }
}

/** Carry open orders over a graduation: same order ids, same reservations, same token; only the venue allow-list gains the successor. */
export function migrateOrders(orders: Iterable<Order>, token: string, fromVenue: string, toVenue: string): string[] {
  const moved: string[] = [];
  for (const o of orders) {
    if (o.token !== token || (o.status !== 'active' && o.status !== 'disabled')) continue;
    if (!o.venues.includes(fromVenue) && !o.venues.includes(toVenue)) continue;
    o.venues = [...new Set([...o.venues.filter(v => v !== fromVenue), toVenue])]; moved.push(o.id);
  }
  return moved;
}

export interface ExitRules {
  takeProfitBps?: number;          // sell when price >= entry * (1 + tp)
  stopLossBps?: number;            // sell when price <= entry * (1 - sl)
  trailingStopBps?: number;        // optional separate trailing stop (not in the OCO group)
  ttlS?: number; minLiquidity?: bigint; maxDeviationBps?: number; maxQuoteAgeMs?: number; maxAttempts?: number;
}
export interface SnipeConfig {
  userId: string; walletId: string; chain: string; quoteToken: string; venues: string[];
  maxSpend: bigint;                // hard cap on TOTAL committed spend per launch
  delayBlocks: number;             // wait this many blocks after the launch becomes tradable
  minLiquidity: bigint; maxLiquidity?: bigint;
  maxValuation?: bigint;           // quote units; effective price * totalSupply. Needs totalSupply, else rejected as unverifiable
  totalSupply?: bigint;
  maxTaxBps: number;               // applies to measured buy and sell tax
  maxAttempts: number;             // hard bound on buy attempts per launch
  slippageBps: number;             // fixed for all attempts, never widened
  maxSlippageBps?: number;         // safety ceiling (default 1000)
  maxFeeBps?: number; deadlineS?: number;
  rejectVerdicts?: RiskReport['verdict'][];   // default ['blocked','quarantined']
  blockedTokens?: string[];
  exit?: ExitRules;
  /** Pre-trade risk check. Default: simulated buy+sell through a SimChain. A networked chain MUST supply one (its report may say what it could not check). */
  riskCheck?: (launch: Launch, amount: bigint, facts: TokenFacts) => RiskReport;
}
export interface SnipeLimits { maxWalletTokens?: bigint }
export interface SnipeAttempt { n: number; key: string; amount: bigint; block: number; status: 'inflight' | 'filled' | 'failed' }
export interface SnipeState { attempts: SnipeAttempt[]; committed: bigint; filledSpend: bigint; filledTokens: bigint; done: boolean }
export type SnipeDecision =
  | { ok: true; intent: Intent; attempt: number; risk: RiskReport; block: number }
  | { ok: false; reason: string; code: string; risk?: RiskReport; block: number };

export class Sniper {
  states = new Map<string, SnipeState>();
  constructor(public chain: SnipeView, public cfg: SnipeConfig) {}
  snapshot() { return { states: [...this.states] }; }
  load(s: ReturnType<Sniper['snapshot']>) { this.states = new Map(s.states); }
  state(key: string): SnipeState { let s = this.states.get(key); if (!s) { s = { attempts: [], committed: 0n, filledSpend: 0n, filledTokens: 0n, done: false }; this.states.set(key, s); } return s; }

  /** Decide whether to buy now. Returns an Intent (and records the attempt as in flight) or a rejection reason. Pure w.r.t. the chain (simulation only). */
  decide(launch: Launch | undefined, facts: TokenFacts, limits: SnipeLimits = {}): SnipeDecision {
    const { chain, cfg } = this; const block = chain.block;
    const no = (code: string, reason: string, risk?: RiskReport): SnipeDecision => ({ ok: false, code, reason, risk, block });
    if (!launch) return no('no-launch', 'no launch detected for token');
    if (launch.chain !== cfg.chain) return no('wrong-chain', 'launch is on a different chain than the configured wallet');
    if (cfg.blockedTokens?.includes(launch.token)) return no('blocked-token', 'token is on the block list');
    if (launch.status === 'revoked') return no('revoked', 'launch events were reorged out');
    if (launch.status === 'detected') return no('not-tradable', 'launch not yet liquid/enabled');
    if (!launch.venueId) return no('no-venue', 'no venue known for launch');
    const st = this.state(launch.key);
    if (st.done) return no('done', 'position already filled for this launch');
    if (st.attempts.some(a => a.status === 'inflight')) return no('inflight', 'an attempt is already in flight');
    if (st.attempts.length >= cfg.maxAttempts) return no('attempts-exhausted', `max ${cfg.maxAttempts} attempts used`);
    if (st.attempts.length && st.attempts[st.attempts.length - 1].block >= block) return no('rate-limited', 'at most one attempt per block');
    const remaining = cfg.maxSpend - st.committed;
    if (remaining <= 0n) return no('budget', 'maxSpend fully committed');
    if (cfg.slippageBps > (cfg.maxSlippageBps ?? 1000)) return no('slippage-config', 'configured slippage above safety ceiling');
    // --- eligibility: trading must be OPEN. We never route around a restriction.
    const openChain = chain.tokens.get(launch.token)?.tradingOpenBlock;
    const open = Math.max(openChain ?? 0, launch.tradingOpenBlock ?? 0);
    if (open && block < open) return no('trading-not-open', `trading enabled from block ${open}; current block ${block}`);
    const since = Math.max(launch.tradableSinceBlock ?? 0, open);
    if (block < since + cfg.delayBlocks) return no('delay', `waiting ${since + cfg.delayBlocks - block} more block(s) (delayBlocks=${cfg.delayBlocks})`);
    const venue = chain.state.venues.get(launch.venueId);
    if (!venue || venue.status !== 'active') return no('venue-unavailable', `venue ${launch.venueId} not active`);
    const amount = remaining < cfg.maxSpend ? remaining : cfg.maxSpend;
    // --- market checks
    const q = venue.quote(cfg.quoteToken, launch.token, amount);
    if (q.liquidity < cfg.minLiquidity) return no('liquidity-low', `liquidity ${q.liquidity} < min ${cfg.minLiquidity}`);
    if (cfg.maxLiquidity !== undefined && q.liquidity > cfg.maxLiquidity) return no('liquidity-high', `liquidity ${q.liquidity} > max ${cfg.maxLiquidity}`);
    if (q.amountOut <= 0n) return no('no-output', 'quote returns zero tokens');
    if (cfg.maxValuation !== undefined) {
      if (!cfg.totalSupply) return no('valuation-unverifiable', 'maxValuation set but totalSupply unknown');
      const val = amount * cfg.totalSupply / q.amountOut;   // effective price (incl. impact/fee) x supply, conservative
      if (val > cfg.maxValuation) return no('valuation-high', `valuation ${val} > max ${cfg.maxValuation}`);
    }
    if (limits.maxWalletTokens !== undefined && chain.balance(cfg.walletId, launch.token) + q.amountOut > limits.maxWalletTokens)
      return no('max-wallet', `buy would exceed max wallet limit ${limits.maxWalletTokens}`);
    const maxTx = chain.tokens.get(launch.token)?.maxTxAmount;
    if (maxTx !== undefined && q.amountOut > maxTx) return no('max-tx', `expected holding ${q.amountOut} exceeds max tx ${maxTx}: could not exit in one sell`);
    // --- pre-trade risk analysis (buy + sell simulation through the chain)
    const risk = cfg.riskCheck ? cfg.riskCheck(launch, amount, { ...facts, address: launch.token }) : analyze(chain as SimChain, { ...facts, address: launch.token }, { wallet: cfg.walletId, quoteToken: cfg.quoteToken, venue: launch.venueId, amount });
    if ((cfg.rejectVerdicts ?? ['blocked', 'quarantined']).includes(risk.verdict)) return no('risk', `risk verdict ${risk.verdict}: ${risk.flags.join('; ')}`, risk);
    if ((risk.buyTaxBps ?? 0) > cfg.maxTaxBps || (risk.sellTaxBps ?? 0) > cfg.maxTaxBps)
      return no('tax', `tax buy ${risk.buyTaxBps} / sell ${risk.sellTaxBps} bps exceeds max ${cfg.maxTaxBps}`, risk);
    // --- commit
    const n = st.attempts.length + 1; const key = `snipe:${cfg.walletId}:${launch.key}:a${n}`;
    st.attempts.push({ n, key, amount, block, status: 'inflight' }); st.committed += amount;
    const intent: Intent = { idempotencyKey: key, userId: cfg.userId, walletId: cfg.walletId, chain: cfg.chain, tokenIn: cfg.quoteToken, tokenOut: launch.token,
      amountIn: amount, minOut: 0n, slippageBps: cfg.slippageBps, deadline: chain.time + (cfg.deadlineS ?? 60), maxFeeBps: cfg.maxFeeBps ?? 200, venues: cfg.venues, origin: 'snipe' };
    return { ok: true, intent, attempt: n, risk, block };
  }

  /** Execution outcome. Failure releases the committed budget (a reverted buy spends only gas) but the ATTEMPT stays counted. */
  report(launchKey: string, idempotencyKey: string, res: { ok: true; tokens: bigint; spent: bigint } | { ok: false }) {
    const st = this.state(launchKey); const a = st.attempts.find(x => x.key === idempotencyKey); if (!a || a.status !== 'inflight') return;
    if (res.ok) { a.status = 'filled'; st.done = true; st.filledSpend += res.spent; st.filledTokens += res.tokens; st.committed = st.committed - a.amount + res.spent; }
    else { a.status = 'failed'; st.committed -= a.amount; }
  }
}

const E18 = 10n ** 18n;
/** Post-buy exits as OrderManager-compatible descriptors (caller passes them to OrderManager.place). TP and SL share an OCO group => one reservation, one leg fires. */
export function exitOrders(cfg: SnipeConfig, launch: Pick<Launch, 'key' | 'token'>, fill: { tokens: bigint; quoteSpent: bigint }, nowS: number): Order[] {
  const r = cfg.exit; if (!r || fill.tokens <= 0n) return [];
  const entry = fill.quoteSpent * E18 / fill.tokens;       // effective entry price incl. fees/tax
  const base = (id: string, kind: Order['kind']): Order => ({ id: `snipe:${launch.key}:${id}`, userId: cfg.userId, walletId: cfg.walletId, chain: cfg.chain, token: launch.token,
    quoteToken: cfg.quoteToken, kind, amount: fill.tokens, expiresAt: nowS + (r.ttlS ?? 86_400), maxQuoteAgeMs: r.maxQuoteAgeMs ?? 5_000, minLiquidity: r.minLiquidity ?? cfg.minLiquidity,
    maxDeviationBps: r.maxDeviationBps ?? 1_000, maxAttempts: r.maxAttempts ?? 3, slippageBps: cfg.slippageBps, venues: cfg.venues, status: 'active', attempts: 0 });
  const out: Order[] = []; const oco = `snipe:${launch.key}:oco`;
  if (r.takeProfitBps !== undefined) out.push({ ...base('tp', 'take_profit'), triggerPriceE18: entry * BigInt(10_000 + r.takeProfitBps) / 10_000n, ocoGroup: (r.stopLossBps !== undefined ? oco : undefined) });
  if (r.stopLossBps !== undefined) out.push({ ...base('sl', 'stop_loss'), triggerPriceE18: entry * BigInt(Math.max(0, 10_000 - r.stopLossBps)) / 10_000n, ocoGroup: (r.takeProfitBps !== undefined ? oco : undefined) });
  if (r.trailingStopBps !== undefined) out.push({ ...base('trail', 'trailing_stop'), trailBps: r.trailingStopBps });
  return out;
}

export interface LaunchSimulation {
  token: string; venue: string; block: number; time: number; tradingOpenBlock?: number; restrictedBlocksRemaining: number;
  buy: { feasible: boolean; reason?: string; tokensOut?: bigint; taxBps?: number; priceImpactBps?: number };
  sell: { feasible: boolean; reason?: string; quoteOut?: bigint; taxBps?: number };
  maxTxAmount?: bigint; maxTxBlocksExit?: boolean; limitations: string[];
}
/** Dry-run of a buy and the round-trip sell on a throwaway wallet, at the current chain state. Reports taxes (from balance deltas), max tx limit and restricted blocks. */
export function simulateLaunch(chain: SimChain, p: { token: string; venue: string; quoteToken?: string; amount: bigint }): LaunchSimulation {
  const quote = p.quoteToken ?? NATIVE; const w = '__launch-sim__'; const beh = chain.tokens.get(p.token);
  const venue = chain.state.venues.get(p.venue);
  const out: LaunchSimulation = { token: p.token, venue: p.venue, block: chain.block, time: chain.time, tradingOpenBlock: beh?.tradingOpenBlock,
    restrictedBlocksRemaining: Math.max(0, (beh?.tradingOpenBlock ?? 0) - (chain.block + 1)), buy: { feasible: false }, sell: { feasible: false }, maxTxAmount: beh?.maxTxAmount,
    limitations: ['simulated at current head state; the real tx lands in a later block and state (price, limits, taxes, owner settings) can change',
      'throwaway funded wallet: does not reflect the real wallet balance, allowances or per-wallet limits (max wallet is not modeled by the chain fixture)',
      'taxes measured from balance deltas of one buy/sell at this size; dynamic or time-varying taxes, blacklists added later, and honeypot logic keyed on wallet/size are not detected',
      'fixture chain gates BUYS by tradingOpenBlock only; real tokens may restrict sells/transfers differently',
      'sell is simulated against the pre-buy venue state (simulate() does not persist the buy), so sell output is optimistic for pools and may be zero on an empty curve',
      'a passing simulation is not a safety certification'] };
  if (!venue) { out.buy.reason = 'venue not found'; out.sell.reason = 'venue not found'; return out; }
  const fund = (t: string, a: bigint) => chain.credit(w, t, a);
  const cleanup = () => { for (const k of [...chain.state.bal.keys()]) if (k.startsWith(w + ':')) chain.state.bal.delete(k); };
  const mk = (tin: string, tout: string, amt: bigint) => ({ hash: 'launch-sim', wallet: w, nonce: chain.confirmedNonce(w), venue: p.venue, tokenIn: tin, tokenOut: tout, amountIn: amt, minOut: 0n, deadline: chain.time + 60, platformFeeBps: 0 });
  try {
    fund(NATIVE, chain.gasFee * 3n); if (quote !== NATIVE) fund(quote, p.amount); else fund(NATIVE, p.amount);
    const buy = chain.simulate(mk(quote, p.token, p.amount));
    if (buy.receipt.status === 'reverted') {
      out.buy.reason = buy.receipt.reason; out.sell.reason = 'not evaluated: cannot acquire tokens';
      if (buy.receipt.reason === 'trading not enabled') out.limitations.push(`trading not enabled before block ${beh?.tradingOpenBlock}; sniper must wait, not bypass`);
      return out;
    }
    const got = buy.receipt.deltas[p.token] ?? 0n; const ideal = venue.quote(quote, p.token, p.amount);
    out.buy = { feasible: true, tokensOut: got, taxBps: ideal.amountOut === 0n ? 0 : Number((ideal.amountOut - got) * 10_000n / ideal.amountOut), priceImpactBps: ideal.priceImpactBps };
    if (beh?.maxTxAmount !== undefined) out.maxTxBlocksExit = got > beh.maxTxAmount;
    fund(p.token, got);
    const sell = chain.simulate(mk(p.token, quote, got));
    if (sell.receipt.status === 'reverted') { out.sell.reason = sell.receipt.reason; return out; }
    const recv = (sell.receipt.deltas[quote] ?? 0n) + (quote === NATIVE ? sell.receipt.network : 0n); const sq = venue.quote(p.token, quote, got).amountOut;
    if (recv <= 0n) { out.sell.reason = 'sell returns zero quote (pool/curve state not advanced by the simulated buy)'; return out; }
    out.sell = { feasible: true, quoteOut: recv, taxBps: sq === 0n ? 0 : Number((sq - recv) * 10_000n / sq) };
    return out;
  } finally { cleanup(); }
}
