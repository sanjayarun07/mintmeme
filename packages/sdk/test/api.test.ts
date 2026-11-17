import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../../apps/api/server.ts';
import { createSimTrader, MemeClient, PRACTICE_TOKEN as T, SdkError } from '../src/index.ts';

const KA = 'key-alice-0123456789abcdef', KB = 'key-bob---0123456789abcdef', KR = 'key-alice-read-0123456789';
async function boot(rate?: { perSecond: number; burst: number }) {
  const a = createSimTrader({ userId: 'alice' }), b = createSimTrader({ userId: 'bob', wallets: ['b1'] }); const traders: Record<string, any> = { alice: a.trader, bob: b.trader };
  const api = createApi({ keys: [{ key: KA, userId: 'alice' }, { key: KB, userId: 'bob' }, { key: KR, userId: 'alice', scope: 'read' }], traderFor: u => traders[u], rate });
  const port = await api.listen(0); const url = `http://127.0.0.1:${port}`;
  return { a, b, api, url, alice: new MemeClient({ baseUrl: url, apiKey: KA }), bob: new MemeClient({ baseUrl: url, apiKey: KB }), reader: new MemeClient({ baseUrl: url, apiKey: KR }) };
}

test('auth: no key, wrong key and read-only key are refused with a fix; health and openapi are open', async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(s.url + '/v1/health')).status, 200);
    const spec: any = await (await fetch(s.url + '/v1/openapi.json')).json(); assert.ok(spec.paths['/v1/orders/trailing-stop'] && spec.paths['/v1/bulk/buy'] && spec.paths['/v1/twap'] && spec.paths['/v1/orders/{id}'].delete);
    const r = await fetch(s.url + '/v1/overview'); assert.equal(r.status, 401); assert.match(((await r.json()) as any).error.fix, /Bearer/);
    await assert.rejects(new MemeClient({ baseUrl: s.url, apiKey: 'wrong-key-0123456789' }).overview(), (e: any) => e instanceof SdkError && e.status === 401);
    assert.equal((await s.reader.overview()).userId, 'alice');
    await assert.rejects(s.reader.buy({ walletId: 'w1', token: T, amount: 1000n }), (e: any) => e.code === 'read_only_key' && e.status === 403);
    assert.equal((await fetch(s.url + '/v1/nope', { headers: { authorization: 'Bearer ' + KA } })).status, 404);
    assert.equal((await fetch(s.url + '/v1/overview', { method: 'POST', headers: { authorization: 'Bearer ' + KA } })).status, 405);
  } finally { await s.api.close(); }
});

test('market buy and sell over HTTP: idempotent by header, amounts are strings, bad input explains itself', async () => {
  const s = await boot();
  try {
    const q = await s.alice.quote({ side: 'buy', token: T, amount: 10_000n }); assert.equal(typeof q.amountOut, 'string'); assert.equal(q.venue, 'uni-v2:MEME');
    const a = await s.alice.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'k1' }); assert.equal(a.state, 'finalized'); assert.equal(a.key, 'alice.k1'); assert.equal(typeof a.fill.received, 'string');
    const bal = s.a.chain.balance('w1', T); await s.alice.buy({ walletId: 'w1', token: T, amount: 10_000n, key: 'k1' }); assert.equal(s.a.chain.balance('w1', T), bal, 'same Idempotency-Key never trades twice');
    const sell = await s.alice.sell({ walletId: 'w1', token: T, pctBps: 5000, key: 's1' }); assert.equal(sell.state, 'finalized');
    assert.equal((await s.alice.trades()).length, 2); assert.equal((await s.alice.trade('alice.k1')).state, 'finalized');
    await assert.rejects(s.alice.buy({ walletId: 'w1', token: T, amount: '1.5' as any }), (e: any) => e.code === 'bad_amount' && /raw base units/.test(e.message) && !!e.fix);
    const raw = await fetch(s.url + '/v1/trades/buy', { method: 'POST', headers: { authorization: 'Bearer ' + KA, 'content-type': 'application/json' }, body: '{nope' }); assert.equal(raw.status, 400); assert.equal(((await raw.json()) as any).error.code, 'bad_json');
    const big = await fetch(s.url + '/v1/trades/buy', { method: 'POST', headers: { authorization: 'Bearer ' + KA }, body: JSON.stringify({ x: 'a'.repeat(300_000) }) }).catch(() => ({ status: 413 } as any)); assert.equal(big.status, 413);
  } finally { await s.api.close(); }
});

