import { NATIVE, RpcError } from '../../core/src/index.js';
import { keccak256, hexToBytes, bytesToHex } from './keccak.js';
import { normAddr, decodeParams, encodeCall } from './abi.js';
import { V2Venue, V2_FEE } from './v2.js';
import { swapExactETHForTokens, swapExactTokensForETH, swapExactTokensForTokens, erc20 } from './calldata.js';
import { planApproval } from './approval.js';
import { AggVenue, AggRefused, simulateCalls, decodeKyberSwap, KYBER } from './aggregator.js';
import { gateKyber, KyberUnavailable } from './kyber.js';
import { RELAY_BASE, gateRelay, decodeRelaySwap, currentSettler, RelayUnavailable } from './relay.js';
/** Thrown by an RpcLike when the node answered with a JSON-RPC error object. Anything else thrown is treated as a transport failure (ack may be lost). */
export class JsonRpcError extends Error {
}
const TRANSFER = keccakTopic('Transfer(address,address,uint256)');
const WITHDRAWAL = keccakTopic('Withdrawal(address,uint256)');
const FEE_EVENT = keccakTopic('Fee(address,address,uint256)');
function keccakTopic(sig) { return bytesToHex(keccak256(new TextEncoder().encode(sig))); }
const lc = (s) => s.toLowerCase();
const addrOfTopic = (t) => '0x' + t.slice(26).toLowerCase();
const big = (h) => BigInt(h);
const hex = (n) => '0x' + n.toString(16);
const REVERT_ERROR = '0x08c379a0';
export function decodeRevert(data) {
    if (!data || data === '0x')
        return undefined;
    if (data.startsWith(REVERT_ERROR)) {
        try {
            return String(decodeParams(['string'], '0x' + data.slice(10))[0]);
        }
        catch { /* fall through */ }
    }
    return `revert ${data.slice(0, 18)}`;
}
export class EvmRpcChain {
    cfg;
    rpc;
    signer;
    id;
    family;
    time = 0;
    block = 0;
    finalityDepth;
    replaceByFee = true;
    state = { venues: new Map() };
    constructor(cfg, rpc, signer) {
        this.cfg = cfg;
        this.rpc = rpc;
        this.signer = signer;
        this.id = cfg.id;
        this.family = cfg.family ?? 'evm';
        this.finalityDepth = cfg.finalityDepth ?? 3;
        normAddr(cfg.router);
        normAddr(cfg.weth);
    }
    venues() { return [...this.state.venues.values()]; }
    /** Register another pool (e.g. a freshly created launch pair). Loaded on the next refresh('venues'). Idempotent per id. */
    addPool(p) { if (!this.cfg.pools.some(x => x.id === p.id))
        this.cfg.pools.push(p); }
    /** Forget a pool (e.g. a launch pair whose creation was reorged out: loading it would fail every refresh). */
    removePool(id) { this.cfg.pools = this.cfg.pools.filter(x => x.id !== id); this.state.venues.delete(id); }
    ethCall = async (req, block) => this.rpc.call('eth_call', [req, block === undefined || block === 'latest' ? 'latest' : hex(BigInt(block))]);
    /** a pair's tokens never change, so after the first load a pool reload is one eth_call (reserves), not three */
    pairTokens = new Map();
    async refresh(what) {
        const head = await this.rpc.call('eth_getBlockByNumber', ['latest', false]);
        this.block = Number(big(head.number));
        this.time = Number(big(head.timestamp));
        if (what === 'venues')
            for (const p of this.cfg.pools) {
                const v = await V2Venue.load(this.ethCall, { id: p.id, pair: p.pair, family: this.cfg.family ?? 'uniswap-v2', fee: this.cfg.fee, wrappedNative: this.cfg.weth, block: this.block, tokens: this.pairTokens.get(p.id) });
                this.pairTokens.set(p.id, { token0: v.token0, token1: v.token1 });
                v.block = this.block;
                this.state.venues.set(p.id, v);
            }
        if (what === 'venues')
            await this.refreshAgg();
    }
    /* ---------------- Aggregator routes: Relay, or KyberSwap instead ---------------- */
    aggError;
    aggAt = 0;
    settler;
    relayK() { return this.cfg.relay?.contracts ?? RELAY_BASE; }
    /** The aggregator this chain uses for tokens without a usable V2 pool: KyberSwap when `kyber` is configured, otherwise Relay. One at a time. */
    get aggKind() { return this.cfg.kyber ? 'kyberswap' : this.cfg.relay ? 'relay' : undefined; }
    aggName(family = this.aggKind) { return family === 'kyberswap' ? 'KyberSwap' : 'Relay'; }
    aggCfg() { return this.cfg.kyber ?? this.cfg.relay; }
    /** The contract that must be approved for a token-in aggregator swap: KyberSwap's router, or Relay's approval proxy. */
    aggRouter(family = this.aggKind) { return family === 'kyberswap' ? KYBER.router : lc(this.relayK().approvalProxy); }
    aggId(a, b) { return `${this.aggKind === 'kyberswap' ? 'kyber' : 'relay'}:${a === NATIVE ? 'eth' : a.slice(0, 10)}>${b === NATIVE ? 'eth' : b.slice(0, 10)}`; }
    /** A read-only reference quote (output for an exact input) from the configured aggregator. */
    async aggRefQuote(tokenIn, tokenOut, amount) {
        if (this.cfg.kyber)
            return (await this.cfg.kyber.client.quote(tokenIn, tokenOut, amount)).amountOut;
        const a = this.cfg.relay;
        return (await a.client.quote(a.refWallet ?? '0x000000000000000000000000000000000000dead', tokenIn, tokenOut, amount)).amountOut;
    }
    /** Reference quotes for the configured pairs, at most every `refreshMs`. A pair that cannot be quoted has no venue until it can (orders on it wait). */
    async refreshAgg(force = false) {
        const a = this.aggCfg();
        if (!a?.pairs?.length)
            return;
        if (!force && Date.now() - this.aggAt < (a.refreshMs ?? 15_000))
            return;
        this.aggAt = Date.now();
        this.aggError = undefined;
        for (const p of a.pairs) {
            const id = this.aggId(p.tokenIn, p.tokenOut);
            try {
                const out = await this.aggRefQuote(p.tokenIn, p.tokenOut, p.refAmount);
                this.state.venues.set(id, new AggVenue(id, p.tokenIn, p.tokenOut, p.refAmount, out, this.block, this.aggKind));
            }
            catch (e) {
                this.state.venues.delete(id);
                this.aggError = `${p.tokenIn} -> ${p.tokenOut}: ${e.message}`;
            }
        }
    }
    /** Make a token tradable through the aggregator: ETH -> token for `refWei`, and back for what that returned. Read-only (quotes). Returns false when there is no route. */
    async addAggToken(token, refWei = 10n ** 16n) {
        const a = this.aggCfg();
        if (!a)
            throw new Error('no aggregator (Relay or KyberSwap) is configured on this chain');
        const t = lc(normAddr(token));
        let out;
        try {
            out = await this.aggRefQuote(NATIVE, t, refWei);
        }
        catch (e) {
            this.aggError = e.message;
            return false;
        }
        a.pairs ??= [];
        const add = (tokenIn, tokenOut, refAmount) => { if (!a.pairs.some(p => p.tokenIn === tokenIn && p.tokenOut === tokenOut))
            a.pairs.push({ tokenIn, tokenOut, refAmount }); };
        add(NATIVE, t, refWei);
        add(t, NATIVE, out);
        await this.refreshAgg(true);
        return this.state.venues.has(this.aggId(NATIVE, t));
    }
    /** Slippage so that the aggregator's own on-chain minimum is at least the engine's: tighter than the engine allows is fine, looser never is. `reserve` keeps that share
     *  of the room back, because each request comes back with a fresh quote that can be lower than the one the slippage was computed from. */
    slipFor(tx, out, reserve, name) { const room = Number((out - tx.minOut) * 10000n / out), s = room - Math.max(2, Math.ceil(room * reserve)); if (s < 1)
        throw new AggRefused(`the allowed slippage is under a few bps: ${name} cannot honour it`); return Math.min(s, 5_000); }
    /** The Relay swap for `tx`, gated (relay.ts gateRelay) and its 0x Settler, if any, checked against 0x's registry. */
    async relaySwap(tx) {
        const a = this.cfg.relay;
        if (!a)
            throw new AggRefused('Relay is not configured');
        // Relay unavailable (rate limit, outage) is transient: RpcError keeps the trade waiting for a retry; any other quote error (no route) is a refusal
        const quote = (slip) => a.client.quote(wallet, tx.tokenIn, tx.tokenOut, tx.amountIn, slip).catch(e => { if (e instanceof RelayUnavailable)
            throw new RpcError(e.message); throw new AggRefused(e.message); });
        const K = this.relayK(), wallet = lc(tx.wallet), first = await quote();
        if (first.amountOut < tx.minOut)
            throw new AggRefused(`Relay now quotes ${first.amountOut} out, below your minimum ${tx.minOut}: the price moved`);
        // Mainnet 2026-11-18: a fresh quote 0.16% lower a moment later left Relay's minimum 0.008% under ours with a 5% reserve. The first request keeps 5% of the room in
        // reserve: asking Relay for tighter slippage made it pick other inner routes, some not reviewed here (fork runs 2026-11-18). If Relay's minimum still lands under ours,
        // ask once more from the newest quote keeping half the room. A tighter on-chain minimum can only make the swap revert (gas), never fill below ours; refused after that.
        const ctx = { wallet, tokenIn: tx.tokenIn, tokenOut: tx.tokenOut, amountIn: tx.amountIn, minOut: tx.minOut, contracts: K };
        let q = await quote(this.slipFor(tx, first.amountOut, 0.05, 'Relay')), g;
        try {
            g = gateRelay(q.steps, ctx);
        }
        catch (e) {
            if (!(e instanceof AggRefused) || !/on-chain minimum .* is below ours/.test(e.message))
                throw e;
            if (q.amountOut < tx.minOut)
                throw new AggRefused(`Relay now quotes ${q.amountOut} out, below your minimum ${tx.minOut}: the price moved`);
            q = await quote(this.slipFor(tx, q.amountOut, 0.5, 'Relay'));
            g = gateRelay(q.steps, ctx);
        }
        if (g.settler) {
            if (!this.settler || Date.now() - this.settler.at > 300_000)
                this.settler = { at: Date.now(), addr: await currentSettler(this.rpc) };
            if (g.settler !== this.settler.addr)
                throw new AggRefused(`the route's 0x Settler ${g.settler} is not the current one in 0x's registry (${this.settler.addr})`);
        }
        return { to: g.swap.to, data: g.swap.data, value: g.swap.value };
    }
    /** The KyberSwap swap for `tx`: quoted, built for our wallet with slippage inside the engine's minimum, and gated (kyber.ts gateKyber). Same reserve and one retry as Relay. */
    async kyberSwap(tx) {
        const k = this.cfg.kyber;
        if (!k)
            throw new AggRefused('KyberSwap is not configured');
        const call = (p) => p.catch(e => { if (e instanceof KyberUnavailable)
            throw new RpcError(e.message); if (e instanceof AggRefused)
            throw e; throw new AggRefused(e.message); });
        const wallet = lc(tx.wallet), ctx = { wallet, tokenIn: tx.tokenIn, tokenOut: tx.tokenOut, amountIn: tx.amountIn, minOut: tx.minOut };
        for (let attempt = 0;; attempt++) {
            const q = await call(k.client.quote(tx.tokenIn, tx.tokenOut, tx.amountIn));
            if (q.amountOut < tx.minOut)
                throw new AggRefused(`KyberSwap now quotes ${q.amountOut} out, below your minimum ${tx.minOut}: the price moved`);
            const b = await call(k.client.build(q, wallet, this.slipFor(tx, q.amountOut, attempt === 0 ? 0.05 : 0.5, 'KyberSwap')));
            try {
                return gateKyber(b, ctx).swap;
            }
            catch (e) {
                if (attempt > 0 || !(e instanceof AggRefused) || !/on-chain minimum .* is below ours/.test(e.message))
                    throw e;
            }
        }
    }
    /** Build the aggregator swap for `tx` (Relay or KyberSwap, by the venue), then simulate it on the exact bytes (with an exact approve first if the allowance is short). */
    async aggBuild(tx, v) {
        const name = this.aggName(v.family);
        if (tx.platformFeeBps > 0)
            throw new AggRefused(`a platform fee is not supported on ${name} routes: refusing to book a fee that is not collected`);
        if (!v.supports(tx.tokenIn, tx.tokenOut))
            throw new AggRefused(`this ${name} venue does not cover that pair`);
        if (v.family !== this.aggKind)
            throw new AggRefused(`this venue is a ${name} route, but this chain now uses ${this.aggName()}`);
        const wallet = lc(tx.wallet), spender = this.aggRouter(v.family);
        const swap = v.family === 'kyberswap' ? await this.kyberSwap(tx) : await this.relaySwap(tx), calls = [swap];
        if (tx.tokenIn !== NATIVE) {
            const qa = erc20.allowance(lc(tx.tokenIn), wallet, spender);
            const al = erc20.decodeUint(await this.rpc.call('eth_call', [{ to: qa.to, data: qa.data }, 'latest']));
            if (al < tx.amountIn) {
                const ap = erc20.approve(lc(tx.tokenIn), spender, tx.amountIn);
                calls.unshift({ to: ap.to, data: ap.data, value: 0n });
            }
        }
        // a node without eth_simulateV1 can never check the swap: refuse. Any other node error (rate limit, a fork failing to fetch upstream state) is transient: retried.
        let sim;
        try {
            sim = await simulateCalls(this.rpc, wallet, calls);
        }
        catch (e) {
            const m = e.message;
            if (e instanceof JsonRpcError && /method .*(not found|not supported|does not exist|not available)|unsupported method|-32601/i.test(m))
                throw new AggRefused(`this node cannot simulate the swap (no eth_simulateV1): ${m}`);
            throw new RpcError(`simulation unavailable right now: ${m}`);
        }
        const bad = sim.calls.find(c => !c.ok);
        if (bad)
            throw new AggRefused(`simulation failed: ${bad.error ?? 'reverted'}`);
        const got = sim.deltas[tx.tokenOut] ?? 0n, spent = -(sim.deltas[tx.tokenIn] ?? 0n);
        if (got < tx.minOut)
            throw new AggRefused(`simulated output ${got} is below the minimum ${tx.minOut}`);
        if (spent > tx.amountIn)
            throw new AggRefused(`simulated spend ${spent} exceeds the intent ${tx.amountIn}`);
        const other = Object.entries(sim.deltas).find(([k, d]) => k !== tx.tokenIn && k !== tx.tokenOut && d < 0n);
        if (other)
            throw new AggRefused(`the swap would also take ${-other[1]} of ${other[0]} from the wallet`);
        return { req: swap, out: got, gasUsed: sim.calls[sim.calls.length - 1].gasUsed };
    }
    aggVenue(tx) { const v = tx.kind === 'noop' || tx.kind === 'approve' ? undefined : this.state.venues.get(tx.venue); return v instanceof AggVenue ? v : undefined; }
    async balanceOf(wallet, token) {
        try {
            if (token === NATIVE)
                return big(await this.rpc.call('eth_getBalance', [lc(wallet), 'latest']));
            const q = erc20.balanceOf(lc(token), lc(wallet));
            return erc20.decodeUint(await this.rpc.call('eth_call', [{ to: q.to, data: q.data }, 'latest']));
        }
        catch (e) {
            throw new RpcError(e.message);
        }
    }
    async confirmedNonce(wallet) { return Number(big(await this.rpc.call('eth_getTransactionCount', [lc(wallet), 'latest']))); }
    /** Calldata for a SimTx (swap or noop). */
    request(tx) {
        if (tx.kind === 'noop')
            return { to: lc(tx.wallet), data: '0x', value: 0n };
        if (tx.kind === 'approve') {
            const a = erc20.approve(tx.tokenIn, tx.spender, tx.amountIn);
            return { to: a.to, data: a.data, value: 0n };
        }
        if (tx.platformFeeBps > 0) {
            const fr = this.cfg.feeRouter;
            if (!fr)
                throw new Error('a platform fee was requested but no on-chain fee router is configured: refusing to book a fee that is not collected');
            if (tx.platformFeeBps !== fr.bps)
                throw new Error(`requested fee ${tx.platformFeeBps} bps differs from the fee router's immutable ${fr.bps} bps`);
            if (tx.tokenIn !== NATIVE && tx.tokenOut !== NATIVE)
                throw new Error('the fee router only handles native <-> token trades');
        }
        const v = this.state.venues.get(tx.venue);
        if (!(v instanceof V2Venue))
            throw new Error(`venue ${tx.venue} is not loaded (refresh venues first)`);
        const weth = lc(this.cfg.weth), inn = tx.tokenIn === NATIVE ? weth : lc(tx.tokenIn), out = tx.tokenOut === NATIVE ? weth : lc(tx.tokenOut);
        const a = { router: this.cfg.router, amountIn: tx.amountIn, amountOutMin: tx.minOut, path: [inn, out], to: lc(tx.wallet), deadline: BigInt(tx.deadline), feeOnTransfer: this.cfg.feeOnTransfer };
        if (tx.platformFeeBps > 0) { // through the FeeRouter: fee from the input, taken atomically before the swap
            const fr = lc(this.cfg.feeRouter.address);
            if (tx.tokenIn === NATIVE)
                return { to: fr, data: encodeCall('buy(uint256,address[],address,uint256)', [a.amountOutMin, a.path, a.to, a.deadline]), value: tx.amountIn };
            return { to: fr, data: encodeCall('sell(uint256,uint256,address[],address,uint256)', [a.amountIn, a.amountOutMin, a.path, a.to, a.deadline]), value: 0n };
        }
        const r = tx.tokenIn === NATIVE ? swapExactETHForTokens(a) : tx.tokenOut === NATIVE ? swapExactTokensForETH(a) : swapExactTokensForTokens(a);
        return { to: r.to, data: r.data, value: r.value };
    }
    zero(block, status, reason) { return { hash: 'sim', status, reason, block, deltas: {}, network: 0n, platformFee: 0n, venueFee: 0n }; }
    /** A sell needs `router` allowance >= amountIn. Returns the EXACT amount to approve (unlimited is refused by planApproval), or undefined when already enough. */
    async needsApproval(tx) {
        if (tx.kind === 'noop' || tx.kind === 'approve' || tx.tokenIn === NATIVE)
            return undefined;
        const av = this.aggVenue(tx), spender = av ? this.aggRouter(av.family) : lc(tx.platformFeeBps > 0 && this.cfg.feeRouter ? this.cfg.feeRouter.address : this.cfg.router);
        const q = erc20.allowance(lc(tx.tokenIn), lc(tx.wallet), spender);
        let allowance;
        try {
            allowance = erc20.decodeUint(await this.rpc.call('eth_call', [{ to: q.to, data: q.data }, 'latest']));
        }
        catch (e) {
            throw new RpcError(e.message);
        }
        const plan = planApproval(lc(tx.tokenIn), spender, tx.amountIn, allowance, { resetFirst: this.cfg.resetApprovalFirst });
        if (!plan.length)
            return undefined;
        return { token: lc(tx.tokenIn), spender, amount: plan.length === 2 ? 0n : tx.amountIn }; // the reset comes first; the exact amount is asked for again once the allowance is 0
    }
    async simulate(tx) {
        const av = this.aggVenue(tx);
        if (av) {
            try {
                const r = await this.aggBuild(tx, av);
                return { block: this.block, receipt: { ...this.zero(this.block + 1, 'success'), deltas: tx.tokenOut === NATIVE ? {} : { [tx.tokenOut]: r.out } } };
            }
            catch (e) {
                if (e instanceof AggRefused)
                    return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', e.message) };
                if (e instanceof RpcError)
                    throw e;
                return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', e.message) };
            }
        }
        let q;
        try {
            q = this.request(tx);
        }
        catch (e) {
            return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', e.message) };
        } // cannot even build it: report as a failed simulation, not as an outage
        try {
            await this.rpc.call('eth_call', [{ from: lc(tx.wallet), to: q.to, data: q.data, value: hex(q.value) }, 'latest']);
            return { block: this.block, receipt: this.zero(this.block + 1, 'success') };
        }
        catch (e) {
            if (!(e instanceof JsonRpcError))
                throw new RpcError(e.message); // transport problem: engine stays quoted and retries
            return { block: this.block, receipt: this.zero(this.block + 1, 'reverted', e.message) };
        }
    }
    async prepare(tx) {
        const av = this.aggVenue(tx), agg = av ? await this.aggBuild(tx, av) : undefined; // gated and simulated again on the exact bytes to be signed
        const q = agg ? agg.req : this.request(tx), from = lc(tx.wallet);
        const gp = big(await this.rpc.call('eth_gasPrice'));
        let gasLimit = 21000n;
        if (agg)
            gasLimit = agg.gasUsed * 13n / 10n + 30000n; // from the simulation (it may include an approve not mined yet, which estimateGas could not)
        else if (tx.kind !== 'noop') {
            try {
                gasLimit = big(await this.rpc.call('eth_estimateGas', [{ from, to: q.to, data: q.data, value: hex(q.value) }])) * 13n / 10n;
            }
            catch (e) {
                throw new Error(`gas estimation failed (the swap would revert): ${e.message}`);
            }
        }
        const bump = tx.kind === 'noop' ? 3n : 1n; // approvals use the normal fee   // a cancel must out-bid anything it replaces
        const raw = await this.signer.sign({ wallet: from, ...q, nonce: tx.nonce, chainId: this.cfg.chainId, gasLimit, maxFeePerGas: gp * 2n * bump, maxPriorityFeePerGas: (gp / 10n + 1n) * bump });
        return { raw, hash: bytesToHex(keccak256(hexToBytes(raw))) };
    }
    async submit(tx) {
        if (!tx.raw)
            throw new Error('transaction was not prepared (no raw bytes)');
        try {
            const h = await this.rpc.call('eth_sendRawTransaction', [tx.raw]);
            if (lc(h) !== lc(tx.hash))
                throw new Error(`node returned hash ${h} but we computed ${tx.hash}: refusing to track a different transaction`);
            return h;
        }
        catch (e) {
            if (!(e instanceof JsonRpcError)) {
                if (e instanceof RpcError)
                    throw e;
                if (e.message.startsWith('node returned hash'))
                    throw e;
                throw new RpcError(e.message);
            }
            if (/already (known|imported)|known transaction|AlreadyKnown/i.test(e.message))
                return tx.hash; // identical bytes already at the node: idempotent success
            throw new Error(e.message);
        }
    }
    async lookup(hash) {
        try {
            if (await this.rpc.call('eth_getTransactionReceipt', [hash]))
                return 'included';
            return (await this.rpc.call('eth_getTransactionByHash', [hash])) ? 'pending' : 'none';
        }
        catch (e) {
            throw new RpcError(e.message);
        }
    }
    async confirmations(hash) {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [hash]);
        if (!rc)
            return 0;
        return Number(big(await this.rpc.call('eth_blockNumber'))) - Number(big(rc.blockNumber)) + 1;
    }
    /** Receipt -> balance deltas for the wallet: ERC-20 Transfer logs, WETH Withdrawal logs from the router (native out), tx value and gas (native). */
    /** What the wallet's OTHER transactions in block `n` cost it in ETH, when each can only have cost ETH (gas and L1 fee; a self-send gets its value back): an ERC-20 approve, or a self-send
     *  (the engine's cancel). Any other transaction might have paid ETH in internally, so the Relay swap's ETH change cannot be separated: RpcError (looked at again later). */
    async otherTxsCost(wallet, n, ours, expected) {
        const unclear = (why) => new RpcError(`the wallet sent ${expected + 1n} transactions in block ${n}: ${why}, so the swap's ETH change cannot be read on its own`);
        let blk;
        try {
            blk = await this.rpc.call('eth_getBlockByNumber', [hex(n), true]);
        }
        catch (e) {
            throw unclear(`the block could not be read (${e.message})`);
        }
        const others = (blk?.transactions ?? []).filter(x => typeof x === 'object' && lc(x.from ?? '') === wallet && lc(x.hash ?? '') !== ours);
        if (BigInt(others.length) !== expected)
            throw unclear('not all of them were found in the block');
        let cost = 0n;
        for (const x of others) {
            const input = String(x.input ?? '0x').toLowerCase(), self = lc(x.to ?? '') === wallet && input === '0x', approve = input.startsWith('0x095ea7b3') && big(x.value ?? '0x0') === 0n;
            if (!self && !approve)
                throw unclear(`${x.hash} is neither an approval nor a self-send`);
            const r = await this.rpc.call('eth_getTransactionReceipt', [x.hash]);
            if (!r)
                throw unclear(`${x.hash} has no receipt yet`);
            cost += big(r.gasUsed) * big(r.effectiveGasPrice) + (typeof r.l1Fee === 'string' ? big(r.l1Fee) : 0n); // a self-send's value comes straight back
        }
        return cost;
    }
    async receipt(hash) {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [hash]);
        if (!rc)
            return undefined;
        const t = await this.rpc.call('eth_getTransactionByHash', [hash]);
        const wallet = lc(rc.from), weth = lc(this.cfg.weth);
        // OP-stack chains (Base) also charge an L1 data fee, reported as the receipt's l1Fee: part of the network cost, not of the trade (mainnet 2026-11-18 booked it as spend)
        const gas = big(rc.gasUsed) * big(rc.effectiveGasPrice) + (typeof rc.l1Fee === 'string' ? big(rc.l1Fee) : 0n);
        const block = Number(big(rc.blockNumber));
        let platformFee = 0n;
        const deltas = {};
        const add = (k, d) => { deltas[k] = (deltas[k] ?? 0n) + d; };
        add(NATIVE, -gas);
        if (rc.status !== '0x1')
            return { hash, status: 'reverted', reason: 'reverted on-chain', block, deltas, network: gas, platformFee: 0n, venueFee: 0n };
        add(NATIVE, -big(t.value));
        for (const l of rc.logs) {
            const addr = lc(l.address), t0 = l.topics?.[0];
            if (t0 === TRANSFER && l.topics.length === 3) {
                const from = addrOfTopic(l.topics[1]), to = addrOfTopic(l.topics[2]), amt = big(l.data);
                if (to === wallet)
                    add(addr, amt);
                if (from === wallet)
                    add(addr, -amt);
            }
            else if (t0 === WITHDRAWAL && addr === weth && (addrOfTopic(l.topics[1]) === lc(t.to) || addrOfTopic(l.topics[1]) === lc(this.cfg.router)))
                add(NATIVE, big(l.data));
            else if (t0 === FEE_EVENT && this.cfg.feeRouter && addr === lc(this.cfg.feeRouter.address))
                platformFee += big(l.data); // router unwrapped WETH and forwarded the ETH
        }
        // Relay swaps: ETH paid out to the wallet is an internal transfer (no log), so the wallet's ETH change is read as its balance change across that block, which is exact
        // when this was its only transaction there (gas, value and ETH received). When the wallet's other transactions in that block can only have cost it ETH (approvals and
        // the engine's self-sends: their gas and L1 fee), those costs are added back. Anything else, or a node that no longer serves that state: not booked yet (retried).
        // the same holds for KyberSwap: its router pays ETH out with an internal transfer
        // recognised whichever aggregator is configured now: a trade sent before the server switched aggregator still settles the same way
        const K = this.relayK(), to = lc(t.to ?? ''), relayTx = [lc(K.router), lc(K.approvalProxy)].includes(to), kyberTx = to === KYBER.router;
        if (relayTx || kyberTx) {
            if (t.input && t.input !== '0x') {
                if (kyberTx)
                    decodeKyberSwap(t.input);
                else
                    decodeRelaySwap(t.input);
            } // throws on anything that is not a swap call of that aggregator
            const at = (m, b) => this.rpc.call(m, [wallet, hex(b)]).then(big), n = big(rc.blockNumber);
            let txs;
            try {
                txs = await at('eth_getTransactionCount', n) - await at('eth_getTransactionCount', n - 1n);
            }
            catch (e) {
                throw new RpcError(`the wallet's state at block ${n} is not available yet: ${e.message}`);
            }
            const othersCost = txs === 1n ? 0n : await this.otherTxsCost(wallet, n, lc(hash), txs - 1n);
            deltas[NATIVE] = await at('eth_getBalance', n) - await at('eth_getBalance', n - 1n) + othersCost;
            return { hash, status: 'success', block, deltas, network: gas, platformFee: 0n, venueFee: 0n };
        }
        // the WETH wrapper leg of a native-in swap is router<->pair, never the wallet, so it does not appear above
        const spent = deltas[NATIVE] !== undefined && big(t.value) > 0n ? big(t.value) : (() => { const k = Object.keys(deltas).find(x => x !== NATIVE && deltas[x] < 0n); return k ? -deltas[k] : 0n; })();
        const swapped = platformFee > 0n ? spent - platformFee : spent;
        return { hash, status: 'success', block, deltas, network: gas, platformFee, venueFee: swapped - swapped * V2_FEE.num / V2_FEE.den };
    }
}
