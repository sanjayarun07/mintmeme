/** EvmRpcChain: a ChainPort over JSON-RPC for an EVM node, trading on Uniswap-V2-style pools through a V2 router.
 *  Intents use LOWERCASE token addresses (or 'NATIVE'); walletId is the lowercase 0x address of the signing wallet.
 *  Scope and honesty:
 *   - Platform fees are collected on-chain ONLY through a configured FeeRouter contract (contracts/FeeRouter.sol, unaudited): the fee is a share of the input, taken atomically. Without `feeRouter` any tx with platformFeeBps > 0 is refused rather than booked as if collected.
 *   - A sell (token -> NATIVE/token) first runs an exact-amount approve(router, amountIn) as its own tracked child transaction when the allowance is too low (never unlimited).
 *     Tokens that need the allowance reset to 0 first (USDT-style) are handled when `resetApprovalFirst` is set: approve(0), then the exact amount. Without it their approve fails visibly.
 *   - Cancelling a PENDING tx is replace-by-fee (`replaceByFee`, no `evict`): a higher-fee no-op with the same nonce is sent; either the original or the no-op lands, and the engine reconciles both.
 *   - Signing is injected (RawSigner). In this repo it is a dev-only signer for throwaway local keys; custody/HSM is out of scope. */
import type { ChainPort, SimTx, Receipt, Venue } from '../../core/src/index.ts';
import { NATIVE, RpcError } from '../../core/src/index.ts';
import { keccak256, hexToBytes, bytesToHex } from './keccak.ts';
import { normAddr, decodeParams, encodeCall } from './abi.ts';
import { V2Venue, V2_FEE } from './v2.ts';
import type { EthCall, FeeSpec } from './v2.ts';
import { swapExactETHForTokens, swapExactTokensForETH, swapExactTokensForTokens, erc20 } from './calldata.ts';
import { planApproval } from './approval.ts';

/** Thrown by an RpcLike when the node answered with a JSON-RPC error object. Anything else thrown is treated as a transport failure (ack may be lost). */
export class JsonRpcError extends Error {}
export interface RpcLike { call<T = any>(method: string, params?: unknown[]): Promise<T> }
export interface Eip1559Request { wallet: string; to: string; data: string; value: bigint; nonce: number; chainId: number; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
/** Signs a prepared transaction. May be async so a custody service, HSM or MPC cluster can sit behind it (see HttpSigner). */
export interface RawSigner { sign(req: Eip1559Request): string | Promise<string> }
export interface EvmRpcConfig { id: string; chainId: number; router: string; weth: string; pools: { id: string; pair: string }[]; finalityDepth?: number; family?: string; /** pool fee as num/den of the input kept (default 997/1000 = 0.3%); PancakeSwap V2 differs, so set it from the router's own getAmountsOut */ fee?: FeeSpec; feeOnTransfer?: boolean; /** Tokens like USDT refuse to change a non-zero allowance: approve(0) first, then the exact amount (two tracked child transactions). */ resetApprovalFirst?: boolean;
  /** On-chain platform fee: trades with platformFeeBps > 0 go through this FeeRouter (see contracts/FeeRouter.sol). `bps` must equal the contract's immutable feeBps. Native <-> token trades only. */
  feeRouter?: { address: string; bps: number } }

const TRANSFER = keccakTopic('Transfer(address,address,uint256)');
const WITHDRAWAL = keccakTopic('Withdrawal(address,uint256)');
const FEE_EVENT = keccakTopic('Fee(address,address,uint256)');
function keccakTopic(sig: string) { return bytesToHex(keccak256(new TextEncoder().encode(sig))); }
const lc = (s: string) => s.toLowerCase();
const addrOfTopic = (t: string) => '0x' + t.slice(26).toLowerCase();
const big = (h: string) => BigInt(h);
const hex = (n: bigint) => '0x' + n.toString(16);
const REVERT_ERROR = '0x08c379a0';

export function decodeRevert(data: string | undefined): string | undefined {
  if (!data || data === '0x') return undefined;
  if (data.startsWith(REVERT_ERROR)) { try { return String(decodeParams(['string'], '0x' + data.slice(10))[0]); } catch { /* fall through */ } }
  return `revert ${data.slice(0, 18)}`;
}

export class EvmRpcChain implements ChainPort {
  id: string; family: string; time = 0; block = 0; finalityDepth: number; replaceByFee = true;
  state = { venues: new Map<string, Venue>() };
  constructor(private cfg: EvmRpcConfig, private rpc: RpcLike, private signer: RawSigner) {
    this.id = cfg.id; this.family = cfg.family ?? 'evm'; this.finalityDepth = cfg.finalityDepth ?? 3;
    normAddr(cfg.router); normAddr(cfg.weth);
  }
  venues() { return [...this.state.venues.values()]; }
  /** Register another pool (e.g. a freshly created launch pair). Loaded on the next refresh('venues'). Idempotent per id. */
  addPool(p: { id: string; pair: string }) { if (!this.cfg.pools.some(x => x.id === p.id)) this.cfg.pools.push(p); }
  /** Forget a pool (e.g. a launch pair whose creation was reorged out: loading it would fail every refresh). */
  removePool(id: string) { this.cfg.pools = this.cfg.pools.filter(x => x.id !== id); this.state.venues.delete(id); }
  private ethCall: EthCall = async (req, block) => this.rpc.call<string>('eth_call', [req, block === undefined || block === 'latest' ? 'latest' : hex(BigInt(block))]);