test('tenant isolation: another user cannot read, cancel or trigger your trade, order, bulk or TWAP; same ids do not collide', async () => {
  const s = await boot();
  try {
    await s.alice.buy({ walletId: 'w1', token: T, amount: 20_000n, key: 'shared' }); await s.bob.buy({ walletId: 'b1', token: T, amount: 20_000n, key: 'shared' });
    assert.equal((await s.bob.trade('bob.shared')).walletId, 'b1'); await assert.rejects(s.bob.trade('alice.shared'), (e: any) => e.status === 404);
    await s.alice.limitBuy({ id: 'o1', walletId: 'w1', token: T, amount: 5_000n, priceE18: 1n }); await s.bob.limitBuy({ id: 'o1', walletId: 'b1', token: T, amount: 5_000n, priceE18: 1n });
    await assert.rejects(s.bob.cancelOrder('alice.o1'), (e: any) => e.status === 404); await assert.rejects(s.bob.order('alice.o1'), (e: any) => e.status === 404); assert.equal((await s.alice.order('alice.o1')).status, 'active');
    assert.equal((await s.alice.orders()).length, 1); assert.equal((await s.bob.orders()).length, 1);
    await s.alice.bulkBuy({ id: 'bb', token: T, wallets: ['w1'], total: 2_000n }); await assert.rejects(s.bob.bulk('alice.bb'), (e: any) => e.status === 404);
    await s.alice.twap({ id: 't', walletId: 'w1', token: T, side: 'buy', total: 3_000n, slices: 3, intervalS: 60 }); await assert.rejects(s.bob.cancelTwap('alice.t'), (e: any) => e.status === 404);
    await s.bob.buy({ walletId: 'w1', token: T, amount: 1_000n });   // bob tries a wallet that is not his: the trade fails, nothing of alice's moves
    const t = await s.bob.trades({ walletId: 'w1' }); assert.equal(t.length, 1); assert.equal(t[0].state, 'failed'); assert.ok(t[0].failure);   // bob has no w1 wallet in his own world; cross-user policy refusal is covered by the core signer tests
  } finally { await s.api.close(); }
});

test('every order type, bulk, TWAP, alerts, pause and positions work over HTTP', async () => {
  const s = await boot();
  try {
    await s.alice.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' });
    const lb = await s.alice.limitBuy({ id: 'lb', walletId: 'w1', token: T, amount: 1_000n, priceE18: '1' }); const ls = await s.alice.limitSell({ id: 'ls', walletId: 'w1', token: T, amount: 1_000n, priceE18: (10n ** 30n).toString() });
    const tp = await s.alice.takeProfit({ id: 'tp', walletId: 'w1', token: T, amount: 1_000n, priceE18: (10n ** 30n).toString() }); const sl = await s.alice.stopLoss({ id: 'sl', walletId: 'w1', token: T, amount: 1_000n, priceE18: '1' });
    const tr = await s.alice.trailingStop({ id: 'tr', walletId: 'w1', token: T, amount: 1_000n, trailBps: 500 }); const br = await s.alice.bracket({ id: 'br', walletId: 'w1', token: T, amount: 1_000n, takeProfitE18: (10n ** 30n).toString(), stopLossE18: '1' });
    assert.deepEqual([lb, ls, tp, sl, tr].map(o => o.kind), ['limit_buy', 'limit_sell', 'take_profit', 'stop_loss', 'trailing_stop']); assert.deepEqual(br.map((o: any) => o.id), ['alice.br:tp', 'alice.br:sl']);
    assert.equal((await s.alice.orders({ status: 'active' })).length, 7); assert.equal((await s.alice.cancelOrder('alice.lb')).status, 'cancelled'); assert.match((await s.alice.order('alice.ls')).detail.status, /active/);
    await s.alice.bulkBuy({ id: 'bb', token: T, wallets: ['w1', 'w2'], total: 4_000n }); for (let i = 0; i < 4; i++) await s.a.trader.tick(); assert.equal((await s.alice.bulk('alice.bb')).filled, 2);
    await s.alice.bulkSell({ id: 'bs', token: T, wallets: ['w1', 'w2'], pctBps: 1000 }); for (let i = 0; i < 4; i++) await s.a.trader.tick(); assert.equal((await s.alice.bulk('alice.bs')).done, true);
    await s.alice.twap({ id: 'tw', walletId: 'w1', token: T, side: 'buy', total: 3_000n, slices: 3, intervalS: 60 }); await s.a.trader.tick(); assert.equal((await s.alice.twapStatus('alice.tw')).filled, 1); assert.equal((await s.alice.cancelTwap('alice.tw')).skipped, 2);
    assert.equal((await s.alice.addPriceAlert({ id: 'al', token: T, direction: 'above', threshold: 99 })).id, 'alice.al'); assert.equal((await s.alice.cancelPriceAlert('alice.al')).cancelled, true);
    assert.deepEqual(await s.alice.pauseEntries(), { paused: true }); await assert.rejects(s.alice.buy({ walletId: 'w1', token: T, amount: 1_000n }), (e: any) => e.code === 'entries_paused' && e.status === 409); await s.alice.resumeEntries();
    assert.ok((await s.alice.positions()).length >= 1); assert.ok((await s.alice.history()).length >= 1);
    await assert.rejects(s.alice.addSnipe({}), (e: any) => e.status === 501 && e.code === 'not_configured'); assert.deepEqual(await s.alice.snipes(), []); assert.deepEqual(await s.alice.copies(), []);
  } finally { await s.api.close(); }
});

