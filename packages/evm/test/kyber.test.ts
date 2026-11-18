import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import type { SimTx } from '../../core/src/index.ts';
import { gateKyber, KyberClient, KyberUnavailable, kAddr } from '../src/kyber.ts';
import { AggRefused, decodeKyberSwap, KYBER } from '../src/aggregator.ts';
import { EvmRpcChain } from '../src/rpcchain.ts';
import type { RawSigner } from '../src/rpcchain.ts';
import { keccak256, bytesToHex } from '../src/keccak.ts';

// Real KyberSwap builds on Base (ETH -> ZORA and ZORA -> ETH, recorded read-only 2026-11-18 by POST /base/api/v1/route/build with 1% slippage)
const F = JSON.parse(readFileSync(new URL('./kyberfixture.json', import.meta.url), 'utf8'));
const W = F.wallet as string, ZORA = F.token as string;
const built = (s: any) => ({ to: s.to, data: s.data, value: BigInt(s.value), amountOut: BigInt(s.amountOut) });
const ctx = (s: any, x: Partial<{ wallet: string; minOut: bigint; amountIn: bigint }> = {}) => ({ wallet: W, tokenIn: s.tokenIn, tokenOut: s.tokenOut, amountIn: BigInt(s.amountIn), minOut: decodeKyberSwap(s.data).minReturnAmount, ...x });
/** The calldata with one 32-byte word replaced: `find` (an address or number, as hex without 0x, left-padded) becomes `put`. */
const swapWord = (data: string, find: string, put: string) => { const a = find.toLowerCase().padStart(64, '0'), b = put.toLowerCase().padStart(64, '0'); assert.ok(data.toLowerCase().includes(a), 'word to tamper is in the calldata'); return data.slice(0, 10) + data.slice(10).toLowerCase().replaceAll(a, b); };

test('gateKyber: the real buy and sell pass, and the decoded swap is exactly ours', () => {
  for (const s of [F.buy, F.sell]) {
    const g = gateKyber(built(s), ctx(s));
    assert.equal(g.swap.to, KYBER.router); assert.equal(g.swap.data, s.data); assert.equal(g.swap.value, s.tokenIn === NATIVE ? BigInt(s.amountIn) : 0n);
    const d = decodeKyberSwap(s.data); assert.equal(d.dstReceiver, W.toLowerCase()); assert.equal(d.srcToken, kAddr(s.tokenIn)); assert.equal(d.dstToken, kAddr(s.tokenOut)); assert.equal(d.feeReceivers, 0);
    assert.ok(d.minReturnAmount <= BigInt(s.amountOut) && d.minReturnAmount >= BigInt(s.amountOut) * 98n / 100n, 'about 1% under the quote');
  }
});

test('gateKyber: refuses another router, wrong ETH value, a minimum under ours, another amount, another pair, and another receiver', () => {
  const b = built(F.buy), c = ctx(F.buy);
  assert.throws(() => gateKyber({ ...b, to: '0x' + '12'.repeat(20) }, c), (e: Error) => e instanceof AggRefused && /not its pinned router/.test(e.message));
  assert.throws(() => gateKyber({ ...b, value: b.value + 1n }, c), (e: Error) => e instanceof AggRefused && /sends .* wei/.test(e.message));
  assert.throws(() => gateKyber(b, { ...c, minOut: c.minOut + 1n }), (e: Error) => e instanceof AggRefused && /on-chain minimum .* is below ours/.test(e.message));
  assert.throws(() => gateKyber(b, { ...c, amountIn: c.amountIn - 1n }), (e: Error) => e instanceof AggRefused && /sends .* wei|spends/.test(e.message));
  assert.throws(() => gateKyber(b, { ...c, tokenOut: '0x' + '34'.repeat(20) }), (e: Error) => e instanceof AggRefused && /not this pair/.test(e.message));
  const thief = '0x' + '66'.repeat(20), stolen = { ...b, data: swapWord(b.data, W.slice(2), thief.slice(2)) };
  assert.throws(() => gateKyber(stolen, c), (e: Error) => e instanceof AggRefused && /pays 0x6666/.test(e.message), 'output redirected away from our wallet');
  const s = built(F.sell); assert.throws(() => gateKyber({ ...s, value: 1n }, ctx(F.sell)), (e: Error) => e instanceof AggRefused && /sends 1 wei, not 0/.test(e.message), 'a sell sends no ETH');
});

