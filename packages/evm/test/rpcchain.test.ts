import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Router, Store, PolicySigner, NATIVE } from '../../core/src/index.ts';
import type { Intent, WalletPolicy } from '../../core/src/index.ts';
import { EvmRpcChain, JsonRpcError, getAmountOut, encodeParams, keccak256, hexToBytes, bytesToHex } from '../src/index.ts';
import type { RawSigner } from '../src/index.ts';
import { A } from './fixtures.ts';

// MOCK NODE: logic only. It proves how our adapter reacts to node behaviour we OBSERVED on real nodes (see docs/live-verification), not that any real node behaves so.
const WETH = A(0x1001), TOKEN = A(0x2002), PAIR = A(0x9999), ROUTER = A(0xdddd), WALLET = A(0xabc), CHAIN = 1;
const TRANSFER = bytesToHex(keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')));
const WITHDRAWAL = bytesToHex(keccak256(new TextEncoder().encode('Withdrawal(address,uint256)')));
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0'); const w32 = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const APPROVE = '0x095ea7b3', SELL_ETH = bytesToHex(keccak256(new TextEncoder().encode('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'))).slice(0, 10);
const hx = (n: number | bigint) => '0x' + n.toString(16);

const signer: RawSigner = { sign: r => '0x' + Buffer.from(JSON.stringify({ ...r, value: r.value.toString(), gasLimit: r.gasLimit.toString(), maxFeePerGas: r.maxFeePerGas.toString(), maxPriorityFeePerGas: r.maxPriorityFeePerGas.toString() })).toString('hex') };
const decodeRaw = (raw: string) => JSON.parse(Buffer.from(raw.slice(2), 'hex').toString());

class MockNode {
  block = 100; time = 1_700_000_000; gasPrice = 1_000_000_000n; r0 = 10_000_000_000_000_000_000n; r1 = 20_000_000_000n;   // WETH reserve, TOKEN reserve
  nonce = new Map<string, number>(); pending = new Map<string, any>(); receipts = new Map<string, any>(); txs = new Map<string, any>();
  allowance = new Map<string, bigint>(); calls: string[] = []; dropAckOnce = false; simRevert: string | undefined; rejectSend: string | undefined;
  async call<T = any>(method: string, p: any[] = []): Promise<T> {
    this.calls.push(method);
    switch (method) {
      case 'eth_getBlockByNumber': return { number: hx(this.block), timestamp: hx(this.time) } as any;
      case 'eth_blockNumber': return hx(this.block) as any;
      case 'eth_gasPrice': return hx(this.gasPrice) as any;
      case 'eth_estimateGas': return hx(150_000) as any;
      case 'eth_getTransactionCount': return hx(this.nonce.get(p[0]) ?? 0) as any;
      case 'eth_call': {
        const q = p[0]; if (q.to === PAIR) { const s = q.data.slice(0, 10);
          if (s === '0x0dfe1681') return pad(WETH) as any; if (s === '0xd21220a7') return pad(TOKEN) as any; if (s === '0x0902f1ac') return (w32(this.r0) + w32(this.r1).slice(2) + w32(1n).slice(2)) as any; }
        if (q.to === TOKEN && q.data.startsWith('0xdd62ed3e')) return w32(this.allowance.get('0x' + q.data.slice(34, 74)) ?? 0n) as any;   // allowance(owner, spender)
        if (this.simRevert) throw new JsonRpcError(this.simRevert); return '0x' as any;
      }
      case 'eth_sendRawTransaction': {
        if (this.rejectSend) throw new JsonRpcError(this.rejectSend);
        const raw = p[0] as string, hash = bytesToHex(keccak256(hexToBytes(raw))), t = decodeRaw(raw);
        if (this.pending.has(hash) || this.receipts.has(hash)) throw new JsonRpcError('already known');
        if (t.nonce < (this.nonce.get(t.wallet) ?? 0)) throw new JsonRpcError('nonce too low');
        this.pending.set(hash, { hash, ...t }); this.txs.set(hash, { hash, from: t.wallet, to: t.to, value: hx(BigInt(t.value)), blockNumber: null });
        if (this.dropAckOnce) { this.dropAckOnce = false; throw new Error('connection reset by peer'); }
        return hash as any;
      }
      case 'eth_getTransactionReceipt': return (this.receipts.get(p[0]) ?? null) as any;
      case 'eth_getTransactionByHash': return (this.txs.get(p[0]) ?? null) as any;
    }
    throw new Error(`mock: unhandled ${method}`);
  }
  mine(n = 1, o: { revert?: boolean } = {}) {
    for (let i = 0; i < n; i++) {
      this.block++; this.time += 12;
      for (const t of [...this.pending.values()].sort((a, b) => a.nonce - b.nonce)) {
        if (t.nonce !== (this.nonce.get(t.wallet) ?? 0)) continue;
        this.pending.delete(t.hash); this.nonce.set(t.wallet, t.nonce + 1);
        const logs: any[] = []; const value = BigInt(t.value); const data: string = t.data ?? '0x';
        const word = (k: number) => BigInt('0x' + data.slice(10 + 64 * k, 74 + 64 * k));
        if (!o.revert && data.startsWith(APPROVE)) this.allowance.set(t.wallet, word(1));
        else if (data.startsWith(SELL_ETH)) {
          const amt = word(0);
          if (o.revert || (this.allowance.get(t.wallet) ?? 0n) < amt) o = { revert: true };
          else { this.allowance.set(t.wallet, this.allowance.get(t.wallet)! - amt); const out = getAmountOut(amt, this.r1, this.r0); this.r1 += amt; this.r0 -= out;
            logs.push({ address: TOKEN, topics: [TRANSFER, pad(t.wallet), pad(PAIR)], data: w32(amt) }, { address: WETH, topics: [WITHDRAWAL, pad(ROUTER)], data: w32(out) }); }
        } else if (!o.revert && value > 0n) { const out = getAmountOut(value, this.r0, this.r1); this.r0 += value; this.r1 -= out;
          logs.push({ address: TOKEN, topics: [TRANSFER, pad(PAIR), pad(t.wallet)], data: w32(out) }); }
        const rc = { transactionHash: t.hash, from: t.wallet, status: o.revert ? '0x0' : '0x1', blockNumber: hx(this.block), gasUsed: hx(120_000), effectiveGasPrice: hx(this.gasPrice), logs };
        this.receipts.set(t.hash, rc); this.txs.set(t.hash, { ...this.txs.get(t.hash), blockNumber: hx(this.block) });
      }
    }
  }
}
function setup(o: { platformFeeBps?: number } = {}) {
  const node = new MockNode();
  const chain = new EvmRpcChain({ id: 'evm-mock', chainId: CHAIN, router: ROUTER, weth: WETH, pools: [{ id: 'uni:T', pair: PAIR }], finalityDepth: 3 }, node, signer);
  const pol: WalletPolicy = { userId: 'u1', chains: ['evm-mock'], allowedVenues: ['uniswap-v2'], maxPerTx: { [NATIVE]: 10n ** 18n, [TOKEN]: 10n ** 18n }, dailyLimit: { [NATIVE]: 10n ** 19n, [TOKEN]: 10n ** 19n }, destinations: [], deviceSecret: 'd' };
  const psigner = new PolicySigner(new Map([[WALLET, 'k']]), new Map([[WALLET, pol]]));
  const mk = (store: Store) => new Engine({ store, chain, signer: psigner, router: new Router(chain), platformFeeBps: o.platformFeeBps ?? 0 });
  const store = new Store(); const engine = mk(store);
  const intent = (key: string, x: Partial<Intent> = {}): Intent => ({ idempotencyKey: key, userId: 'u1', walletId: WALLET, chain: 'evm-mock', tokenIn: NATIVE, tokenOut: TOKEN, amountIn: 10n ** 17n, minOut: 0n, slippageBps: 100, deadline: node.time + 600, maxFeeBps: 200, venues: ['uniswap-v2'], origin: 'manual', ...x });
  return { node, chain, engine, store, mk, intent, psigner, pol };
}

test('buy through the RPC adapter: finalized, fill = Transfer log to the wallet, network fee = gasUsed*effectiveGasPrice, hash = keccak(raw)', async () => {
  const s = setup(); let r = await s.engine.submit(s.intent('b1'));
  assert.ok(['submitted', 'observed'].includes(r.state), r.state);
  assert.equal(r.tx!.hash, bytesToHex(keccak256(hexToBytes(r.tx!.raw!))));
  const quoted = r.quote!.amountOut; s.node.mine(); r = await s.engine.advance('b1'); assert.equal(r.state, 'confirmed');
  s.node.mine(2); r = await s.engine.advance('b1'); assert.equal(r.state, 'finalized');
  const f = r.fill!; assert.equal(f.received, quoted); assert.equal(f.spent, 10n ** 17n); assert.equal(f.networkFee, 120_000n * 1_000_000_000n); assert.equal(f.platformFee, 0n);
});
test('lost submit ack: reconcile finds the SAME tx at the node; no second send; one execution', async () => {
  const s = setup(); s.node.dropAckOnce = true; let r = await s.engine.submit(s.intent('ack'));
  assert.ok(['submitted', 'observed'].includes(r.state), r.state); assert.equal(s.node.pending.size, 1);
  const sends = () => s.node.calls.filter(c => c === 'eth_sendRawTransaction').length; const before = sends();
  s.node.mine(4); r = await s.engine.advance('ack'); assert.equal(r.state, 'finalized'); assert.equal(sends(), before); assert.equal(s.node.nonce.get(WALLET), 1);
});
test('identical resubmit answered "already known" counts as success, not a failure', async () => {
  const s = setup(); const r = await s.engine.submit(s.intent('dupe')); assert.ok(r.tx!.raw);
  assert.equal(await s.chain.submit(r.tx!), r.tx!.hash);   // node says "already known"
});
test('node rejection ("nonce too low") fails the trade visibly and releases the signer charge', async () => {
  const s = setup(); s.node.rejectSend = 'nonce too low: next nonce 5, tx nonce 0';
  const r = await s.engine.submit(s.intent('rej')); assert.equal(r.state, 'failed'); assert.match(r.failure!, /nonce too low/); assert.equal(s.node.pending.size, 0);
});
test('on-chain revert: failed, no fill, gas still reported', async () => {
  const s = setup(); await s.engine.submit(s.intent('rv')); s.node.mine(1, { revert: true });
  const r = await s.engine.advance('rv'); assert.equal(r.state, 'failed'); assert.match(r.failure!, /reverted on-chain/); assert.equal(r.fill, undefined);
  const rc = await s.chain.receipt(r.tx!.hash); assert.equal(rc!.status, 'reverted'); assert.equal(rc!.network, 120_000n * 1_000_000_000n); assert.equal(rc!.deltas[NATIVE], -rc!.network);
});
test('simulation revert (eth_call) fails before anything is signed or sent, with the node reason', async () => {
  const s = setup(); s.node.simRevert = 'execution reverted: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT';
  const r = await s.engine.submit(s.intent('sim')); assert.equal(r.state, 'failed'); assert.match(r.failure!, /INSUFFICIENT_OUTPUT_AMOUNT/); assert.equal(s.node.calls.includes('eth_sendRawTransaction'), false);
});
test('platform fee > 0 is refused for real-node trading instead of being booked as collected', async () => {
  const s = setup({ platformFeeBps: 100 }); const r = await s.engine.submit(s.intent('fee'));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /no on-chain fee router is configured/); assert.equal(s.node.calls.includes('eth_sendRawTransaction'), false);
});
test('restart: a new engine over restored state resumes the same tx; one execution', async () => {
  const s = setup(); s.node.dropAckOnce = true; await s.engine.submit(s.intent('rs'));
  const e2 = s.mk(Store.restore(s.store.snapshot())); s.node.mine(4); const r = await e2.advance('rs');
  assert.equal(r.state, 'finalized'); assert.equal(s.node.nonce.get(WALLET), 1);
});
test('node unreachable keeps the trade resumable; recovers when the node returns', async () => {
  const s = setup(); const real = s.node.call.bind(s.node); let down = true;
  (s.node as any).call = async (m: string, p: any[]) => { if (down) throw new Error('ECONNREFUSED'); return real(m, p); };
  let r = await s.engine.submit(s.intent('down')); assert.ok(!['failed', 'finalized'].includes(r.state), r.state);
  down = false; r = await s.engine.advance('down'); s.node.mine(4); r = await s.engine.advance('down'); assert.equal(r.state, 'finalized');
});
test('sell receipt: token leaves the wallet, native arrives via the router WETH Withdrawal; fill and fee derive from the receipt', async () => {
  const s = setup(); const hash = '0x' + 'cd'.repeat(32);
  s.node.txs.set(hash, { hash, from: WALLET, to: ROUTER, value: '0x0', blockNumber: hx(101) });
  s.node.receipts.set(hash, { transactionHash: hash, from: WALLET, status: '0x1', blockNumber: hx(101), gasUsed: hx(100_000), effectiveGasPrice: hx(1_000_000_000), logs: [
    { address: TOKEN, topics: [TRANSFER, pad(WALLET), pad(PAIR)], data: w32(5_000n) },
    { address: WETH, topics: [WITHDRAWAL, pad(ROUTER)], data: w32(777_000n) }] });
  const rc = (await s.chain.receipt(hash))!;
  assert.equal(rc.deltas[TOKEN], -5_000n); assert.equal(rc.deltas[NATIVE], 777_000n - 100_000n * 1_000_000_000n); assert.equal(rc.network, 100_000n * 1_000_000_000n); assert.equal(rc.venueFee, 5_000n - 5_000n * 997n / 1000n);
});
test('a Withdrawal not emitted by the configured WETH or not from the router is ignored', async () => {
  const s = setup(); const hash = '0x' + 'ef'.repeat(32);
  s.node.txs.set(hash, { hash, from: WALLET, to: ROUTER, value: '0x0', blockNumber: hx(101) });
  s.node.receipts.set(hash, { transactionHash: hash, from: WALLET, status: '0x1', blockNumber: hx(101), gasUsed: hx(1), effectiveGasPrice: hx(1), logs: [
    { address: A(0xbad), topics: [WITHDRAWAL, pad(ROUTER)], data: w32(999n) }, { address: WETH, topics: [WITHDRAWAL, pad(A(0xbeef))], data: w32(999n) }] });
  assert.equal((await s.chain.receipt(hash))!.deltas[NATIVE], -1n);
});

