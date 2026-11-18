import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import type { SimTx } from '../../core/src/index.ts';
import { gateRelay, decodeRelaySwap, RelayClient, RelayUnavailable, AggRefused, EvmRpcChain, RELAY_BASE, KYBER, ZEROX, ICECREAM_GUARD, simulateCalls, keccak256, bytesToHex } from '../src/index.ts';
import type { RelayStep, RawSigner } from '../src/index.ts';

// REAL Relay quotes captured on Base (packages/evm/test/relayfixture.json, read-only): buys routed through KyberSwap, 0x and IceCreamSwap's AggregatorGuard, and a sell.
const fx = JSON.parse(readFileSync(new URL('./relayfixture.json', import.meta.url), 'utf8'));
const Q = (k: string) => { const q = fx.quotes[k]; return { ...q, amountIn: BigInt(q.amountIn), minimumOut: BigInt(q.minimumOut), amountOut: BigInt(q.amountOut), steps: q.steps.map((s: any) => ({ ...s, value: BigInt(s.value) })) as RelayStep[] }; };
const ctx = (q: any, o: object = {}) => ({ wallet: q.wallet, tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, minOut: q.minimumOut, contracts: RELAY_BASE, ...o });
const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e: Error) => e instanceof AggRefused && re.test(e.message), String(re));
const swapOf = (q: any) => q.steps[q.steps.length - 1] as RelayStep;
const tamper = (q: any, from: string, to: string) => q.steps.map((s: RelayStep) => ({ ...s, data: s.data.toLowerCase().split(from.toLowerCase().replace(/^0x/, '')).join(to.toLowerCase().replace(/^0x/, '')) }));

test('relay gate: the real quotes pass (KyberSwap, 0x and guarded inner routes, and a sell through the approval proxy)', () => {
  for (const k of ['buy-kyber', 'buy-0x', 'buy-guard', 'sell']) { const q = Q(k), g = gateRelay(q.steps, ctx(q)); assert.equal(g.swap, swapOf(q), k); assert.ok(g.feeWei > 0n && g.feeWei < 10n ** 14n, `${k}: Relay's fee is taken and small`); }
  const z = gateRelay(Q('buy-0x').steps, ctx(Q('buy-0x'))); assert.match(z.settler!, /^0x[0-9a-f]{40}$/, 'a 0x route names its Settler for the registry check');
  assert.equal(gateRelay(Q('buy-kyber').steps, ctx(Q('buy-kyber'))).settler, undefined);
  const s = Q('sell'); assert.equal(s.steps.length, 2); assert.equal(s.steps[0].to, s.tokenIn.toLowerCase(), 'the sell approves the input token first'); assert.equal(swapOf(s).to, RELAY_BASE.approvalProxy);
  const d = decodeRelaySwap(swapOf(s).data); assert.equal(d.kind, 'transferAndMulticall'); assert.deepEqual(d.amounts, [s.amountIn]);
  assert.ok([KYBER.router, ZEROX.allowanceHolder, ICECREAM_GUARD.address].some(t => decodeRelaySwap(swapOf(Q('buy-guard')).data).calls.some(c => c.target === t)));
});