test('rate limit answers 429 with a fix, and events stream order changes live', async () => {
  const s = await boot({ perSecond: 1, burst: 3 });
  try {
    const codes: number[] = []; for (let i = 0; i < 6; i++) codes.push((await fetch(s.url + '/v1/overview', { headers: { authorization: 'Bearer ' + KA } })).status); assert.ok(codes.includes(429), codes.join()); assert.equal(codes[0], 200);
  } finally { await s.api.close(); }
  const e = await boot();
  try {
    const got: any[] = []; const ac = new AbortController(); const stream = e.alice.events(ev => got.push(ev), ac.signal).catch(() => {});
    await new Promise(r => setTimeout(r, 100)); await e.alice.buy({ walletId: 'w1', token: T, amount: 5_000n, key: 'ev' }); await e.a.trader.tick(); await new Promise(r => setTimeout(r, 100));
    assert.ok(got.some(x => x.type === 'trade' && x.key === 'alice.ev' && x.state === 'finalized'), JSON.stringify(got)); ac.abort(); await stream;
    assert.ok(!got.some(x => JSON.stringify(x).includes('bob.')), 'no cross-user events');
  } finally { await e.api.close(); }
});

test('over HTTP: chase is accepted on orders, PATCH moves a trigger (owner only), and USD triggers need a feed on the server', async () => {
  const s = await boot();
  try {
    await s.alice.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' });
    const ch = await s.alice.limitSell({ id: 'ch', walletId: 'w1', token: T, amount: 1_000n, priceE18: (10n ** 30n).toString(), slippageBps: 100, chase: { stepBps: 100, maxBps: 400 } });
    assert.deepEqual(ch.chase, { stepBps: 100, maxBps: 400 }); assert.equal(ch.maxAttempts, 4);
    const ed = await s.alice.editOrder('alice.ch', { priceE18: (10n ** 31n).toString() }); assert.equal(ed.triggerPriceE18, (10n ** 31n).toString()); assert.equal(ed.status, 'active');
    await assert.rejects(s.bob.editOrder('alice.ch', { priceE18: '5' }), (e: any) => e.status === 404, 'another user cannot move your trigger');
    await assert.rejects(s.reader.editOrder('alice.ch', { priceE18: '5' }), (e: any) => e.status === 403, 'a read-only key cannot edit');
    await assert.rejects(s.alice.editOrder('alice.ch', { priceUsd: '1' }), (e: any) => e.status === 400 && /USD price feed/.test(e.message));
    const spec: any = await (await fetch(s.url + '/v1/openapi.json')).json(); assert.ok(spec.paths['/v1/orders/{id}'].patch, 'PATCH is in the OpenAPI document');
  } finally { await s.api.close(); }
});

test('orders, bulk and TWAP placed WITHOUT an id still get an id under the caller, so the owner can read, edit and cancel them (and nobody else can)', async () => {
  const s = await boot();
  try {
    await s.alice.buy({ walletId: 'w1', token: T, amount: 50_000n, key: 'seed' });
    const o = await s.alice.limitSell({ walletId: 'w1', token: T, amount: 1_000n, priceE18: (10n ** 30n).toString() });
    assert.match(o.id, /^alice\.a-/); assert.equal((await s.alice.order(o.id)).status, 'active');
    assert.equal((await s.alice.editOrder(o.id, { priceE18: (10n ** 31n).toString() })).triggerPriceE18, (10n ** 31n).toString());
    await assert.rejects(s.bob.cancelOrder(o.id), (e: any) => e.status === 404); assert.equal((await s.alice.cancelOrder(o.id)).status, 'cancelled');
    const br = await s.alice.bracket({ walletId: 'w1', token: T, amount: 1_000n, takeProfitE18: (10n ** 30n).toString(), stopLossE18: '1' });
    assert.ok(br.every((l: any) => l.id.startsWith('alice.a-'))); assert.equal((await s.alice.cancelOrder(br[1].id)).status, 'cancelled');
    const tw = await s.alice.twap({ walletId: 'w1', token: T, side: 'buy', total: 3_000n, slices: 3, intervalS: 60 }); assert.match(tw.id, /^alice\.a-/); assert.ok(await s.alice.twapStatus(tw.id));
  } finally { await s.api.close(); }
});