test('KyberClient: checks the answer is for our trade and router; 429 and 5xx are transient, a 400 is final', async () => {
  const rs = { tokenIn: KYBER.native, tokenOut: ZORA, amountIn: '100', amountOut: '7', route: [[{ exchange: 'aero-cl' }]] };
  const ok = (d: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 0, message: 'successfully', data: d }) });
  let k = new KyberClient({ fetchFn: (async () => ok({ routeSummary: rs, routerAddress: KYBER.router })) as any });
  const q = await k.quote(NATIVE, ZORA, 100n); assert.equal(q.amountOut, 7n); assert.deepEqual(q.path, ['aero-cl']);
  await assert.rejects(k.quote(NATIVE, ZORA, 101n), /different trade/);
  k = new KyberClient({ fetchFn: (async () => ok({ routeSummary: rs, routerAddress: '0x' + '12'.repeat(20) })) as any });
  await assert.rejects(k.quote(NATIVE, ZORA, 100n), (e: Error) => e instanceof AggRefused && /pinned router/.test(e.message));
  let calls = 0; k = new KyberClient({ retries429: 1, fetchFn: (async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; }) as any });
  await assert.rejects(k.quote(NATIVE, ZORA, 100n), (e: Error) => e instanceof KyberUnavailable); assert.equal(calls, 2, 'asked once more after the 429');
  k = new KyberClient({ fetchFn: (async () => ({ ok: false, status: 502, json: async () => ({}) })) as any }); await assert.rejects(k.quote(NATIVE, ZORA, 100n), (e: Error) => e instanceof KyberUnavailable);
  k = new KyberClient({ fetchFn: (async () => ({ ok: false, status: 400, json: async () => ({ code: 4008, message: 'route not found' }) })) as any });
  await assert.rejects(k.quote(NATIVE, ZORA, 100n), (e: Error) => !(e instanceof KyberUnavailable) && /route not found/.test(e.message));
});

