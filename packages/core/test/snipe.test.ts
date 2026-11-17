import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './fixtures.ts';
import { NATIVE, CpAmm, LinearCurve, Reservations, OrderManager } from '../src/index.ts';
import { LaunchDetector, Sniper, exitOrders, simulateLaunch, migrateOrders } from '../src/snipe.ts';
import type { LaunchEvent, SnipeConfig } from '../src/snipe.ts';

const E18 = 10n ** 18n;
const J = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v);
const NEW = '0xNEWCOIN';
let ix = 0;
const ev = (o: Partial<LaunchEvent>): LaunchEvent => ({ type: 'pool-created', chain: 'sim-evm', token: NEW, txHash: '0xt' + ix, logIndex: ix++, block: 100, ...o });
const cfg = (o: Partial<SnipeConfig> = {}): SnipeConfig => ({ userId: 'u1', walletId: 'w1', chain: 'sim-evm', quoteToken: NATIVE, venues: ['uniswap-v2'], maxSpend: 10_000n, delayBlocks: 1,
  minLiquidity: 100_000n, maxTaxBps: 500, maxAttempts: 3, slippageBps: 300, exit: { takeProfitBps: 10_000, stopLossBps: 3_000, minLiquidity: 1n }, ...o });
function launchWorld(open = 103, tax?: { buy?: number; sell?: number }) {
  const w = world();
  w.chain.addVenue(new CpAmm('uni-v2:NEW', 'uniswap-v2', NEW, NATIVE, 1_000_000n, 1_000_000n));
  w.chain.tokens.set(NEW, { tradingOpenBlock: open, buyTaxBps: tax?.buy, sellTaxBps: tax?.sell });
  w.policies.get('w1')!.maxPerTx[NEW] = 10_000_000n; w.policies.get('w1')!.dailyLimit[NEW] = 10_000_000n;
  const det = new LaunchDetector();
  det.onEvent(ev({ type: 'pool-created', venueId: 'uni-v2:NEW', quoteLiquidity: 1_000_000n }));
  det.onEvent(ev({ type: 'trading-enabled', block: 100, openBlock: open }));
  return { w, det, launch: () => det.get('sim-evm', NEW)! };
}

test('4a. detector: dedupe across providers, reorg revoke recomputes state', () => {
  const det = new LaunchDetector({ requireTradingEnabledEvent: true });
  const created = ev({ type: 'pool-created', venueId: 'p1', quoteLiquidity: 500n });
  assert.equal(det.onEvent(created)!.status, 'detected');           // liquid but trading not enabled yet
  assert.equal(det.onEvent({ ...created }), undefined);             // duplicate delivery
  const en = ev({ type: 'trading-enabled', block: 102, openBlock: 105 });
  assert.equal(det.onEvent(en)!.status, 'tradable'); assert.equal(det.get('sim-evm', NEW)!.tradingOpenBlock, 105);
  det.revoke('sim-evm', en.txHash); assert.equal(det.get('sim-evm', NEW)!.status, 'detected');
  assert.equal(det.onEvent({ ...en, logIndex: 99 }), undefined);    // late re-delivery from a reorged tx is ignored
  det.revoke('sim-evm', created.txHash); assert.equal(det.get('sim-evm', NEW)!.status, 'revoked');
});

