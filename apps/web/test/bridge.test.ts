/** bridge-then-buy (apps/web/bridge.ts): a Relay quote is only handed to Privy when it is one deposit, on Base, to Relay's depository, credited to the user, under the cap. Network is faked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeQuote, bridgeStatus, evmBalances, shortfall, toWei, RELAY_DEPOSITORY, DEPOSIT_NATIVE, GAS_RESERVE_WEI } from '../bridge.ts';

const ME = '0x3bf6d6283f13a9f3c78a3cb64ddb8662588fd967', OTHER = '0x1111111111111111111111111111111111111111';
const RID = '0x' + 'ab'.repeat(32), DEP = RELAY_DEPOSITORY[8453];
const env = { RELAY_API_KEY: 'test-relay-key', ALCHEMY_API_KEY: 'test-alchemy' } as NodeJS.ProcessEnv;
const data = (who = ME, id = RID) => DEPOSIT_NATIVE + who.slice(2).padStart(64, '0') + id.slice(2);
/** A Relay quote like the live one (2026-11-19), with parts overridable. */
const quote = (o: any = {}) => ({
  steps: o.steps ?? [{ id: 'deposit', requestId: o.requestId ?? RID, items: [{ data: { from: ME, to: o.to ?? DEP, data: o.data ?? data(), value: o.value ?? '711987963800671', chainId: o.chainId ?? 8453 } }] }],
  details: { recipient: o.recipient ?? ME, sender: ME, currencyOut: { amount: o.out ?? '700000000000000' }, timeEstimate: 1 },
  fees: { relayer: { amountUsd: '0.02' }, gas: { amountUsd: '0.0005' } },
});
const relay = (q: any, status = 200) => { const calls: any[] = []; const f = (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify(q), { status }); }) as any; return { f, calls }; };
const ask = (q: any, body: any = {}) => bridgeQuote({ address: ME, from: 'base', to: 'robinhood', receiveWei: '700000000000000', ...body }, { fetch: relay(q).f, env });

test('a good quote becomes one Base transaction to the depository, and the key goes only in the header', async () => {
  const { f, calls } = relay(quote());
  const r = await bridgeQuote({ address: ME.toUpperCase().replace('0X', '0x'), to: 'robinhood', receive: '0.0007' }, { fetch: f, env });
  assert.equal(r.tx.to, DEP); assert.equal(r.tx.chainId, 8453); assert.equal(BigInt(r.tx.value), 711987963800671n); assert.equal(r.requestId, RID);
  assert.equal(r.receiveSymbol, 'ETH'); assert.equal(r.paySymbol, 'ETH');
  const sent = JSON.parse(calls[0].init.body); assert.equal(sent.recipient, ME); assert.equal(sent.user, ME); assert.equal(sent.tradeType, 'EXACT_OUTPUT'); assert.equal(sent.destinationChainId, 4663);
  assert.equal(calls[0].init.headers['x-api-key'], 'test-relay-key'); assert.ok(!calls[0].url.includes('test-relay-key'));
});

test('a tampered or odd quote is refused before Privy is ever asked', async () => {
  const refused = async (q: any, re: RegExp) => { await assert.rejects(ask(q), (e: Error) => re.test(e.message) && /Nothing was signed/.test(e.message)); };
  await refused(quote({ to: OTHER }), /deposit contract/);
  await refused(quote({ data: data(OTHER) }), /credited to your wallet/);
  await refused(quote({ data: '0xa9059cbb' + data().slice(10) }), /plain Relay deposit/);
  await refused(quote({ data: data() + '00' }), /plain Relay deposit/);
  await refused(quote({ recipient: OTHER }), /someone other than you/);
  await refused(quote({ chainId: 4663 }), /not on Base/);
  await refused(quote({ out: '1' }), /less than asked/);
  await refused(quote({ steps: [] }), /single deposit/);
  const two = quote(); two.steps.push(two.steps[0]); await refused(two, /single deposit/);
});

test('limits and bad input are plain refusals', async () => {
  await assert.rejects(ask(quote({ value: '20000000000000000' })), /above the bridge limit of 0\.01/);
  const raised = await bridgeQuote({ address: ME, to: 'robinhood', receiveWei: '700000000000000' }, { fetch: relay(quote({ value: '20000000000000000' })).f, env: { ...env, BRIDGE_MAX_ETH: '0.05' } });
  assert.equal(raised.pay, '0.02', 'BRIDGE_MAX_ETH raises the limit');
  await assert.rejects(ask(quote(), { from: 'bnb' }), /not supported yet/);
  await assert.rejects(ask(quote(), { to: 'base' }), /already on that chain/);
  await assert.rejects(ask(quote(), { to: 'solana' }), /Unknown chain/);
  await assert.rejects(ask(quote(), { address: 'nope' }), /0x wallet address/);
  await assert.rejects(bridgeQuote({ address: ME, to: 'robinhood', receive: '0.001' }, { fetch: relay({ message: 'Insufficient balance' }, 400).f, env }), /do not have enough ETH on Base/);
  assert.throws(() => toWei('1e3'), /not an amount/); assert.equal(toWei('0.001'), 1_000_000_000_000_000n);
});

test('a Relay error never echoes the key', async () => {
  const f = (async () => new Response(JSON.stringify({ message: 'bad header x-api-key: test-relay-key' }), { status: 400 })) as any;
  await assert.rejects(bridgeQuote({ address: ME, to: 'robinhood', receive: '0.001' }, { fetch: f, env }), (e: Error) => !e.message.includes('test-relay-key') && e.message.includes('<key>'));
});

test('balances: every chain, a failed RPC says so, and the shortfall keeps gas for the buy', async () => {
  const f = (async (url: string) => {
    if (url.includes('bnb-mainnet')) throw new Error('down');
    return new Response(JSON.stringify({ result: url.includes('base-mainnet') ? '0x49b9ca9a6943400' : '0x0' }));   // 0.3321 ETH on Base, 0 on Robinhood
  }) as any;
  const r: any = await evmBalances({ address: ME, to: 'robinhood', spend: '0.002' }, { fetch: f, env });
  const by = Object.fromEntries(r.chains.map((c: any) => [c.chain, c]));
  assert.equal(by.base.ok, true); assert.equal(by.robinhood.amount, '0'); assert.equal(by.bnb.ok, false); assert.match(by.bnb.why, /BNB Chain/);
  assert.equal(BigInt(r.needWei), 2_000_000_000_000_000n + GAS_RESERVE_WEI.robinhood);
  assert.equal(shortfall('robinhood', 1n, 10n ** 18n), 0n, 'enough already: nothing to bridge');
  const down: any = await evmBalances({ address: ME, to: 'bnb', spend: '0.01' }, { fetch: f, env }); assert.equal(down.need, null);
});

test('status maps Relay states to pending / done / failed', async () => {
  const st = (s: any) => bridgeStatus({ requestId: RID }, { fetch: (async () => new Response(JSON.stringify(s))) as any, env });
  assert.equal((await st({ status: 'success' })).state, 'done');
  assert.equal((await st({ status: 'pending' })).state, 'pending');
  const r = await st({ status: 'refund' }); assert.equal(r.state, 'failed'); assert.match(r.why!, /back to your wallet on Base/);
  await assert.rejects(bridgeStatus({ requestId: 'x' }, { env }), /requestId/);
});
