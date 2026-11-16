/** Standing orders on Jupiter-routed tokens. Jupiter venues are ONE-direction (SOL->token and token->SOL are separate venues, each priced from one reference quote), which is why
 *  the order runner has to invert a quote->token price when a venue cannot report token->quote. The engine is replaced by a recorder here: this checks what the ORDER side does
 *  (price, trigger, venue choice, the intent it hands over). Executing a Jupiter-built transaction is not exercised: it needs the Jupiter API and mainnet accounts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderRunner, NATIVE } from '../../core/src/index.ts';
import type { Order, Intent } from '../../core/src/index.ts';
import { JupiterVenue } from '../src/jupiterswap.ts';

const WSOL = 'So11111111111111111111111111111111111111112', TOK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', E18 = 10n ** 18n;
// 0.05 SOL buys 1.54 billion raw units (5 decimals): about 3.25e-8 SOL per token, like the Bonk figure seen on the page.
const REF_IN = 50_000_000n, REF_OUT = 154_000_000_000n;
const priceE18 = (lamportsPerRaw: bigint, perRaw: bigint) => lamportsPerRaw * E18 / perRaw;
const CUR = REF_IN * E18 / REF_OUT;   // lamports per raw unit x 1e18

function harness(venues: JupiterVenue[]) {
  const sent: Intent[] = []; let ms = 1000;
  const chain: any = { id: 'sol-main', family: 'solana', time: 1000, block: 1, finalityDepth: 1, state: { venues: new Map() }, venues: () => venues,
    async refresh() {}, async balanceOf() { return 10n ** 15n; } };
  const engine: any = { async submit(i: Intent) { sent.push(i); }, async advance() { return { state: 'finalized' }; }, d: { store: { records: new Map() } } };
  const runner = new OrderRunner({ engine, chain, clockMs: () => ms });
  const order = (o: Partial<Order>): Order => ({ id: 'o1', userId: 'u1', walletId: 'w1', chain: 'sol-main', token: TOK, quoteToken: NATIVE, kind: 'limit_buy', amount: 10_000_000n, triggerPriceE18: CUR,
    expiresAt: chain.time + 10_000_000, maxQuoteAgeMs: 60_000, minLiquidity: 1n, maxDeviationBps: 500, maxAttempts: 2, slippageBps: 300, venues: ['jupiter'], status: 'active', attempts: 0, ...o });
  return { runner, sent, order };
}
const buyVenue = () => new JupiterVenue(`jup:${WSOL.slice(0, 6)}>${TOK.slice(0, 6)}`, WSOL, TOK, WSOL, REF_IN, REF_OUT, 0);
const sellVenue = () => new JupiterVenue(`jup:${TOK.slice(0, 6)}>${WSOL.slice(0, 6)}`, TOK, WSOL, WSOL, REF_OUT, REF_IN, 0);

test('limit buy on a Jupiter token fires when the price is at or below the trigger, using only the SOL->token venue', async () => {
  const h = harness([buyVenue()]); await h.runner.place(h.order({ triggerPriceE18: CUR * 3n / 2n }));
  const t = await h.runner.tick(); assert.deepEqual(t.fired, ['o1']); assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.tokenIn, NATIVE); assert.equal(h.sent[0]!.tokenOut, TOK); assert.equal(h.sent[0]!.amountIn, 10_000_000n);
});
test('limit buy below the market does not fire, and says why', async () => {
  const h = harness([buyVenue()]); await h.runner.place(h.order({ triggerPriceE18: CUR / 2n }));
  const t = await h.runner.tick(); assert.deepEqual(t.fired, []); assert.equal(h.sent.length, 0); assert.equal(h.runner.orders.orders.get('o1')!.reason, 'trigger not met');
});
test('the price read from a one-direction venue is the real quote-per-token price (inverse of tokens-per-SOL)', async () => {
  const h = harness([buyVenue()]); const o = h.order({}); await h.runner.place(o); await h.runner.refresh();
  const snap = h.runner.snapshot(o)!; const diff = snap.priceE18 > CUR ? snap.priceE18 - CUR : CUR - snap.priceE18;
  assert.ok(diff * 1000n <= CUR, `price ${snap.priceE18} vs expected ${CUR}`);   // within 0.1% (integer rounding)
});
test('take profit and stop loss on a Jupiter token use the token->SOL venue and fire on the right side of the trigger', async () => {
  const tp = harness([buyVenue(), sellVenue()]); await tp.runner.place(tp.order({ id: 'tp', kind: 'take_profit', amount: 1_000_000_000n, triggerPriceE18: CUR / 2n }));
  assert.deepEqual((await tp.runner.tick()).fired, ['tp']); assert.equal(tp.sent[0]!.tokenIn, TOK); assert.equal(tp.sent[0]!.tokenOut, NATIVE);
  const tpFar = harness([buyVenue(), sellVenue()]); await tpFar.runner.place(tpFar.order({ id: 'tp', kind: 'take_profit', amount: 1_000_000_000n, triggerPriceE18: CUR * 3n }));
  assert.deepEqual((await tpFar.runner.tick()).fired, []);
  // The price just fell through the stop (trigger 2% above the market). A trigger far above the market is refused instead: the executable output must be within 5% of what the trigger promises.
  const sl = harness([buyVenue(), sellVenue()]); await sl.runner.place(sl.order({ id: 'sl', kind: 'stop_loss', amount: 1_000_000_000n, triggerPriceE18: CUR * 102n / 100n }));
  assert.deepEqual((await sl.runner.tick()).fired, ['sl']); assert.equal(sl.sent[0]!.tokenIn, TOK);
  const slGap = harness([buyVenue(), sellVenue()]); await slGap.runner.place(slGap.order({ id: 'sl', kind: 'stop_loss', amount: 1_000_000_000n, triggerPriceE18: CUR * 2n }));
  assert.deepEqual((await slGap.runner.tick()).fired, []); assert.match(String(slGap.runner.orders.orders.get('sl')!.reason), /executable output/);
  const slFar = harness([buyVenue(), sellVenue()]); await slFar.runner.place(slFar.order({ id: 'sl', kind: 'stop_loss', amount: 1_000_000_000n, triggerPriceE18: CUR / 3n }));
  assert.deepEqual((await slFar.runner.tick()).fired, []);
});
test('a sell order with no token->SOL venue is not evaluated and the reason is recorded (nothing is sent)', async () => {
  const h = harness([buyVenue()]); await h.runner.place(h.order({ kind: 'take_profit', amount: 1_000_000_000n, triggerPriceE18: CUR / 2n }));
  const t = await h.runner.tick(); assert.deepEqual(t.fired, []); assert.equal(h.sent.length, 0); assert.match(String(h.runner.skipped.get('o1')), /no authorized venue/);
});