test('4b. snipe waits for trading to open + delay, then emits a bounded intent; exits are OCO orders', async () => {
  const { w, launch } = launchWorld(103);
  const s = new Sniper(w.chain, cfg());
  let d = s.decide(launch(), { address: NEW }); assert.ok(!d.ok && d.code === 'trading-not-open', J(d));
  w.chain.mine(3); d = s.decide(launch(), { address: NEW }); assert.ok(!d.ok && d.code === 'delay');   // open block reached, delay not yet
  w.chain.mine(1); d = s.decide(launch(), { address: NEW }); assert.ok(d.ok, J(d));
  if (!d.ok) return;
  assert.equal(d.intent.origin, 'snipe'); assert.equal(d.intent.amountIn, 10_000n); assert.equal(d.intent.slippageBps, 300);
  assert.equal(d.risk.verdict === 'blocked', false);
  assert.equal(s.decide(launch(), { address: NEW }).ok, false);        // one in flight at a time
  // execute through the engine
  await w.engine.submit(d.intent); w.chain.mine(); const r = await w.engine.advance(d.intent.idempotencyKey);
  assert.equal(r.state, 'confirmed'); const tokens = r.fill!.received;
  s.report(launch().key, d.intent.idempotencyKey, { ok: true, tokens, spent: r.fill!.spent + r.fill!.platformFee });
  assert.equal(s.decide(launch(), { address: NEW }).ok, false);        // filled: no more buys
  // exit orders
  const res = new Reservations((wl, t) => w.chain.balance(wl, t)); const ran: string[] = [];
  const mgr = new OrderManager(res, i => ran.push(`${i.tokenIn}>${i.tokenOut}`), () => w.chain.time, () => 1000);
  const orders = exitOrders(cfg(), launch(), { tokens, quoteSpent: 10_000n }, w.chain.time);
  assert.deepEqual(orders.map(o => o.kind), ['take_profit', 'stop_loss']); orders.forEach(o => mgr.place(o));
  assert.equal(res.reservedTotal('w1', NEW), tokens);                  // OCO: reserved once
  const entry = 10_000n * E18 / tokens;
  assert.equal(orders[0].triggerPriceE18, entry * 2n); assert.equal(orders[1].triggerPriceE18, entry * 7n / 10n);
  const snap = (p: bigint) => () => ({ priceE18: p, ts: 1000, liquidity: 10n, executableOut: (o: { amount: bigint }) => o.amount * p / E18 });
  assert.deepEqual(mgr.tick(snap(entry * 21n / 10n)), [orders[0].id]); mgr.onResult(orders[0].id, true); assert.equal(mgr.orders.get(orders[1].id)!.status, 'cancelled');
});

test('4c. attempts strictly bounded: no more than maxAttempts, one per block, spend never exceeds maxSpend, slippage never widens', () => {
  const { w, launch } = launchWorld(100);
  const s = new Sniper(w.chain, cfg({ delayBlocks: 0, maxAttempts: 2 })); const intents = [];
  for (let i = 0; i < 6; i++) {
    const d = s.decide(launch(), { address: NEW });
    if (d.ok) { intents.push(d.intent); s.report(launch().key, d.intent.idempotencyKey, { ok: false }); }
    else if (i === 0) assert.fail(d.reason);
    const d2 = s.decide(launch(), { address: NEW }); assert.ok(!d2.ok && (d2.code === 'rate-limited' || d2.code === 'attempts-exhausted'));   // same block never re-fires
    w.chain.mine();
  }
  assert.equal(intents.length, 2); assert.ok(intents.every(i => i.amountIn <= 10_000n && i.slippageBps === 300 && i.origin === 'snipe'));
  const last = s.decide(launch(), { address: NEW }); assert.ok(!last.ok && last.code === 'attempts-exhausted');
  assert.equal(new Set(intents.map(i => i.idempotencyKey)).size, 2);
});

test('4d. pre-trade checks reject: honeypot, tax, liquidity, valuation, max wallet, max tx, blocked token', () => {
  const { w, launch } = launchWorld(100);
  const code = (c: SnipeConfig, limits = {}) => { const d = new Sniper(w.chain, c).decide(launch(), { address: NEW }, limits); return d.ok ? 'ok' : d.code; };
  assert.equal(code(cfg({ delayBlocks: 0 })), 'ok');
  assert.equal(code(cfg({ delayBlocks: 0, minLiquidity: 5_000_000n })), 'liquidity-low');
  assert.equal(code(cfg({ delayBlocks: 0, maxLiquidity: 10n })), 'liquidity-high');
  assert.equal(code(cfg({ delayBlocks: 0, maxValuation: 1n })), 'valuation-unverifiable');
  assert.equal(code(cfg({ delayBlocks: 0, maxValuation: 1n, totalSupply: 1_000_000n })), 'valuation-high');
  assert.equal(code(cfg({ delayBlocks: 0, maxValuation: 10_000_000n, totalSupply: 1_000_000n })), 'ok');
  assert.equal(code(cfg({ delayBlocks: 0 }), { maxWalletTokens: 5n }), 'max-wallet');
  assert.equal(code(cfg({ delayBlocks: 0, blockedTokens: [NEW] })), 'blocked-token');
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, maxTxAmount: 10n }); assert.equal(code(cfg({ delayBlocks: 0 })), 'max-tx');
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, honeypot: true }); assert.equal(code(cfg({ delayBlocks: 0 })), 'risk');
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, sellTaxBps: 2500 }); assert.equal(code(cfg({ delayBlocks: 0 })), 'tax');            // analyzer only warns on >5% tax; the sniper's own maxTaxBps rejects
  assert.equal(code(cfg({ delayBlocks: 0, rejectVerdicts: ['warn', 'blocked'] })), 'risk');
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, buyTaxBps: 100 }); assert.equal(code(cfg({ delayBlocks: 0, maxTaxBps: 50 })), 'tax');
});