test('relay gate: refuses a higher minimum than the route guarantees, a different amount or pair, other contracts, and an oversized fee', () => {
  for (const k of ['buy-kyber', 'buy-0x', 'buy-guard', 'sell']) { const q = Q(k); refused(() => gateRelay(q.steps, ctx(q, { minOut: q.minimumOut + 1_000n })), /on-chain minimum .* is below ours/); }
  const b = Q('buy-kyber');
  refused(() => gateRelay(b.steps, ctx(b, { amountIn: b.amountIn + 1n })), /sends .* wei, not|spends more/);
  refused(() => gateRelay(b.steps, ctx(b, { tokenOut: '0x' + '12'.repeat(20) })), /not this pair/);
  refused(() => gateRelay(b.steps, ctx(b, { maxFeeWei: 1n })), /fee .* is above the cap/);
  refused(() => gateRelay(b.steps.map(s => ({ ...s, to: '0x' + '66'.repeat(20) })), ctx(b)), /must call Relay's router/);
  refused(() => gateRelay(b.steps.map(s => ({ ...s, value: s.value + 1n })), ctx(b)), /sends .* wei, not/);
  refused(() => gateRelay(b.steps, ctx(b, { contracts: { ...RELAY_BASE, router: '0x' + '77'.repeat(20) } })), /must call Relay's router/);
  refused(() => gateRelay(tamper(b, KYBER.router, '0x' + '88'.repeat(20)), ctx(b)), /not reviewed here/);
  refused(() => gateRelay([...b.steps, b.steps[0]], ctx(b)), /unexpected Relay steps/);
  refused(() => gateRelay([{ ...b.steps[0], data: '0xdeadbeef' + b.steps[0].data.slice(10) }], ctx(b)), /not a Relay router call/);
});

test('relay gate: output forwarded to anyone but our wallet, refunds elsewhere, a bigger approve, or a pulled amount that differs are refused', () => {
  const b = Q('buy-kyber'), dead = '0x000000000000000000000000000000000000dEaD';
  refused(() => gateRelay(tamper(b, b.wallet, dead), ctx(b)), /forwarded to|not our wallet|pays/);
  const s = Q('sell'), ap = s.steps[0], bigger = { ...ap, data: ap.data.slice(0, 74) + (s.amountIn * 2n).toString(16).padStart(64, '0') };
  refused(() => gateRelay([bigger, s.steps[1]], ctx(s)), /approves .* not exactly/);
  refused(() => gateRelay([{ ...ap, data: ap.data.slice(0, 10) + '0'.repeat(24) + '99'.repeat(20) + ap.data.slice(74) }, s.steps[1]], ctx(s)), /not Relay's approval proxy/);
  refused(() => gateRelay(s.steps, ctx(s, { amountIn: s.amountIn - 1n })), /approves .* not exactly|pulls/);
  refused(() => gateRelay(tamper(s, s.wallet, dead), ctx(s)), /forwarded to|not our wallet|refunds/);
});

test('relay client: parses a quote, and refuses another chain, signature steps, or a different output token', async () => {
  const b = fx.quotes['buy-kyber'], resp = (o: any = {}) => ({ steps: [{ id: 'swap', kind: 'transaction', requestId: '0xabc', items: [{ data: { ...b.steps[0], chainId: 8453 } }] }], fees: { relayer: { amount: '3000000000000' } }, details: { currencyOut: { currency: { address: b.tokenOut }, amount: b.amountOut, minimumAmount: b.minimumOut } }, ...o });
  const client = (j: any, status = 200, seen: any[] = []) => new RelayClient({ chainId: 8453, apiKey: 'k-test', fetchFn: (async (u: string, init: any) => { seen.push({ u, init }); return { ok: status === 200, status, json: async () => j }; }) as any });
  const seen: any[] = [], q = await client(resp(), 200, seen).quote(b.wallet, NATIVE, b.tokenOut, BigInt(b.amountIn), 40);
  assert.equal(q.amountOut, BigInt(b.amountOut)); assert.equal(q.steps.length, 1); assert.equal(q.relayerFeeWei, 3_000_000_000_000n);
  const body = JSON.parse(seen[0].init.body); assert.equal(body.originCurrency, '0x0000000000000000000000000000000000000000'); assert.equal(body.originChainId, 8453); assert.equal(body.destinationChainId, 8453); assert.equal(body.slippageTolerance, '40'); assert.equal(seen[0].init.headers['x-api-key'], 'k-test');
  await assert.rejects(client(resp({ steps: [{ id: 'swap', kind: 'transaction', items: [{ data: { ...b.steps[0], chainId: 1 } }] }] })).quote(b.wallet, NATIVE, b.tokenOut, 1n), /on chain 1/);
  await assert.rejects(client(resp({ steps: [{ id: 'authorize', kind: 'signature', items: [] }] })).quote(b.wallet, NATIVE, b.tokenOut, 1n), /signature step/);
  await assert.rejects(client(resp({ details: { currencyOut: { currency: { address: '0x' + '11'.repeat(20) }, amount: '1', minimumAmount: '1' } } })).quote(b.wallet, NATIVE, b.tokenOut, 1n), /different output token/);
  await assert.rejects(client({ message: 'no routes found' }, 400).quote(b.wallet, NATIVE, b.tokenOut, 1n), /HTTP 400: no routes found/);
});

// ---- the chain: a mock node answering what the Relay path asks (eth_simulateV1 with transfer logs, allowance, 0x registry, balances for receipts)
const TRANSFER = bytesToHex(keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))), pad = (a: string) => '0x' + a.toLowerCase().slice(2).padStart(64, '0'), w32 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0'), hx = (n: bigint | number) => '0x' + n.toString(16);
const signer: RawSigner = { sign: r => '0x' + Buffer.from(JSON.stringify({ ...r, value: r.value.toString(), gasLimit: r.gasLimit.toString(), maxFeePerGas: r.maxFeePerGas.toString(), maxPriorityFeePerGas: r.maxPriorityFeePerGas.toString() })).toString('hex') };
function world(o: { got?: bigint; spend?: bigint; extra?: [string, bigint]; settler?: string; allowance?: bigint; txsInBlock?: bigint; ok?: boolean; l1Fee?: bigint; blockTxs?: any[] } = {}) {
  const b = Q('buy-kyber'), s = Q('sell'), W = b.wallet.toLowerCase(), TOK = b.tokenOut.toLowerCase(), calls: string[] = [];
  const rpc = { call: async (m: string, p: any[] = []): Promise<any> => { calls.push(m);
    if (m === 'eth_getBlockByNumber') return { number: hx(100), timestamp: hx(1_800_000_000), ...(p[1] === true ? { transactions: o.blockTxs ?? [] } : {}) }; if (m === 'eth_gasPrice') return hx(10_000_000n);
    if (m === 'eth_call') { const q = p[0]; if (q.data.startsWith('0xdd62ed3e')) return w32(o.allowance ?? 0n); if (q.to === ZEROX.deployer) return pad(o.settler ?? '0x' + '00'.repeat(20)); throw new Error('unscripted eth_call'); }
    if (m === 'eth_simulateV1') { const cs = p[0].blockStateCalls[0].calls as any[], last = cs[cs.length - 1], sell = last.to === RELAY_BASE.approvalProxy;
      const logs = sell ? [{ address: TOK, topics: [TRANSFER, pad(W), pad(RELAY_BASE.approvalProxy)], data: w32(o.spend ?? s.amountIn) }, { address: KYBER.native, topics: [TRANSFER, pad(RELAY_BASE.router), pad(W)], data: w32(o.got ?? s.minimumOut) }]
        : [{ address: KYBER.native, topics: [TRANSFER, pad(W), pad(RELAY_BASE.router)], data: w32(o.spend ?? b.amountIn) }, { address: TOK, topics: [TRANSFER, pad(RELAY_BASE.router), pad(W)], data: w32(o.got ?? b.minimumOut) }];
      if (o.extra) logs.push({ address: o.extra[0], topics: [TRANSFER, pad(W), pad('0x' + '99'.repeat(20))], data: w32(o.extra[1]) });
      return [{ calls: cs.map((_, i) => ({ status: o.ok === false && i === cs.length - 1 ? '0x0' : '0x1', gasUsed: hx(200_000), logs: i === cs.length - 1 ? logs : [], error: o.ok === false && i === cs.length - 1 ? { message: 'execution reverted' } : undefined })) }]; }
    if (m === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: hx(101), gasUsed: hx(100_000), effectiveGasPrice: hx(10n), ...(o.l1Fee !== undefined ? { l1Fee: hx(o.l1Fee) } : {}), from: W, logs: [{ address: TOK, topics: [TRANSFER, pad(W), pad(RELAY_BASE.approvalProxy)], data: w32(s.amountIn) }] };
    if (m === 'eth_getTransactionByHash') return { to: RELAY_BASE.approvalProxy, value: '0x0', input: swapOf(s).data };
    if (m === 'eth_getTransactionCount') return hx(p[1] === hx(101n) ? 6n + (o.txsInBlock ?? 1n) - 1n : 5n);
    if (m === 'eth_getBalance') return hx(p[1] === hx(101n) ? 1_000_000_000_000_000n + 4_000_000_000_000n : 1_000_000_000_000_000n);
    throw new Error(`unscripted ${m}`); } };
  const client = { quote: async (_w: string, tin: string) => (tin === NATIVE ? b : s) } as unknown as RelayClient;
  const chain = new EvmRpcChain({ id: 'base-test', chainId: 8453, router: '0x' + '44'.repeat(20), weth: '0x4200000000000000000000000000000000000006', pools: [], relay: { client, refWallet: W } }, rpc, signer);
  const tx = (sell: boolean, x: Partial<SimTx> = {}): SimTx => ({ hash: '', wallet: W, nonce: 7, venue: chain.venues().find(v => v.supports(sell ? TOK : NATIVE, sell ? NATIVE : TOK))!.id, tokenIn: sell ? TOK : NATIVE, tokenOut: sell ? NATIVE : TOK,
    amountIn: sell ? s.amountIn : b.amountIn, minOut: sell ? s.minimumOut : b.minimumOut, deadline: 1_800_000_600, platformFeeBps: 0, ...x });
  return { chain, calls, tx, b, s, TOK, W };
}

test('chain: a Relay token gets venues both ways; a buy and a sell are quoted, gated and simulated, and only the swap is signed', async () => {
  const { chain, tx, b, s, TOK, calls } = world(); await chain.refresh('head');
  assert.equal(await chain.addAggToken(TOK, b.amountIn), true); assert.equal(chain.venues().length, 2); assert.ok(chain.venues().every(v => v.family === 'relay'));
  const buy = await chain.simulate(tx(false)); assert.equal(buy.receipt.status, 'success', buy.receipt.reason); assert.equal(buy.receipt.deltas[TOK], b.minimumOut);
  const sell = await chain.simulate(tx(true)); assert.equal(sell.receipt.status, 'success', sell.receipt.reason);
  assert.deepEqual(await chain.needsApproval(tx(true)), { token: TOK, spender: RELAY_BASE.approvalProxy, amount: s.amountIn }, 'a sell approves exactly the input to Relay\'s approval proxy');
  const p = await chain.prepare(tx(false)), signed = JSON.parse(Buffer.from(p.raw.slice(2), 'hex').toString());
  assert.equal(signed.to, RELAY_BASE.router); assert.equal(signed.data, swapOf(b).data); assert.equal(signed.value, b.amountIn.toString()); assert.equal(signed.gasLimit, String(200_000n * 13n / 10n + 30_000n));
  assert.ok(!calls.includes('eth_sendRawTransaction'), 'building never sends');
});

test('chain: refuses what the simulation contradicts, a fee, and a 0x Settler that is not the registry\'s current one', async () => {
  const run = async (o: Parameters<typeof world>[0], sell = false, x: Partial<SimTx> = {}) => { const w = world(o); await w.chain.refresh('head'); await w.chain.addAggToken(w.TOK, w.b.amountIn); return (await w.chain.simulate(w.tx(sell, x))).receipt; };
  assert.match((await run({ got: 1n })).reason!, /simulated output 1 is below the minimum/);
  assert.match((await run({ spend: Q('buy-kyber').amountIn + 1n })).reason!, /simulated spend .* exceeds/);
  assert.match((await run({ extra: ['0x' + '55'.repeat(20), 9n] })).reason!, /would also take 9/);
  assert.match((await run({ ok: false })).reason!, /simulation failed: execution reverted/);
  assert.match((await run({}, false, { platformFeeBps: 50 })).reason!, /platform fee is not supported/);
  assert.match((await run({}, false, { minOut: Q('buy-kyber').amountOut + 1n })).reason!, /the price moved/);
  // a 0x-routed buy: the route's Settler must be the registry's
  const w = world({ settler: '0x' + 'ab'.repeat(20) }), z = Q('buy-0x'); (w.chain as any).cfg.relay.client = { quote: async () => z } as any; await w.chain.refresh('head'); await w.chain.addAggToken(z.tokenOut.toLowerCase(), z.amountIn);
  const zt = z.tokenOut.toLowerCase(), r = await w.chain.simulate({ hash: '', wallet: w.W, nonce: 7, venue: w.chain.venues().find(v => v.supports(NATIVE, zt))!.id, tokenIn: NATIVE, tokenOut: zt, amountIn: z.amountIn, minOut: z.minimumOut, deadline: 1_800_000_600, platformFeeBps: 0 });
  assert.match(r.receipt.reason!, /not the current one in 0x's registry/);
});

test('chain: when Relay\'s on-chain minimum lands under ours, it is asked once more with tighter slippage, then refused (mainnet 2026-11-18: 0.008% under)', async () => {
  const w = world(); await w.chain.refresh('head'); await w.chain.addAggToken(w.TOK, w.b.amountIn);
  const asked: (number | undefined)[] = []; (w.chain as any).cfg.relay.client = { quote: async (_w: string, _a: string, _b: string, _n: bigint, slip?: number) => { asked.push(slip); return w.b; } };
  const minOut = w.b.minimumOut + 1n, r = await w.chain.simulate(w.tx(false, { minOut }));   // the route guarantees 1 unit less than we require
  assert.equal(r.receipt.status, 'reverted'); assert.match(r.receipt.reason!, /on-chain minimum .* is below ours/);
  assert.equal(asked.length, 3, 'a plain quote, the transaction, and one retry');
  assert.equal(asked[0], undefined); assert.ok(asked[1]! > 0 && asked[2]! > 0 && asked[2]! < asked[1]!, `the retry asks for tighter slippage: ${asked.join(', ')}`);
  const room = Number((w.b.amountOut - minOut) * 10_000n / w.b.amountOut); assert.ok(asked[1]! <= room - Math.max(2, Math.ceil(room * 0.05)), 'the first request keeps 5% of the room in reserve');
});

test('chain: Relay being rate limited or down keeps the trade waiting (transient); "no route" refuses it', async () => {
  const w = world(); await w.chain.refresh('head'); await w.chain.addAggToken(w.TOK, w.b.amountIn); const tx = w.tx(false);
  (w.chain as any).cfg.relay.client = { quote: async () => { throw new RelayUnavailable('Relay quote failed: HTTP 429'); } };
  await assert.rejects(w.chain.simulate(tx), (e: Error) => e instanceof RpcError && /HTTP 429/.test(e.message));
  (w.chain as any).cfg.relay.client = { quote: async () => { throw new Error('Relay quote failed: HTTP 400: no routes found'); } };
  assert.match((await w.chain.simulate(tx)).receipt.reason!, /no routes found/);
  const seen: number[] = [], c = new RelayClient({ chainId: 8453, retries429: 0, fetchFn: (async () => { seen.push(1); return { ok: false, status: 503, json: async () => ({}) }; }) as any });
  await assert.rejects(c.quote(w.W, NATIVE, w.TOK, 1n), (e: Error) => e instanceof RelayUnavailable && /HTTP 503/.test(e.message));
});

test('chain: a Relay sell\'s receipt books the ETH received from the wallet\'s balance change, and refuses to guess when the block had other transactions', async () => {
  const { chain, TOK, s } = world(); const r = (await chain.receipt('0xh'))!;
  assert.equal(r.status, 'success'); assert.equal(r.deltas[TOK], -s.amountIn); assert.equal(r.deltas[NATIVE], 4_000_000_000_000n, 'ETH in, net of gas, from the balance change'); assert.equal(r.venueFee, 0n);
  await assert.rejects(world({ txsInBlock: 2n }).chain.receipt('0xh'), (e: Error) => e instanceof RpcError && /2 transactions in block/.test(e.message));
});

test('chain: a Relay sell sharing its block with the wallet\'s approval (another trade) books, adding back that approval\'s gas; any other transaction keeps it unbooked', async () => {
  const W = Q('sell').wallet.toLowerCase(), TOK = Q('buy-kyber').tokenOut.toLowerCase();
  const approve = { hash: '0xa1', from: W, to: TOK, value: '0x0', input: '0x095ea7b3' + '00'.repeat(64) }, ours = { hash: '0xh', from: W, to: RELAY_BASE.approvalProxy, value: '0x0', input: '0x' };
  const r = (await world({ txsInBlock: 2n, blockTxs: [approve, ours] }).chain.receipt('0xh'))!;
  assert.equal(r.status, 'success'); assert.equal(r.deltas[NATIVE], 4_000_000_000_000n + 1_000_000n, 'the balance change plus the approval\'s gas (100,000 x 10 wei)');
  const swap = { ...approve, hash: '0xb2', to: '0x' + '44'.repeat(20), input: '0x18cbafe5' };   // a V2 sell for ETH: it may have paid ETH in
  await assert.rejects(world({ txsInBlock: 2n, blockTxs: [swap, ours] }).chain.receipt('0xh'), (e: Error) => e instanceof RpcError && /neither an approval nor a self-send/.test(e.message));
});

test('receipt: Base\'s L1 data fee (receipt l1Fee) is network cost, not trade spend (mainnet 2026-11-18 booked 21440716282 wei of it as spend)', async () => {
  const plain = (await world().chain.receipt('0xh'))!, withL1 = (await world({ l1Fee: 21_440_716_282n }).chain.receipt('0xh'))!;
  assert.equal(plain.network, 1_000_000n, 'gas used x effective price'); assert.equal(withL1.network, 1_000_000n + 21_440_716_282n, 'plus the L1 data fee');
  assert.deepEqual(withL1.deltas, plain.deltas, 'the wallet\'s balance changes are the same: only how they are split between network and trade differs');
});

test('simulateCalls: the wallet\'s net change per token from traced transfers (ETH as 0xeeee...)', async () => {
  const W = '0x' + 'aa'.repeat(20), T = '0x' + 'bb'.repeat(20);
  const rpc = { call: async () => [{ calls: [{ status: '0x1', gasUsed: '0x10', logs: [{ address: KYBER.native, topics: [TRANSFER, pad(W), pad(T)], data: w32(5n) }, { address: T, topics: [TRANSFER, pad(T), pad(W)], data: w32(7n) }, { address: T, topics: [TRANSFER, pad(W), pad(T)], data: w32(2n) }] }] }] };
  const s = await simulateCalls(rpc, W, [{ to: T, data: '0x', value: 5n }]); assert.deepEqual(s.deltas, { [NATIVE]: -5n, [T]: 5n }); assert.equal(s.calls[0].gasUsed, 16n);
});