// ---- the chain with KyberSwap instead of Relay: a mock node (eth_simulateV1 with transfer logs, allowance, balances for receipts) and a stand-in client returning the real builds
const TRANSFER = bytesToHex(keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))), pad = (a: string) => '0x' + a.toLowerCase().slice(2).padStart(64, '0'), w32 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0'), hx = (n: bigint | number) => '0x' + n.toString(16);
const signer: RawSigner = { sign: r => '0x' + Buffer.from(JSON.stringify({ ...r, value: r.value.toString(), gasLimit: r.gasLimit.toString(), maxFeePerGas: r.maxFeePerGas.toString(), maxPriorityFeePerGas: r.maxPriorityFeePerGas.toString() })).toString('hex') };
function world(o: { got?: bigint; allowance?: bigint; build?: (s: any) => any } = {}) {
  const w = W.toLowerCase(), T = ZORA.toLowerCase(), asked: string[] = [];
  const rpc = { call: async (m: string, p: any[] = []): Promise<any> => {
    if (m === 'eth_getBlockByNumber') return { number: hx(100), timestamp: hx(1_800_000_000) }; if (m === 'eth_gasPrice') return hx(10_000_000n);
    if (m === 'eth_call') { if (p[0].data.startsWith('0xdd62ed3e')) return w32(o.allowance ?? 0n); throw new Error('unscripted eth_call'); }
    if (m === 'eth_simulateV1') { const cs = p[0].blockStateCalls[0].calls as any[], last = cs[cs.length - 1], sell = BigInt(last.value) === 0n;
      const logs = sell ? [{ address: T, topics: [TRANSFER, pad(w), pad(KYBER.router)], data: w32(BigInt(F.sell.amountIn)) }, { address: KYBER.native, topics: [TRANSFER, pad(KYBER.router), pad(w)], data: w32(o.got ?? BigInt(F.sell.amountOut)) }]
        : [{ address: KYBER.native, topics: [TRANSFER, pad(w), pad(KYBER.router)], data: w32(BigInt(F.buy.amountIn)) }, { address: T, topics: [TRANSFER, pad(KYBER.router), pad(w)], data: w32(o.got ?? BigInt(F.buy.amountOut)) }];
      return [{ calls: cs.map((_, i) => ({ status: '0x1', gasUsed: hx(150_000), logs: i === cs.length - 1 ? logs : [] })) }]; }
    if (m === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: hx(101), gasUsed: hx(100_000), effectiveGasPrice: hx(10n), from: w, logs: [{ address: T, topics: [TRANSFER, pad(w), pad(KYBER.router)], data: w32(BigInt(F.sell.amountIn)) }] };
    if (m === 'eth_getTransactionByHash') return { to: KYBER.router, value: '0x0', input: F.sell.data };
    if (m === 'eth_getTransactionCount') return hx(p[1] === hx(101n) ? 6n : 5n);
    if (m === 'eth_getBalance') return hx(p[1] === hx(101n) ? 1_000_000_000_000_000n + 2_000_000_000n : 1_000_000_000_000_000n);
    throw new Error(`unscripted ${m}`); } };
  const pick = (tin: string) => (tin === NATIVE ? F.buy : F.sell);
  const client = { quote: async (tin: string, _o: string, amt: bigint) => { asked.push(`quote ${tin === NATIVE ? 'buy' : 'sell'} ${amt}`); return { amountOut: BigInt(pick(tin).quotedOut), routeSummary: { tin }, path: pick(tin).path }; },
    build: async (q: any, wallet: string, slip: number) => { asked.push(`build ${wallet} ${slip}`); return (o.build ?? built)(pick(q.routeSummary.tin)); } } as unknown as KyberClient;
  const chain = new EvmRpcChain({ id: 'base-test', chainId: 8453, router: '0x' + '44'.repeat(20), weth: '0x4200000000000000000000000000000000000006', pools: [], kyber: { client } }, rpc, signer);
  const tx = (sell: boolean, x: Partial<SimTx> = {}): SimTx => { const s = sell ? F.sell : F.buy; return { hash: '', wallet: w, nonce: 7, venue: chain.venues().find(v => v.supports(sell ? T : NATIVE, sell ? NATIVE : T))!.id, tokenIn: sell ? T : NATIVE, tokenOut: sell ? NATIVE : T,
    amountIn: BigInt(s.amountIn), minOut: decodeKyberSwap(s.data).minReturnAmount, deadline: 1_800_000_600, platformFeeBps: 0, ...x }; };
  return { chain, tx, asked, T };
}

test('chain with KyberSwap: venues both ways; buy and sell gated and simulated; a sell approves exactly the input to KyberSwap\'s router; only the router call is signed', async () => {
  const { chain, tx, T, asked } = world(); await chain.refresh('head');
  assert.equal(chain.aggKind, 'kyberswap'); assert.equal(await chain.addAggToken(T, BigInt(F.buy.amountIn)), true);
  assert.ok(chain.venues().every(v => v.family === 'kyberswap'), 'the venues are KyberSwap ones'); assert.ok(chain.venues().every(v => v.id.startsWith('kyber:')));
  const buy = await chain.simulate(tx(false)); assert.equal(buy.receipt.status, 'success', buy.receipt.reason);
  const sell = await chain.simulate(tx(true)); assert.equal(sell.receipt.status, 'success', sell.receipt.reason);
  assert.deepEqual(await chain.needsApproval(tx(true)), { token: T, spender: KYBER.router, amount: BigInt(F.sell.amountIn) });
  const p = await chain.prepare(tx(false)), signed = JSON.parse(Buffer.from(p.raw.slice(2), 'hex').toString());
  assert.equal(signed.to, KYBER.router); assert.equal(signed.data, F.buy.data); assert.equal(signed.value, F.buy.amountIn);
  assert.ok(asked.some(a => a.startsWith(`build ${W.toLowerCase()} `)), 'built for our wallet');
});