test('4e. never participates before trading is open, even with delay 0; revoked launch rejected', () => {
  const { w, det, launch } = launchWorld(150);
  const s = new Sniper(w.chain, cfg({ delayBlocks: 0 }));
  const d = s.decide(launch(), { address: NEW }); assert.ok(!d.ok && d.code === 'trading-not-open');
  assert.equal(w.chain.balance('w1', NEW), 0n);
  const sim = simulateLaunch(w.chain, { token: NEW, venue: 'uni-v2:NEW', amount: 10_000n });
  assert.equal(sim.buy.feasible, false); assert.equal(sim.buy.reason, 'trading not enabled'); assert.ok(sim.restrictedBlocksRemaining > 0);
  assert.ok(sim.limitations.length >= 4); assert.equal(sim.block, w.chain.block); assert.equal(w.chain.balance('__launch-sim__', NATIVE), 0n);
  for (const e of launch().events) det.revoke(e.chain, e.txHash);
  const r = s.decide(launch(), { address: NEW }); assert.ok(!r.ok && r.code === 'revoked');
  assert.ok(!s.decide(undefined, { address: NEW }).ok);
});

test('4f. launch simulation reports taxes, max tx, feasibility with block/state', () => {
  const { w } = launchWorld(100, { buy: 500, sell: 1000 });
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, buyTaxBps: 500, sellTaxBps: 1000, maxTxAmount: 5n });
  const sim = simulateLaunch(w.chain, { token: NEW, venue: 'uni-v2:NEW', amount: 10_000n });
  assert.ok(sim.buy.feasible); assert.ok(Math.abs(sim.buy.taxBps! - 500) <= 20); assert.equal(sim.maxTxAmount, 5n);
  assert.equal(sim.maxTxBlocksExit, true); assert.equal(sim.sell.feasible, false); assert.match(sim.sell.reason!, /max tx/);
  w.chain.tokens.set(NEW, { tradingOpenBlock: 100, sellTaxBps: 1000 });
  const s2 = simulateLaunch(w.chain, { token: NEW, venue: 'uni-v2:NEW', amount: 10_000n });
  assert.ok(s2.sell.feasible && Math.abs(s2.sell.taxBps! - 1000) <= 20, JSON.stringify(s2, (_, v) => typeof v === 'bigint' ? String(v) : v));
});

