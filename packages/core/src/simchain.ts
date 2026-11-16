import { NATIVE } from './types.ts';
import type { Venue } from './types.ts';
import { LinearCurve, CpAmm } from './venues.ts';
import type { ChainPort } from './port.ts';

/** LOCAL SIMULATED CHAIN (fixture). Not a real network. Models nonces, mempool, receipts, reverts, tax tokens, ack loss. */
export interface SimTx {
  hash: string; wallet: string; nonce: number; venue: string; tokenIn: string; tokenOut: string;
  amountIn: bigint; minOut: bigint; deadline: number; platformFeeBps: number;
  raw?: string;                   // networked chains: signed raw transaction (persisted for write-ahead + identical resubmit)
  kind?: 'swap' | 'noop' | 'approve';   // approve: networked chains only; spender below
  spender?: string;   // noop: consumes the nonce, pays gas, moves nothing (cancel/replace)
}
export interface Receipt {
  hash: string; status: 'success' | 'reverted'; reason?: string; block: number;
  deltas: Record<string, bigint>; network: bigint; platformFee: bigint; venueFee: bigint;
}
export interface TokenBehavior { buyTaxBps?: number; sellTaxBps?: number; honeypot?: boolean; maxTxAmount?: bigint; tradingOpenBlock?: number }
interface State { bal: Map<string, bigint>; venues: Map<string, Venue> }
export class RpcError extends Error {}

export class SimChain implements ChainPort {
  block = 100; time = 1_700_000_000; finalityDepth = 3; gasFee = 1_000n;
  state: State = { bal: new Map(), venues: new Map() };
  tokens = new Map<string, TokenBehavior>();
  mempool = new Map<string, SimTx>();
  receipts = new Map<string, Receipt>();
  nextNonceMap = new Map<string, number>();
  failNextSubmitAck = 0;        // accept tx, then throw (lost ack)
  rpcDown = false;
  private journal: { tx: SimTx; pre: State; preNonces: Map<string, number> }[] = [];   // for reorgs
  constructor(public id = 'sim-evm', public family = 'evm') {}

  credit(w: string, t: string, a: bigint) { this.state.bal.set(`${w}:${t}`, this.balance(w, t) + a); }
  balance(w: string, t: string) { return this.state.bal.get(`${w}:${t}`) ?? 0n; }
  addVenue(v: Venue) { this.state.venues.set(v.id, v); }
  venues() { return [...this.state.venues.values()]; }
  balanceOf(w: string, t: string) { return this.balance(w, t); }
  confirmedNonce(w: string) { return this.nextNonceMap.get(w) ?? 0; }

  /** Graduate a curve into a CP pool; token identity (address) is unchanged, venue successor recorded. */
  migrate(curveId: string): CpAmm {
    const c = this.state.venues.get(curveId) as LinearCurve;
    const pool = new CpAmm(`${curveId}-pool`, c.family, c.token, c.quoteToken, 800_000n, c.raised);
    c.status = 'graduated'; c.successor = pool.id;
    this.addVenue(pool); return pool;
  }

  private exec(st: State, tx: SimTx, blockNo: number): Receipt {
    const before = new Map(st.bal);
    const get = (t: string) => st.bal.get(`${tx.wallet}:${t}`) ?? 0n;
    const set = (t: string, v: bigint) => st.bal.set(`${tx.wallet}:${t}`, v);
    const mk = (status: 'success' | 'reverted', reason: string | undefined, platformFee = 0n, venueFee = 0n): Receipt => {
      const deltas: Record<string, bigint> = {};
      for (const [k, v] of st.bal) if (k.startsWith(tx.wallet + ':')) { const d = v - (before.get(k) ?? 0n); if (d !== 0n) deltas[k.slice(tx.wallet.length + 1)] = d; }
      return { hash: tx.hash, status, reason, block: blockNo, deltas, network: this.gasFee, platformFee, venueFee };
    };
    if (get(NATIVE) < this.gasFee) return mk('reverted', 'insufficient gas');
    set(NATIVE, get(NATIVE) - this.gasFee);                       // gas is paid even on revert
    if (tx.kind === 'noop') return mk('success', undefined);
    const revert = (r: string) => { const rc = mk('reverted', r); return rc; };
    if (this.time > tx.deadline) return revert('deadline passed');
    if (get(tx.tokenIn) < tx.amountIn) return revert('insufficient balance');
    const venue = st.venues.get(tx.venue)?.clone();
    if (!venue || venue.status !== 'active') return revert('venue unavailable');
    const tIn = this.tokens.get(tx.tokenIn), tOut = this.tokens.get(tx.tokenOut);
    if (tIn?.honeypot) return revert('token transfer blocked');
    if (tOut?.tradingOpenBlock && blockNo < tOut.tradingOpenBlock) return revert('trading not enabled');
    if (tIn?.maxTxAmount && tx.amountIn > tIn.maxTxAmount) return revert('max tx amount');
    const platformFee = tx.amountIn * BigInt(tx.platformFeeBps) / 10_000n;
    let swapIn = tx.amountIn - platformFee;
    if (tIn?.sellTaxBps) swapIn = swapIn * BigInt(10_000 - tIn.sellTaxBps) / 10_000n;   // tax withheld on transfer to pool
    let res; try { res = venue.swap(tx.tokenIn, tx.tokenOut, swapIn); } catch (e) { return revert('venue error'); }
    let out = res.amountOut;
    if (tOut?.buyTaxBps) out = out * BigInt(10_000 - tOut.buyTaxBps) / 10_000n;
    if (out < tx.minOut) return revert('insufficient output (minOut)');
    set(tx.tokenIn, get(tx.tokenIn) - tx.amountIn);
    set(tx.tokenOut, get(tx.tokenOut) + out);
    st.bal.set(`PLATFORM:${tx.tokenIn}`, (st.bal.get(`PLATFORM:${tx.tokenIn}`) ?? 0n) + platformFee);
    st.venues.set(venue.id, venue);
    return mk('success', undefined, platformFee, res.venueFee);
  }
  private cloneState(): State { return { bal: new Map(this.state.bal), venues: new Map([...this.state.venues].map(([k, v]) => [k, v.clone()])) }; }