// ---- approval step
const SELL = 5_000_000_000n;
const sell = (s: ReturnType<typeof setup>, key: string, x: Partial<Intent> = {}) => s.intent(key, { tokenIn: TOKEN, tokenOut: NATIVE, amountIn: SELL, ...x });
const run = async (s: ReturnType<typeof setup>, key: string, blocks = 6) => { let r = await s.engine.advance(key); for (let i = 0; i < blocks && !['finalized', 'failed', 'expired'].includes(r.state); i++) { s.node.mine(); r = await s.engine.advance(key); } return r; };

test('sell with no allowance: the engine approves EXACTLY the sell amount as a child tx, then sells; native proceeds come from the receipt', async () => {
  const s = setup(); await s.engine.submit(sell(s, 'sl1')); const r = await run(s, 'sl1');
  assert.equal(r.state, 'finalized', r.failure); const child = s.store.records.get('sl1:approve')!;
  assert.ok(child && child.state === 'finalized' && child.tx!.kind === 'approve' && child.tx!.amountIn === SELL && child.tx!.spender === ROUTER);
  assert.equal(child.fill, undefined); assert.equal(child.tx!.nonce, 0); assert.equal(r.tx!.nonce, 1);
  assert.equal(s.node.allowance.get(WALLET), 0n, 'allowance fully used, never unlimited');
  assert.equal(r.fill!.spent, SELL); assert.equal(r.fill!.received, r.quote!.amountOut); assert.equal(r.fill!.networkFee, 120_000n * 1_000_000_000n);
  assert.equal(s.node.calls.filter(c => c === 'eth_sendRawTransaction').length, 2);
});
test('approve is not charged to the daily limit: only the sell counts', async () => {
  const s = setup(); await s.engine.submit(sell(s, 'sl2')); await run(s, 'sl2');
  const day = Math.floor(s.chain.time / 86400);
  assert.equal(s.psigner.spentFor(WALLET, TOKEN, day), SELL);
});
test('sufficient existing allowance: no approval transaction is created', async () => {
  const s = setup(); s.node.allowance.set(WALLET, SELL * 2n); await s.engine.submit(sell(s, 'sl3')); const r = await run(s, 'sl3');
  assert.equal(r.state, 'finalized'); assert.equal(s.store.records.has('sl3:approve'), false); assert.equal(s.node.calls.filter(c => c === 'eth_sendRawTransaction').length, 1);
});
test('approval rejected by the node: the sell is never sent and fails with the reason', async () => {
  const s = setup(); s.node.rejectSend = 'insufficient funds for gas * price + value'; const r = await s.engine.submit(sell(s, 'sl4'));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /approval failed: .*insufficient funds/); assert.equal(s.store.records.get('sl4:approve')!.state, 'failed');
});
test('approval reverts on-chain: the sell fails, is never sent', async () => {
  const s = setup(); await s.engine.submit(sell(s, 'sl5')); s.node.mine(1, { revert: true });
  const r = await s.engine.advance('sl5'); assert.equal(r.state, 'failed'); assert.match(r.failure!, /approval failed: .*reverted on-chain/); assert.equal(s.node.calls.filter(c => c === 'eth_sendRawTransaction').length, 1);
});
test('approval above the per-tx limit is denied by the policy signer; nothing is sent', async () => {
  const s = setup(); const r = await s.engine.submit(sell(s, 'sl6', { amountIn: 2n * 10n ** 18n }));
  assert.equal(r.state, 'failed'); assert.match(r.failure!, /approval failed: signer policy: exceeds per-tx limit/); assert.equal(s.node.calls.includes('eth_sendRawTransaction'), false);
});
test('restart while the approval is pending: the new engine resumes the same approval (no second approve), then sells', async () => {
  const s = setup(); await s.engine.submit(sell(s, 'sl7')); assert.equal(s.node.pending.size, 1);
  const e2 = s.mk(Store.restore(s.store.snapshot())); const r = await (async () => { let x = await e2.advance('sl7'); for (let i = 0; i < 6 && x.state !== 'finalized' && x.state !== 'failed'; i++) { s.node.mine(); x = await e2.advance('sl7'); } return x; })();
  assert.equal(r.state, 'finalized', r.failure); assert.equal(s.node.calls.filter(c => c === 'eth_sendRawTransaction').length, 2);
});
test('approving more than once for the same sell key never happens (child key is deterministic)', async () => {
  const s = setup(); await s.engine.submit(sell(s, 'sl8')); await Promise.all([s.engine.advance('sl8'), s.engine.advance('sl8'), s.engine.submit(sell(s, 'sl8'))]);
  await run(s, 'sl8'); assert.equal([...s.store.records.keys()].filter(k => k.startsWith('sl8:approve')).length, 1); assert.equal(s.node.calls.filter(c => c === 'eth_sendRawTransaction').length, 2);
});