test('5. pool migration while monitoring: identity + open orders carry over, router follows successor, dedupe/reorg of graduation', async () => {
  const w = world(); const CUR = '0xCURVECOIN';
  w.chain.addVenue(new LinearCurve('pump:CUR', 'pump-like', CUR, NATIVE, 100n, 1n, 0n, 0n, 5_000n));
  w.policies.get('w1')!.maxPerTx[CUR] = 10_000_000n; w.policies.get('w1')!.dailyLimit[CUR] = 10_000_000n;
  const det = new LaunchDetector();
  det.onEvent(ev({ type: 'curve-created', token: CUR, venueId: 'pump:CUR' }));
  let L = det.get('sim-evm', CUR)!; assert.equal(L.kind, 'curve'); assert.equal(L.status, 'tradable'); assert.equal(L.venueId, 'pump:CUR');
  const c = cfg({ venues: ['pump-like'], minLiquidity: 0n, delayBlocks: 0, maxSpend: 3_000n });
  const s = new Sniper(w.chain, c);
  const d = s.decide(L, { address: CUR }); assert.ok(d.ok, J(d)); if (!d.ok) return;
  await w.engine.submit(d.intent); w.chain.mine(); let r = await w.engine.advance(d.intent.idempotencyKey);
  assert.equal(r.state, 'confirmed'); const tokens = r.fill!.received; assert.ok(tokens > 0n);
  s.report(L.key, d.intent.idempotencyKey, { ok: true, tokens, spent: 3_000n });
  // open exit orders reference the curve
  const res = new Reservations((wl, t) => w.chain.balance(wl, t));
  const mgr = new OrderManager(res, () => {}, () => w.chain.time, () => 1000);
  const orders = exitOrders(c, L, { tokens, quoteSpent: 3_000n }, w.chain.time); orders.forEach(o => mgr.place({ ...o, venues: ['pump:CUR'] }));
  assert.equal(res.reservedTotal('w1', CUR), tokens);
  // a second buyer pushes the curve over its target; chain migrates it
  w.chain.credit('w2', NATIVE, 1_000_000n); w.policies.get('w2')!.maxPerTx[NATIVE] = 100_000n;
  await w.engine.submit(w.intent({ idempotencyKey: 'push', walletId: 'w2', tokenOut: CUR, amountIn: 9_000n, venues: ['pump-like'], slippageBps: 1000 }));
  w.chain.mine(); await w.engine.advance('push');
  assert.equal((w.chain.state.venues.get('pump:CUR') as LinearCurve).status, 'graduated');
  const successor = (w.chain.state.venues.get('pump:CUR') as LinearCurve).successor!; assert.equal(successor, 'pump:CUR-pool');
  // pre-event: the sniper's view still points at a graduated curve and must refuse (no phantom buy)
  const stale = new Sniper(w.chain, { ...c, maxSpend: 100n }).decide(L, { address: CUR }); assert.ok(!stale.ok && stale.code === 'venue-unavailable');
  // graduation event: dedupe, identity preserved
  const g = ev({ type: 'graduated', token: CUR, block: w.chain.block, successor });
  L = det.onEvent(g)!; assert.equal(det.onEvent({ ...g }), undefined);
  assert.equal(L.token, CUR); assert.equal(L.status, 'graduated'); assert.equal(L.venueId, successor); assert.deepEqual(L.venueHistory, ['pump:CUR', successor]); assert.equal(L.key, `sim-evm:${CUR}`);
  // open orders carry over: same ids, same reservation, venue allow-list updated
  const moved = migrateOrders(mgr.orders.values(), CUR, 'pump:CUR', successor);
  assert.deepEqual(moved.sort(), orders.map(o => o.id).sort()); assert.ok([...mgr.orders.values()].every(o => o.status === 'active' && o.venues.includes(successor) && !o.venues.includes('pump:CUR')));
  assert.equal(res.reservedTotal('w1', CUR), tokens); assert.equal(migrateOrders(mgr.orders.values(), CUR, 'pump:CUR', successor).length, orders.length);   // idempotent
  assert.equal(migrateOrders(mgr.orders.values(), '0xOTHER', 'pump:CUR', successor).length, 0);
  // sniper state is keyed by token identity -> already-filled launch is not sniped again on the new venue
  const again = s.decide(L, { address: CUR }); assert.ok(!again.ok && again.code === 'done');
  // exit sell routes through the successor via the order's venue list
  const sellKey = 'exit-sell'; w.policies.get('w1')!.dailyLimit[CUR] = 10_000_000n;
  await w.engine.submit(w.intent({ idempotencyKey: sellKey, tokenIn: CUR, tokenOut: NATIVE, amountIn: tokens, venues: [...mgr.orders.values()][0].venues, slippageBps: 1000 }));
  w.chain.mine(); r = await w.engine.advance(sellKey); assert.equal(r.state, 'confirmed', r.failure); assert.equal(r.quote!.venue, successor);
  // reorg of graduation event: launch falls back to the curve record; position reconciliation is the caller's job
  det.revoke('sim-evm', g.txHash); L = det.get('sim-evm', CUR)!; assert.equal(L.venueId, 'pump:CUR'); assert.equal(L.status, 'tradable');
});