  /** Dry run against current state; reports block it ran at (limitation: state may change before inclusion). */
  simulate(tx: SimTx) { if (this.rpcDown) throw new RpcError('rpc down'); return { block: this.block, receipt: this.exec(this.cloneState(), tx, this.block + 1) }; }

  submit(tx: SimTx) {
    if (this.rpcDown) throw new RpcError('rpc down');
    if (!this.receipts.has(tx.hash) && !this.mempool.has(tx.hash)) {
      for (const m of this.mempool.values()) if (m.wallet === tx.wallet && m.nonce === tx.nonce) throw new Error('nonce in use by another tx');
      if (tx.nonce < this.confirmedNonce(tx.wallet)) throw new Error('nonce too low');
      this.mempool.set(tx.hash, tx);
    }
    if (this.failNextSubmitAck > 0) { this.failNextSubmitAck--; throw new RpcError('connection reset after send'); }
    return tx.hash;
  }
  /** Atomically remove a still-pending tx from the mempool (replace-by-nonce step). False if it is not pending (e.g. already included). */
  evict(hash: string) { return this.mempool.delete(hash); }
  lookup(hash: string): 'pending' | 'included' | 'none' { if (this.rpcDown) throw new RpcError('rpc down'); return this.receipts.has(hash) ? 'included' : this.mempool.has(hash) ? 'pending' : 'none'; }
  receipt(hash: string) { return this.receipts.get(hash); }
  confirmations(hash: string) { const r = this.receipts.get(hash); return r ? this.block - r.block + 1 : 0; }

  mine(n = 1) {
    for (let i = 0; i < n; i++) {
      this.block++; this.time += 12;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const tx of [...this.mempool.values()].sort((a, b) => a.nonce - b.nonce)) {
          if (tx.nonce !== this.confirmedNonce(tx.wallet)) continue;
          this.mempool.delete(tx.hash);
          this.journal.push({ tx, pre: this.cloneState(), preNonces: new Map(this.nextNonceMap) });
          this.receipts.set(tx.hash, this.exec(this.state, tx, this.block));
          this.nextNonceMap.set(tx.wallet, tx.nonce + 1);
          for (const v of this.state.venues.values()) if (v instanceof LinearCurve && v.shouldGraduate) this.migrate(v.id);
          progressed = true;
        }
      }
    }
  }
  /** Fixture: simulate a reorg dropping an included tx back to the mempool. */
  reorgDrop(hash: string) { const r = this.receipts.get(hash); if (!r) return; this.receipts.delete(hash); }
  /**
   * Fixture: real reorg. Rolls state/nonces back to just before `hash` was included and puts it AND every tx included after it
   * back into the mempool (their receipts vanish). Re-mining re-executes them against the rolled-back state, so receipts may differ.
   */
  reorgReinclude(hash: string) {
    const idx = this.journal.findIndex(j => j.tx.hash === hash); if (idx < 0) return false;
    const undone = this.journal.splice(idx);
    this.state = undone[0].pre; this.nextNonceMap = undone[0].preNonces;
    for (const j of undone) { this.receipts.delete(j.tx.hash); this.mempool.set(j.tx.hash, j.tx); }
    return true;
  }
}