  /** a pair's tokens never change, so after the first load a pool reload is one eth_call (reserves), not three */
  private pairTokens = new Map<string, { token0: string; token1: string }>();
  async refresh(what: 'head' | 'venues') {
    const head: any = await this.rpc.call('eth_getBlockByNumber', ['latest', false]);
    this.block = Number(big(head.number)); this.time = Number(big(head.timestamp));
    if (what === 'venues') for (const p of this.cfg.pools) {
      const v = await V2Venue.load(this.ethCall, { id: p.id, pair: p.pair, family: this.cfg.family ?? 'uniswap-v2', fee: this.cfg.fee, wrappedNative: this.cfg.weth, block: this.block, tokens: this.pairTokens.get(p.id) });
      this.pairTokens.set(p.id, { token0: v.token0, token1: v.token1 }); v.block = this.block; this.state.venues.set(p.id, v);
    }
  }
  async balanceOf(wallet: string, token: string) {
    try {
      if (token === NATIVE) return big(await this.rpc.call<string>('eth_getBalance', [lc(wallet), 'latest']));
      const q = erc20.balanceOf(lc(token), lc(wallet)); return erc20.decodeUint(await this.rpc.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest']));
    } catch (e) { throw new RpcError((e as Error).message); }
  }
  async confirmedNonce(wallet: string) { return Number(big(await this.rpc.call<string>('eth_getTransactionCount', [lc(wallet), 'latest']))); }

  /** Calldata for a SimTx (swap or noop). */
  private request(tx: SimTx): { to: string; data: string; value: bigint } {
    if (tx.kind === 'noop') return { to: lc(tx.wallet), data: '0x', value: 0n };
    if (tx.kind === 'approve') { const a = erc20.approve(tx.tokenIn, tx.spender!, tx.amountIn); return { to: a.to, data: a.data, value: 0n }; }
    if (tx.platformFeeBps > 0) {
      const fr = this.cfg.feeRouter; if (!fr) throw new Error('a platform fee was requested but no on-chain fee router is configured: refusing to book a fee that is not collected');
      if (tx.platformFeeBps !== fr.bps) throw new Error(`requested fee ${tx.platformFeeBps} bps differs from the fee router's immutable ${fr.bps} bps`);
      if (tx.tokenIn !== NATIVE && tx.tokenOut !== NATIVE) throw new Error('the fee router only handles native <-> token trades');
    }
    const v = this.state.venues.get(tx.venue); if (!(v instanceof V2Venue)) throw new Error(`venue ${tx.venue} is not loaded (refresh venues first)`);
    const weth = lc(this.cfg.weth), inn = tx.tokenIn === NATIVE ? weth : lc(tx.tokenIn), out = tx.tokenOut === NATIVE ? weth : lc(tx.tokenOut);
    const a = { router: this.cfg.router, amountIn: tx.amountIn, amountOutMin: tx.minOut, path: [inn, out], to: lc(tx.wallet), deadline: BigInt(tx.deadline), feeOnTransfer: this.cfg.feeOnTransfer };
    if (tx.platformFeeBps > 0) {   // through the FeeRouter: fee from the input, taken atomically before the swap
      const fr = lc(this.cfg.feeRouter!.address);
      if (tx.tokenIn === NATIVE) return { to: fr, data: encodeCall('buy(uint256,address[],address,uint256)', [a.amountOutMin, a.path, a.to, a.deadline]), value: tx.amountIn };
      return { to: fr, data: encodeCall('sell(uint256,uint256,address[],address,uint256)', [a.amountIn, a.amountOutMin, a.path, a.to, a.deadline]), value: 0n };
    }
    const r = tx.tokenIn === NATIVE ? swapExactETHForTokens(a) : tx.tokenOut === NATIVE ? swapExactTokensForETH(a) : swapExactTokensForTokens(a);
    return { to: r.to, data: r.data, value: r.value };
  }
  private zero(block: number, status: 'success' | 'reverted', reason?: string): Receipt { return { hash: 'sim', status, reason, block, deltas: {}, network: 0n, platformFee: 0n, venueFee: 0n }; }

  /** A sell needs `router` allowance >= amountIn. Returns the EXACT amount to approve (unlimited is refused by planApproval), or undefined when already enough. */
  async needsApproval(tx: SimTx) {
    if (tx.kind === 'noop' || tx.kind === 'approve' || tx.tokenIn === NATIVE) return undefined;
    const spender = lc(tx.platformFeeBps > 0 && this.cfg.feeRouter ? this.cfg.feeRouter.address : this.cfg.router);
    const q = erc20.allowance(lc(tx.tokenIn), lc(tx.wallet), spender);
    let allowance: bigint; try { allowance = erc20.decodeUint(await this.rpc.call<string>('eth_call', [{ to: q.to, data: q.data }, 'latest'])); } catch (e) { throw new RpcError((e as Error).message); }
    const plan = planApproval(lc(tx.tokenIn), spender, tx.amountIn, allowance, { resetFirst: this.cfg.resetApprovalFirst });
    if (!plan.length) return undefined;
    return { token: lc(tx.tokenIn), spender, amount: plan.length === 2 ? 0n : tx.amountIn };   // the reset comes first; the exact amount is asked for again once the allowance is 0
  }

  async simulate(tx: SimTx) {
    let q: { to: string; data: string; value: bigint };
    try { q = this.request(tx); } catch (e) { return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', (e as Error).message) }; }   // cannot even build it: report as a failed simulation, not as an outage
    try { await this.rpc.call('eth_call', [{ from: lc(tx.wallet), to: q.to, data: q.data, value: hex(q.value) }, 'latest']); return { block: this.block, receipt: this.zero(this.block + 1, 'success') }; }
    catch (e) {
      if (!(e instanceof JsonRpcError)) throw new RpcError((e as Error).message);   // transport problem: engine stays quoted and retries
      return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', (e as Error).message) };
    }
  }

  async prepare(tx: SimTx) {
    const q = this.request(tx), from = lc(tx.wallet);
    const gp = big(await this.rpc.call<string>('eth_gasPrice'));
    let gasLimit = 21_000n;
    if (tx.kind !== 'noop') { try { gasLimit = big(await this.rpc.call<string>('eth_estimateGas', [{ from, to: q.to, data: q.data, value: hex(q.value) }])) * 13n / 10n; } catch (e) { throw new Error(`gas estimation failed (the swap would revert): ${(e as Error).message}`); } }
    const bump = tx.kind === 'noop' ? 3n : 1n;   // approvals use the normal fee   // a cancel must out-bid anything it replaces
    const raw = await this.signer.sign({ wallet: from, ...q, nonce: tx.nonce, chainId: this.cfg.chainId, gasLimit, maxFeePerGas: gp * 2n * bump, maxPriorityFeePerGas: (gp / 10n + 1n) * bump });
    return { raw, hash: bytesToHex(keccak256(hexToBytes(raw))) };
  }

  async submit(tx: SimTx) {
    if (!tx.raw) throw new Error('transaction was not prepared (no raw bytes)');
    try {
      const h = await this.rpc.call<string>('eth_sendRawTransaction', [tx.raw]);
      if (lc(h) !== lc(tx.hash)) throw new Error(`node returned hash ${h} but we computed ${tx.hash}: refusing to track a different transaction`);
      return h;
    } catch (e) {
      if (!(e instanceof JsonRpcError)) { if (e instanceof RpcError) throw e; if ((e as Error).message.startsWith('node returned hash')) throw e; throw new RpcError((e as Error).message); }
      if (/already (known|imported)|known transaction|AlreadyKnown/i.test(e.message)) return tx.hash;   // identical bytes already at the node: idempotent success
      throw new Error(e.message);
    }
  }

  async lookup(hash: string) {
    try {
      if (await this.rpc.call('eth_getTransactionReceipt', [hash])) return 'included' as const;
      return (await this.rpc.call('eth_getTransactionByHash', [hash])) ? 'pending' as const : 'none' as const;
    } catch (e) { throw new RpcError((e as Error).message); }
  }
  async confirmations(hash: string) {
    const rc: any = await this.rpc.call('eth_getTransactionReceipt', [hash]); if (!rc) return 0;
    return Number(big(await this.rpc.call<string>('eth_blockNumber'))) - Number(big(rc.blockNumber)) + 1;
  }

  /** Receipt -> balance deltas for the wallet: ERC-20 Transfer logs, WETH Withdrawal logs from the router (native out), tx value and gas (native). */
  async receipt(hash: string): Promise<Receipt | undefined> {
    const rc: any = await this.rpc.call('eth_getTransactionReceipt', [hash]); if (!rc) return undefined;
    const t: any = await this.rpc.call('eth_getTransactionByHash', [hash]); const wallet = lc(rc.from), weth = lc(this.cfg.weth);
    const gas = big(rc.gasUsed) * big(rc.effectiveGasPrice); const block = Number(big(rc.blockNumber));
    let platformFee = 0n; const deltas: Record<string, bigint> = {}; const add = (k: string, d: bigint) => { deltas[k] = (deltas[k] ?? 0n) + d; };
    add(NATIVE, -gas);
    if (rc.status !== '0x1') return { hash, status: 'reverted', reason: 'reverted on-chain', block, deltas, network: gas, platformFee: 0n, venueFee: 0n };
    add(NATIVE, -big(t.value));
    for (const l of rc.logs as any[]) {
      const addr = lc(l.address), t0 = l.topics?.[0];
      if (t0 === TRANSFER && l.topics.length === 3) { const from = addrOfTopic(l.topics[1]), to = addrOfTopic(l.topics[2]), amt = big(l.data); if (to === wallet) add(addr, amt); if (from === wallet) add(addr, -amt); }
      else if (t0 === WITHDRAWAL && addr === weth && (addrOfTopic(l.topics[1]) === lc(t.to) || addrOfTopic(l.topics[1]) === lc(this.cfg.router))) add(NATIVE, big(l.data));
      else if (t0 === FEE_EVENT && this.cfg.feeRouter && addr === lc(this.cfg.feeRouter.address)) platformFee += big(l.data);   // router unwrapped WETH and forwarded the ETH
    }
    // the WETH wrapper leg of a native-in swap is router<->pair, never the wallet, so it does not appear above
    const spent = deltas[NATIVE] !== undefined && big(t.value) > 0n ? big(t.value) : (() => { const k = Object.keys(deltas).find(x => x !== NATIVE && deltas[x] < 0n); return k ? -deltas[k] : 0n; })();
    const swapped = platformFee > 0n ? spent - platformFee : spent;
    return { hash, status: 'success', block, deltas, network: gas, platformFee, venueFee: swapped - swapped * V2_FEE.num / V2_FEE.den };
  }
}