test('balanceOf reads native and token balances; loaded pool venue reports a spot price and marginal quote ordering', async () => {
  const s = setup(); const real = s.node.call.bind(s.node);
  (s.node as any).call = async (m: string, p: any[]) => m === 'eth_getBalance' ? hx(777n) : (m === 'eth_call' && p[0].data?.startsWith('0x70a08231')) ? w32(4242n) : real(m, p);
  assert.equal(await s.chain.balanceOf(WALLET, NATIVE), 777n); assert.equal(await s.chain.balanceOf(WALLET, TOKEN), 4242n);
  await s.chain.refresh('venues'); const v: any = s.chain.venues()[0];
  assert.equal(v.spotPriceE18(TOKEN, NATIVE), s.node.r0 * 10n ** 18n / s.node.r1); assert.equal(v.spotPriceE18(NATIVE, TOKEN), s.node.r1 * 10n ** 18n / s.node.r0);
});

test('a pool reload costs one eth_call after the first load: a pair\'s tokens never change, only reserves do', async () => {
  const s = setup(); await s.chain.refresh('venues');
  const count = () => s.node.calls.filter(c => c === 'eth_call').length; const first = count();
  s.node.r0 = 11_000_000_000_000_000_000n; await s.chain.refresh('venues'); const second = count() - first;
  assert.equal(first, 3, 'first load reads token0, token1 and reserves'); assert.equal(second, 1, 'a reload reads only the reserves');
  const v: any = s.chain.venues()[0]; assert.equal(v.spotPriceE18(TOKEN, NATIVE), s.node.r0 * 10n ** 18n / s.node.r1, 'the new reserves are what the venue quotes from');
});
