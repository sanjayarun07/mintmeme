/** RELAY as a same-chain venue on EVM chains (Base first): tokens whose liquidity is not in Uniswap V2 pools, such as Coinbase's tokenized stocks on Base (Aerodrome
 *  Slipstream and Uniswap V3/V4). Relay is a THIRD-PARTY service, so nothing it returns is signed blindly.
 *
 *  What a same-chain Relay swap is (decoded from live quotes on Base, 2026-11-18):
 *   - buy with ETH: ONE transaction to Relay's router `multicall((target, allowFailure, value, callData)[], refundTo, nftRecipient, metadata)` with value = the input;
 *   - sell a token: `approve(approvalProxy, exact amount)`, then the approval proxy's `transferAndMulticall(tokens[], amounts[], calls[], refundTo, nftRecipient, metadata)`,
 *     which pulls exactly those tokens from the wallet and runs the calls through the router.
 *   The calls seen: the router's `cleanupNative(amount, recipient, ...)` (Relay's fee, about 0.000003 ETH, to its solver address), a KyberSwap `swap(...)` whose on-chain
 *   minimum (`minReturnAmount`) equals Relay's quoted `minimumAmount` and pays the router, then the router's `cleanupErc20s(tokens[], recipients[], amounts[], ...)` or
 *   `cleanupNative` forwarding the output to the recipient.
 *  `gateRelay` refuses anything else: only the pinned router and approval proxy, an exact approve, the exact input, refunds only to us, every forward to OUR wallet,
 *  fees only to the pinned solver and capped, and exactly one inner swap of our pair whose on-chain minimum covers our minimum plus any fee taken from the output.
 *  An inner call it does not recognise is refused (fail closed: Relay may route other ways, which then are not tradable here until reviewed). The simulation
 *  (aggregator.ts `simulateCalls`) then checks the wallet's real balance changes.
 *  Sources: contracts from Relay's own API `GET https://api.relay.link/chains` (Base, contracts["v3.2"]: erc20Router 0x0729e2a4..97f7, approvalProxy 0x5567954c..2e58);
 *  the solver address from https://docs.relay.link/references/api/api_resources/contract-addresses.md; the quote API from https://docs.relay.link/references/api/get-quote-v2.md
 *  (POST /quote/v2; ETH is 0x0000000000000000000000000000000000000000; slippageTolerance in bps). The docs say /quote/v2 needs an API key from 2 Oct 2026; keyless calls still
 *  answered on 2026-11-18, so pass `apiKey` for production. Function names from the selector database (openchain.xyz) for 0xcd6e13f7, 0xf9e4bab4, 0xa6bd8c96, 0x9bb43718.
 *  Not done: cross-chain (deposit) requests, signature steps (permits), app fees. */