test('chain with KyberSwap: refuses what the simulation contradicts and a tampered build; a KyberSwap outage keeps the trade waiting', async () => {
  const run = async (o: Parameters<typeof world>[0], sell = false) => { const w = world(o); await w.chain.refresh('head'); await w.chain.addAggToken(w.T, BigInt(F.buy.amountIn)); return (await w.chain.simulate(w.tx(sell))).receipt; };
  assert.match((await run({ got: 1n })).reason!, /simulated output 1 is below the minimum/);
  assert.match((await run({ build: s => ({ ...built(s), to: '0x' + '12'.repeat(20) }) })).reason!, /not its pinned router/);
  assert.match((await run({ build: s => ({ ...built(s), data: swapWord(s.data, W.slice(2), '66'.repeat(20)) }) })).reason!, /pays 0x6666/);
  const w = world(); await w.chain.refresh('head'); await w.chain.addAggToken(w.T, BigInt(F.buy.amountIn)); const t = w.tx(false);
  (w.chain as any).cfg.kyber.client = { quote: async () => { throw new KyberUnavailable('KyberSwap routes failed: HTTP 429'); } };
  await assert.rejects(w.chain.simulate(t), (e: Error) => e instanceof RpcError && /HTTP 429/.test(e.message));
});

test('chain with KyberSwap: a sell\'s receipt reads the ETH received from the wallet\'s balance change (the router pays ETH with an internal transfer)', async () => {
  const { chain, T } = world(); const r = (await chain.receipt('0xh'))!;
  assert.equal(r.status, 'success'); assert.equal(r.deltas[T], -BigInt(F.sell.amountIn)); assert.equal(r.deltas[NATIVE], 2_000_000_000n, 'ETH in, net of gas, from the balance change');
  // the same receipt after the server switched back to Relay (the trade was sent through KyberSwap before): still read from the balance change
  (chain as any).cfg.kyber = undefined; (chain as any).cfg.relay = { client: {} };
  assert.equal((await chain.receipt('0xh'))!.deltas[NATIVE], 2_000_000_000n, 'a KyberSwap sell is still recognised after switching aggregator');
});

// Real KyberSwap builds on Robinhood Chain (chain 4663, chain name 'robinhood'): ETH -> TSLA and TSLA -> ETH, recorded read-only 2026-11-19. The router there is the same
// address with its own code (13,724 bytes); the calldata decodes the same way, so the same gate applies.
const RH = JSON.parse(readFileSync(new URL('./kyberfixture-robinhood.json', import.meta.url), 'utf8'));
test('gateKyber on Robinhood Chain: the real TSLA buy and sell pass; another receiver or a low minimum is refused', () => {
  for (const s of [RH.buy, RH.sell]) {
    const b = built(s), c = { wallet: RH.wallet, tokenIn: s.tokenIn, tokenOut: s.tokenOut, amountIn: BigInt(s.amountIn), minOut: decodeKyberSwap(s.data).minReturnAmount };
    assert.equal(gateKyber(b, c).swap.to, KYBER.router);
    assert.throws(() => gateKyber(b, { ...c, minOut: c.minOut + 1n }), (e: Error) => e instanceof AggRefused && /on-chain minimum/.test(e.message));
    assert.throws(() => gateKyber({ ...b, data: swapWord(b.data, RH.wallet.slice(2), '66'.repeat(20)) }, c), (e: Error) => e instanceof AggRefused && /pays 0x6666/.test(e.message));
  }
  assert.equal(RH.chainId, 4663);
});
