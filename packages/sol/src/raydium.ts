/** Raydium AMM v4 (constant product, order-book-backed) pool: layout decode, quote, key loading, and a `Venue` for the engine.
 *  Layout offsets from raydium-io/raydium-sdk-V2 (liquidity/layout.ts, serum/layout.ts); every derived key is cross-checked against on-chain data at load time.
 *  Known gap: the pool's open-orders balances are NOT added to the reserves (that layout is not sourced), so quotes are slightly conservative on pools with resting orders. */
import type { Venue, Quote } from '../../core/src/index.ts';
import { base58, findProgramAddress, createProgramAddress, pubkeyBytes, u64le } from './tx.ts';
import type { PoolKeys } from './tx.ts';

export const AMM_V4_LAYOUT = { size: 752, baseDecimal: 32, quoteDecimal: 40, status: 0, swapFeeNumerator: 176, swapFeeDenominator: 184, baseNeedTakePnl: 192, quoteNeedTakePnl: 200,
  poolOpenTime: 224, baseVault: 336, quoteVault: 368, baseMint: 400, quoteMint: 432, lpMint: 464, openOrders: 496 } as const;
const POOL_OFF = { marketId: 528, marketProgramId: 560, targetOrders: 592 } as const;
const MKT = { size: 388, nonce: 45, baseMint: 53, quoteMint: 85, baseVault: 117, quoteVault: 165, eventQueue: 253, bids: 285, asks: 317 } as const;
const L = AMM_V4_LAYOUT;
export const AMM_STATUS_SWAP = 6n;   // Raydium AmmStatus.SwapOnly... value 6 = swaps enabled

export interface PoolState { status: bigint; baseDecimal: number; quoteDecimal: number; swapFeeNum: bigint; swapFeeDen: bigint; baseNeedTakePnl: bigint; quoteNeedTakePnl: bigint;
  baseVault: string; quoteVault: string; baseMint: string; quoteMint: string; lpMint: string; openOrders: string; openTime: bigint }
export function decodePoolState(data: Buffer): PoolState {
  if (data.length !== L.size) throw new Error(`pool account is ${data.length} bytes, expected ${L.size} (layout mismatch: refusing to decode)`);
  const u64 = (o: number) => data.readBigUInt64LE(o), pk = (o: number) => base58(data.subarray(o, o + 32));
  return { status: u64(L.status), baseDecimal: Number(u64(L.baseDecimal)), quoteDecimal: Number(u64(L.quoteDecimal)), swapFeeNum: u64(L.swapFeeNumerator), swapFeeDen: u64(L.swapFeeDenominator),
    baseNeedTakePnl: u64(L.baseNeedTakePnl), quoteNeedTakePnl: u64(L.quoteNeedTakePnl), baseVault: pk(L.baseVault), quoteVault: pk(L.quoteVault), baseMint: pk(L.baseMint), quoteMint: pk(L.quoteMint),
    lpMint: pk(L.lpMint), openOrders: pk(L.openOrders), openTime: u64(L.poolOpenTime) };
}
/** Constant-product with the pool's own fee fraction (fee taken from input). */
export function quoteOut(amountIn: bigint, rIn: bigint, rOut: bigint, feeNum: bigint, feeDen: bigint) { const net = amountIn - amountIn * feeNum / feeDen; return rOut * net / (rIn + net); }

export interface SolRpc { call<T = any>(method: string, params?: unknown[]): Promise<T> }
const pk = (d: Buffer, o: number) => base58(d.subarray(o, o + 32));