import { NATIVE } from '../../core/src/index.js';
import { normAddr } from './abi.js';
import { AggRefused, decodeKyberSwap, KYBER } from './aggregator.js';
/** Base mainnet (chain 8453), Relay v3.2 contracts as Relay's chains API lists them. */
export const RELAY_BASE = { router: '0x0729e2a4716d9f7dd17858d5d504426d228697f7', approvalProxy: '0x5567954cd026cebfe486062cb75848e0f1c12e58', solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef' };
export const RELAY_SEL = { multicall: '0xcd6e13f7', transferAndMulticall: '0xf9e4bab4', cleanupNative: '0xa6bd8c96', cleanupErc20s: '0x9bb43718', approve: '0x095ea7b3' };
const ZERO = '0x0000000000000000000000000000000000000000', lc = (s) => s.toLowerCase();
/** Engine token ('NATIVE' or 0x address) as Relay writes it. */
export const rAddr = (t) => (t === NATIVE ? ZERO : lc(normAddr(t)));
/** Relay could not answer right now (rate limited, a server error, unreachable): transient, so a trade waits and retries instead of failing. Other quote errors are final. */
export class RelayUnavailable extends Error {
}
export class RelayClient {
    o;
    constructor(o) {
        this.o = o;
    }
    /** A same-chain EXACT_INPUT quote for `wallet` (sender and recipient). Read-only. */
    async quote(wallet, tokenIn, tokenOut, amountIn, slippageBps) {
        const body = { user: lc(wallet), recipient: lc(wallet), originChainId: this.o.chainId, destinationChainId: this.o.chainId, originCurrency: rAddr(tokenIn), destinationCurrency: rAddr(tokenOut),
            amount: amountIn.toString(), tradeType: 'EXACT_INPUT', ...(slippageBps !== undefined ? { slippageTolerance: String(slippageBps) } : {}) };
        const send = () => (this.o.fetchFn ?? fetch)(`${this.o.baseUrl ?? 'https://api.relay.link'}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.o.apiKey ? { 'x-api-key': this.o.apiKey } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
        let r;
        try {
            r = await send();
        }
        catch (e) {
            throw new RelayUnavailable(`Relay is unreachable: ${e.message}`);
        }
        for (let i = 0; r.status === 429 && i < (this.o.retries429 ?? 3); i++) {
            await new Promise(ok => setTimeout(ok, 2000 * 2 ** i));
            try {
                r = await send();
            }
            catch (e) {
                throw new RelayUnavailable(`Relay is unreachable: ${e.message}`);
            }
        } // rate limited: back off briefly, then give up
        const j = await r.json().catch(() => ({})), why = `Relay quote failed: HTTP ${r.status}${j?.message ? `: ${String(j.message).slice(0, 200)}` : ''}`;
        if (r.status === 429 || r.status >= 500)
            throw new RelayUnavailable(why);
        if (!r.ok)
            throw new Error(why);
        const int = (v, n) => { if (typeof v !== 'string' || !/^\d+$/.test(v))
            throw new Error(`Relay field ${n} is not an integer string`); return BigInt(v); };
        const out = int(j?.details?.currencyOut?.amount, 'currencyOut.amount'), min = int(j?.details?.currencyOut?.minimumAmount, 'currencyOut.minimumAmount');
        if (lc(String(j?.details?.currencyOut?.currency?.address ?? rAddr(tokenOut))) !== rAddr(tokenOut))
            throw new Error('Relay answered for a different output token: refusing it');
        const steps = [];
        for (const s of (j.steps ?? [])) {
            if (s.kind !== 'transaction')
                throw new Error(`Relay asked for a ${s.kind} step (${s.id}): not supported`);
            for (const it of (s.items ?? [])) {
                const d = it?.data ?? {};
                if (Number(d.chainId) !== this.o.chainId)
                    throw new Error(`a Relay step is on chain ${d.chainId}, not ${this.o.chainId}`);
                if (typeof d.to !== 'string' || typeof d.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(d.data))
                    throw new Error('Relay returned a malformed step');
                steps.push({ id: String(s.id), to: lc(d.to), data: d.data, value: BigInt(String(d.value ?? '0')) });
            }
        }
        if (!steps.length || out <= 0n)
            throw new Error('Relay found no route');
        return { requestId: String(j.steps?.[0]?.requestId ?? ''), amountOut: out, minimumOut: min, relayerFeeWei: BigInt(String(j?.fees?.relayer?.amount ?? '0').replace(/\D/g, '') || '0'), steps };
    }
}
function reader(hex) {
    const body = hex.slice(10), words = body.length / 64;
    if (!Number.isInteger(words))
        throw new AggRefused('calldata is not word-aligned');
    const w = (i) => { if (i < 0n || i >= BigInt(words))
        throw new AggRefused('calldata offset out of range'); const n = Number(i); return BigInt('0x' + body.slice(n * 64, n * 64 + 64)); };
    const at = (byteOff, k) => { if (byteOff % 32n)
        throw new AggRefused('misaligned calldata offset'); return w(byteOff / 32n + BigInt(k)); };
    const addr = (x) => { if (x >> 160n)
        throw new AggRefused('malformed address in calldata'); return '0x' + x.toString(16).padStart(40, '0'); };
    const bytes = (off) => { const len = at(off, 0), start = Number(off / 32n + 1n) * 64; if (start + Number(len) * 2 > body.length)
        throw new AggRefused('bytes out of range'); return '0x' + body.slice(start, start + Number(len) * 2); };
    const array = (off) => { const n = Number(at(off, 0)); if (n > 64)
        throw new AggRefused('array too long'); return Array.from({ length: n }, (_, k) => at(off, k + 1)); };
    const calls = (off) => array(off).map((_, k) => { const el = off + 32n + at(off, k + 1); return { target: addr(at(el, 0)), value: at(el, 2), data: bytes(el + at(el, 3)) }; });
    return { w, at, addr, bytes, array, calls };
}
/** The router's multicall, or the approval proxy's transferAndMulticall: pulled tokens and amounts (none for multicall), the inner calls, the refund address. */
export function decodeRelaySwap(data) {
    const sel = data.slice(0, 10).toLowerCase(), r = reader(data);
    if (sel === RELAY_SEL.multicall)
        return { kind: 'multicall', tokens: [], amounts: [], calls: r.calls(r.w(0n)), refundTo: r.addr(r.w(1n)), nftRecipient: r.addr(r.w(2n)) };
    if (sel === RELAY_SEL.transferAndMulticall)
        return { kind: 'transferAndMulticall', tokens: r.array(r.w(0n)).map(r.addr), amounts: r.array(r.w(1n)), calls: r.calls(r.w(2n)), refundTo: r.addr(r.w(3n)), nftRecipient: r.addr(r.w(4n)) };
    throw new AggRefused(`not a Relay router call (selector ${sel})`);
}
function decodeCleanup(data) {
    const sel = data.slice(0, 10).toLowerCase(), r = reader(data);
    if (sel === RELAY_SEL.cleanupNative)
        return { kind: 'native', amount: r.w(0n), recipient: r.addr(r.w(1n)) };
    if (sel === RELAY_SEL.cleanupErc20s)
        return { kind: 'erc20', tokens: r.array(r.w(0n)).map(r.addr), recipients: r.array(r.w(1n)).map(r.addr), amounts: r.array(r.w(2n)) };
    return undefined;
}
/** 0x as an inner route: `AllowanceHolder.exec(operator, token, amount, target, data)` into a 0x Settler, whose `execute((recipient, buyToken, minAmountOut), actions[], zid)`
 *  carries the on-chain minimum. Settlers are redeployed over time; the current one is `ownerOf(2)` (feature 2, taker-submitted) on 0x's Deployer registry, which the chain
 *  checks before signing (`verifySettler`). On Base, 2026-11-18, ownerOf(2) = 0x1035...21a8, the Settler Relay's routes used. */
export const ZEROX = { allowanceHolder: '0x0000000000001ff3684f28c67538d4d072c22734', deployer: '0x00000000000004533fe15556b1e086bb1a72ceae', feature: 2n, exec: '0x2213bc0b', settlerExecute: '0x1fff991f', eth: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };
function decodeZeroX(data) {
    if (data.slice(0, 10).toLowerCase() !== ZEROX.exec)
        throw new AggRefused(`not an AllowanceHolder exec call (${data.slice(0, 10)})`);
    const r = reader(data), inner = r.bytes(r.w(4n));
    if (inner.slice(0, 10).toLowerCase() !== ZEROX.settlerExecute)
        throw new AggRefused(`the 0x call is not a Settler execute (${inner.slice(0, 10)})`);
    const s = reader(inner);
    return { operator: r.addr(r.w(0n)), token: r.addr(r.w(1n)), amount: r.w(2n), target: r.addr(r.w(3n)), recipient: s.addr(s.w(0n)), buyToken: s.addr(s.w(1n)), minAmountOut: s.w(2n) };
}
/** IceCreamSwap's `AggregatorGuard` as an inner route (verified source on Sourcify, Base 0xc87de04e...fc3d, solc 0.8.26): `IceCreamSwap()` with PACKED calldata
 *  (after the selector: id u16 @4, executor @6, amountIn u128 @26, minAmountOut u128 @42, firstTokenReceiver @59, recipient @79, tokenIn @99, tokenOut @119). It runs the
 *  executor, then measures the RECIPIENT's balance change and reverts with "Insufficient output" below minAmountOut: an on-chain minimum we can read. */
export const ICECREAM_GUARD = { address: '0xc87de04e2ec1f4282dff2933a2d58199f688fc3d', selector: '0x3f0bde25' };
function decodeGuard(data) {
    const d = data.toLowerCase();
    if (d.slice(0, 10) !== ICECREAM_GUARD.selector || d.length < 2 + 2 * 139)
        throw new AggRefused('not an AggregatorGuard swap call');
    const field = (byte, len) => '0x' + d.slice(2 + 2 * byte, 2 + 2 * (byte + len)), addr = (byte) => field(byte, 20);
    return { executor: addr(6), amountIn: BigInt(field(26, 16)), minAmountOut: BigInt(field(42, 16)), recipient: addr(79), tokenIn: addr(99), tokenOut: addr(119) };
}
/** The current 0x Settler from 0x's on-chain registry (ownerOf(feature)), for comparing with the one a route calls. */
export async function currentSettler(rpc) {
    const r = await rpc.call('eth_call', [{ to: ZEROX.deployer, data: '0x6352211e' + ZEROX.feature.toString(16).padStart(64, '0') }, 'latest']);
    return '0x' + r.slice(-40).toLowerCase();
}
/** Refuses a Relay quote unless its transactions are exactly the swap the engine intends. Returns the swap step (the one to sign) and the fee Relay takes. */
export function gateRelay(steps, c) {
    const refuse = (why) => { throw new AggRefused(why); };
    const wallet = lc(c.wallet), K = { router: lc(c.contracts.router), proxy: lc(c.contracts.approvalProxy), solver: lc(c.contracts.solver) }, native = c.tokenIn === NATIVE;
    const approves = steps.filter(s => s.data.slice(0, 10).toLowerCase() === RELAY_SEL.approve), swaps = steps.filter(s => !approves.includes(s));
    if (approves.length > 1 || swaps.length !== 1)
        refuse(`unexpected Relay steps: ${steps.map(s => s.id).join(', ')}`);
    if (approves[0]) {
        const a = approves[0], r = reader(a.data);
        if (native)
            refuse('an approve step on an ETH-in swap');
        if (a.to !== rAddr(c.tokenIn) || a.value !== 0n)
            refuse('the approve step is not on the input token');
        if (r.addr(r.w(0n)) !== K.proxy)
            refuse(`the approve step approves ${r.addr(r.w(0n))}, not Relay's approval proxy`);
        if (r.w(1n) !== c.amountIn)
            refuse(`the approve step approves ${r.w(1n)}, not exactly ${c.amountIn}`);
    }
    const s = swaps[0], d = decodeRelaySwap(s.data);
    if (native) {
        if (s.to !== K.router || d.kind !== 'multicall')
            refuse(`an ETH-in swap must call Relay's router multicall (got ${s.to})`);
        if (s.value !== c.amountIn)
            refuse(`the swap sends ${s.value} wei, not ${c.amountIn}`);
    }
    else {
        if (s.to !== K.proxy || d.kind !== 'transferAndMulticall')
            refuse(`a token-in swap must call Relay's approval proxy (got ${s.to})`);
        if (s.value !== 0n)
            refuse('a token-in swap must not send ETH');
        if (d.tokens.length !== 1 || d.tokens[0] !== rAddr(c.tokenIn) || d.amounts[0] !== c.amountIn)
            refuse(`the proxy pulls ${d.tokens.join(',')} ${d.amounts.join(',')}, not exactly ${c.amountIn} of the input`);
    }
    if (![ZERO, wallet].includes(d.refundTo) || ![ZERO, wallet].includes(d.nftRecipient))
        refuse('refunds go to someone other than our wallet');
    let fee = 0n, inner, outWei = 0n, settler;
    const kin = c.tokenIn === NATIVE ? KYBER.native : rAddr(c.tokenIn), kout = c.tokenOut === NATIVE ? KYBER.native : rAddr(c.tokenOut);
    for (const call of d.calls) {
        const t = lc(call.target);
        if (t === K.router) {
            const cl = decodeCleanup(call.data);
            if (!cl)
                refuse(`unrecognised router call ${call.data.slice(0, 10)} in the Relay route`);
            if (cl.kind === 'native') {
                if (cl.recipient === K.solver)
                    fee += cl.amount;
                else if (cl.recipient !== wallet)
                    refuse(`ETH is forwarded to ${cl.recipient}, not our wallet`);
            }
            else if (cl.recipients.some(r => r !== wallet))
                refuse(`tokens are forwarded to ${cl.recipients.find(r => r !== wallet)}, not our wallet`);
        }
        else if (t === KYBER.router) {
            if (inner)
                refuse('more than one swap in the Relay route');
            const k = decodeKyberSwap(call.data);
            inner = k;
            if (k.srcToken !== kin || k.dstToken !== kout)
                refuse(`the inner swap trades ${k.srcToken} -> ${k.dstToken}, not this pair`);
            if (![K.router, wallet].includes(k.dstReceiver))
                refuse(`the inner swap pays ${k.dstReceiver}`);
            if (k.feeReceivers !== 0)
                refuse('the inner swap pays fee receivers');
            if (k.amount > c.amountIn)
                refuse('the inner swap spends more than the input');
        }
        else if (t === ZEROX.allowanceHolder) {
            if (inner)
                refuse('more than one swap in the Relay route');
            const z = decodeZeroX(call.data);
            inner = { minReturnAmount: z.minAmountOut };
            if (z.operator !== z.target)
                refuse('the 0x call runs a different contract than it authorises');
            settler = z.target;
            if (z.token !== (c.tokenIn === NATIVE ? ZERO : rAddr(c.tokenIn)) || z.amount > c.amountIn)
                refuse(`the 0x call spends ${z.amount} of ${z.token}, not the input`);
            if (z.buyToken !== (c.tokenOut === NATIVE ? ZEROX.eth : rAddr(c.tokenOut)))
                refuse(`the 0x call buys ${z.buyToken}, not the output`);
            if (![K.router, wallet].includes(z.recipient))
                refuse(`the 0x call pays ${z.recipient}`);
        }
        else if (t === ICECREAM_GUARD.address) {
            if (inner)
                refuse('more than one swap in the Relay route');
            const gd = decodeGuard(call.data);
            inner = { minReturnAmount: gd.minAmountOut };
            if (gd.tokenIn !== kin || gd.tokenOut !== kout)
                refuse(`the guarded swap trades ${gd.tokenIn} -> ${gd.tokenOut}, not this pair`);
            if (gd.amountIn > c.amountIn)
                refuse('the guarded swap spends more than the input');
            if (![K.router, wallet].includes(gd.recipient))
                refuse(`the guarded swap pays ${gd.recipient}`);
            if (native && call.value !== gd.amountIn)
                refuse('the guarded swap sends a different ETH value than it declares');
        }
        else if (!native && t === rAddr(c.tokenIn) && call.data.slice(0, 10).toLowerCase() === RELAY_SEL.approve) {
            // on a sell the router lets the inner swap spend the tokens it pulled: only a reviewed swap contract, at most the input
            const r = reader(call.data), spender = r.addr(r.w(0n));
            if (![KYBER.router, ZEROX.allowanceHolder, ICECREAM_GUARD.address].includes(spender))
                refuse(`the route approves ${spender}, which is not a reviewed swap contract`);
            if (r.w(1n) > c.amountIn)
                refuse(`the route approves ${r.w(1n)}, more than the input ${c.amountIn}`);
        }
        else
            refuse(`the Relay route calls ${t}, which is not reviewed here`);
    }
    if (!inner)
        refuse('the Relay route has no swap with an on-chain minimum we can check');
    // the fee comes from the input on a buy (ETH in) and from the output on a sell (ETH out): either way it is ETH and capped
    outWei = native ? c.amountIn : c.minOut;
    const cap = c.maxFeeWei ?? (outWei / 100n > 10n ** 14n ? outWei / 100n : 10n ** 14n);
    if (fee > cap)
        refuse(`Relay's fee ${fee} wei is above the cap ${cap}`);
    const onchainMin = inner.minReturnAmount - (c.tokenOut === NATIVE ? fee : 0n);
    if (onchainMin < c.minOut)
        refuse(`the route's on-chain minimum ${onchainMin} is below ours (${c.minOut})`);
    return { swap: s, feeWei: fee, settler };
}
