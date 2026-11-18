/** SHARED PIECES for aggregator venues on EVM chains (relay.ts uses them): a reference-quote venue, the exact balance-change simulation, and the KyberSwap swap decoder
 *  (Relay routes some same-chain swaps through KyberSwap; the decoder reads that inner swap's on-chain minimum).
 *   - `simulateCalls` runs the exact transactions (with an exact approve before them when the allowance is short) through `eth_simulateV1` with transfer tracing, so the
 *     wallet's real balance changes can be checked before signing: at most the input spent, at least the minimum received, and no other token leaving the wallet.
 *     `eth_simulateV1` with `traceTransfers` (native ETH shows as transfers from 0xeeee...eeee) answered on https://mainnet.base.org (2026-11-18).
 *   - KyberSwap's router `MetaAggregationRouterV2` 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 (code on Base, 18,312 bytes): selector 0xe21fd0e9 and the description layout
 *     were decoded from real builds (ETH -> NVDAc and back) and matched what the API reported (amount, receiver, minimum = quote - slippage).
 *  Coinbase's stock tokens on Base are B20 precompiles: an anvil fork cannot execute them (OpcodeNotFound), so these routes are checked against a real Base node, read-only. */
import type { Venue, Quote } from '../../core/src/index.ts';
import { NATIVE } from '../../core/src/index.ts';

export const KYBER = { router: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', swapSelector: '0xe21fd0e9', native: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } as const;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const lc = (s: string) => s.toLowerCase();

/** Thrown when a gate or a check refuses an aggregator transaction. Never retried: the caller treats it as a hard stop. */
export class AggRefused extends Error {}

/** The swap description inside KyberSwap's `swap(SwapExecutionParams)` calldata: (callTarget, approveTarget, targetData, desc, clientData), desc = (srcToken, dstToken,
 *  srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[], dstReceiver, amount, minReturnAmount, flags, permit). Throws on anything that does not parse. */
export function decodeKyberSwap(data: string) {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.slice(0, 10).toLowerCase() !== KYBER.swapSelector) throw new AggRefused(`not a KyberSwap swap call (selector ${data.slice(0, 10)})`);
  const body = data.slice(10), words = body.length / 64; if (!Number.isInteger(words) || words < 16) throw new AggRefused('swap calldata is too short');
  const w = (i: bigint) => { if (i < 0n || i >= BigInt(words)) throw new AggRefused('swap calldata offset out of range'); const n = Number(i); return BigInt('0x' + body.slice(n * 64, n * 64 + 64)); };
  const at = (byteOff: bigint, k: number) => { if (byteOff % 32n) throw new AggRefused('misaligned offset in swap calldata'); return w(byteOff / 32n + BigInt(k)); };
  const addr = (x: bigint) => { if (x >> 160n) throw new AggRefused('a malformed address in swap calldata'); return '0x' + x.toString(16).padStart(40, '0'); };
  const exec = w(0n), desc = exec + at(exec, 3), fees = desc + at(desc, 4);
  return { callTarget: addr(at(exec, 0)), srcToken: addr(at(desc, 0)), dstToken: addr(at(desc, 1)), feeReceivers: Number(at(fees, 0)), dstReceiver: addr(at(desc, 6)), amount: at(desc, 7), minReturnAmount: at(desc, 8) };
}

/** Simulates calls in order from `wallet` with eth_simulateV1 (transfer tracing) and returns each call's status and gas, and the wallet's net balance change per token
 *  (NATIVE for ETH value transfers; gas is not included). Throws if the node cannot simulate. */
export async function simulateCalls(rpc: { call<T = any>(m: string, p?: unknown[]): Promise<T> }, wallet: string, calls: { to: string; data: string; value: bigint }[]) {
  const w = lc(wallet), hex = (n: bigint) => '0x' + n.toString(16);
  const r: any = await rpc.call('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(c => ({ from: w, to: lc(c.to), data: c.data, value: hex(c.value) })) }], traceTransfers: true, validation: false }, 'latest']);
  const res = (r?.[0]?.calls ?? []) as any[]; if (res.length !== calls.length) throw new Error('eth_simulateV1 returned an unexpected shape');
  const deltas: Record<string, bigint> = {}, add = (k: string, v: bigint) => { deltas[k] = (deltas[k] ?? 0n) + v; }, pad = w.slice(2);
  for (const c of res) for (const l of (c.logs ?? []) as any[]) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3) continue;
    const token = lc(l.address) === KYBER.native ? NATIVE : lc(l.address), amt = BigInt(l.data);
    if (l.topics[1].endsWith(pad)) add(token, -amt); if (l.topics[2].endsWith(pad)) add(token, amt);
  }
  return { calls: res.map(c => ({ ok: c.status === '0x1', gasUsed: BigInt(c.gasUsed ?? '0x0'), error: c.error?.message as string | undefined })), deltas };
}

/** An aggregator route for ONE direction of ONE pair, as a reference snapshot: quote(amount) scales it linearly (optimistic for large sizes). The real route is quoted
 *  again at the exact amount when the transaction is made, gated and simulated, and refused if it cannot meet the engine's minOut. */
export class AggVenue implements Venue {
  kind = 'cpamm' as const; status: 'active' | 'graduated' = 'active';
  constructor(public id: string, public tokenIn: string, public tokenOut: string, public refIn: bigint, public refOut: bigint, public block = 0, public family = 'relay') {}
  supports(a: string, b: string) { return a === this.tokenIn && b === this.tokenOut; }
  quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'> { if (!this.supports(a, b)) throw new Error('unsupported pair'); return { venue: this.id, family: this.family, amountOut: this.refOut * amt / this.refIn, priceImpactBps: 0, venueFee: 0n, liquidity: this.refOut }; }
  spotPriceE18(a: string, b: string) { if (!this.supports(a, b)) throw new Error('unsupported pair'); return this.refOut * 10n ** 18n / this.refIn; }
  swap(a: string, b: string, amt: bigint) { return { amountOut: this.quote(a, b, amt).amountOut, venueFee: 0n }; }
  clone() { return new AggVenue(this.id, this.tokenIn, this.tokenOut, this.refIn, this.refOut, this.block, this.family); }
}