/** Reads the pool and its serum market, derives and CHECKS every account the swap instruction needs. Throws with the failing check. */
export async function loadPoolKeys(rpc: SolRpc, poolId: string, programId: string): Promise<{ keys: PoolKeys; state: PoolState }> {
  const acct = async (a: string) => { const r: any = await rpc.call('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]); return r?.value ? { owner: r.value.owner as string, exec: !!r.value.executable, data: Buffer.from(r.value.data[0], 'base64') } : undefined; };
  const pool = await acct(poolId); if (!pool) throw new Error(`pool ${poolId} does not exist`); if (pool.owner !== programId) throw new Error(`pool ${poolId} is owned by ${pool.owner}, not the AMM program ${programId}`);
  const st = decodePoolState(pool.data);
  const marketId = pk(pool.data, POOL_OFF.marketId), marketProgram = pk(pool.data, POOL_OFF.marketProgramId), targetOrders = pk(pool.data, POOL_OFF.targetOrders);
  const market = await acct(marketId);
  if (!market || market.owner !== marketProgram) throw new Error(`market ${marketId} is missing or not owned by market program ${marketProgram}`);
  if (market.data.length !== MKT.size) throw new Error(`market account is ${market.data.length} bytes, expected ${MKT.size}`);
  if (pk(market.data, MKT.baseMint) !== st.baseMint || pk(market.data, MKT.quoteMint) !== st.quoteMint) throw new Error('market mints do not match the pool mints (layout offsets wrong?)');
  const mProg = await acct(marketProgram); if (!mProg?.exec) throw new Error('market program is not executable');
  const marketAuthority = createProgramAddress([pubkeyBytes(marketId), u64le(market.data.readBigUInt64LE(MKT.nonce))], marketProgram);
  const mbv = pk(market.data, MKT.baseVault), mqv = pk(market.data, MKT.quoteVault);
  const vault = await acct(mbv); if (vault?.data.length !== 165) throw new Error('market base vault is not a token account');
  if (base58(vault.data.subarray(32, 64)) !== marketAuthority) throw new Error('market vault owner does not match the derived market authority');
  const authority = findProgramAddress([new TextEncoder().encode('amm authority')], programId).address;
  const vA = await acct(st.baseVault); if (!vA || base58(vA.data.subarray(32, 64)) !== authority) throw new Error('pool vault owner does not match the derived AMM authority');
  return { state: st, keys: { programId, id: poolId, authority, openOrders: st.openOrders, targetOrders, baseVault: st.baseVault, quoteVault: st.quoteVault, marketProgram, market: marketId,
    bids: pk(market.data, MKT.bids), asks: pk(market.data, MKT.asks), eventQueue: pk(market.data, MKT.eventQueue), marketBaseVault: mbv, marketQuoteVault: mqv, marketAuthority } };
}

/** Engine venue for one Raydium AMM v4 pool. Token ids are mint addresses (case-sensitive base58); 'NATIVE' is mapped to the wrapped-SOL mint. */
export class RaydiumVenue implements Venue {
  kind = 'cpamm' as const; status: 'active' | 'graduated' = 'active'; successor?: string; family = 'raydium-v4';
  constructor(public id: string, public keys: PoolKeys, public baseMint: string, public quoteMint: string, public baseReserve: bigint, public quoteReserve: bigint,
    public feeNum: bigint, public feeDen: bigint, public wsol: string, public tradable: boolean, public slot = 0) {}
  private res(t: string) { return t === 'NATIVE' ? this.wsol : t; }
  supports(a: string, b: string) { if (!this.tradable) return false; const x = this.res(a), y = this.res(b); return (x === this.baseMint && y === this.quoteMint) || (x === this.quoteMint && y === this.baseMint); }
  private io(a: string, b: string): [bigint, bigint] { if (!this.supports(a, b)) throw new Error('unsupported pair'); return this.res(a) === this.baseMint ? [this.baseReserve, this.quoteReserve] : [this.quoteReserve, this.baseReserve]; }
  quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'> {
    const [rIn, rOut] = this.io(a, b), out = quoteOut(amt, rIn, rOut, this.feeNum, this.feeDen), spot = amt * rOut / rIn;
    const impact = spot === 0n ? 0 : Math.max(0, Number((spot - out) * 10_000n / spot));
    const liquidity = this.baseMint === this.wsol ? this.baseReserve : this.quoteMint === this.wsol ? this.quoteReserve : rOut;
    return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: impact, venueFee: amt * this.feeNum / this.feeDen, liquidity };
  }
  spotPriceE18(a: string, b: string) { const [rIn, rOut] = this.io(a, b); return rOut * 10n ** 18n / rIn; }
  swap(a: string, b: string, amt: bigint) {
    const q = this.quote(a, b, amt);
    if (this.res(a) === this.baseMint) { this.baseReserve += amt; this.quoteReserve -= q.amountOut; } else { this.quoteReserve += amt; this.baseReserve -= q.amountOut; }
    return { amountOut: q.amountOut, venueFee: q.venueFee };
  }
  clone() { return new RaydiumVenue(this.id, this.keys, this.baseMint, this.quoteMint, this.baseReserve, this.quoteReserve, this.feeNum, this.feeDen, this.wsol, this.tradable, this.slot); }
}
