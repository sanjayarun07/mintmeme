/** Jupiter swap EXECUTION for the Solana engine. Jupiter is a THIRD-PARTY service, so nothing it returns is signed blindly:
 *   1. We ask Jupiter's Swap API V2 `GET /swap/v2/build` for RAW INSTRUCTIONS (not a finished transaction) and compile the v0 message ourselves, with the
 *      address lookup tables read from the chain (the tables Jupiter claims must match the chain or we refuse).
 *   2. `gateInstructions` refuses anything outside a strict allowlist BEFORE signing (see below).
 *   3. The compiled transaction is SIMULATED against the chain and the wallet's balances are checked: output >= the engine's minOut, input <= the intent.
 *  Sources (read 2026-11-14, not recalled):
 *   - Swap API V2 base URL, `/build` request/response shape, keyless limit 0.5 requests/s, `x-api-key` header: https://developers.jup.ag/docs/swap/build/index.md and https://developers.jup.ag/docs/swap/index.md
 *   - DEX program ids Jupiter can route through (112 on the day): `GET https://api.jup.ag/swap/v2/program-id-to-label` (https://developers.jup.ag/docs/api-reference/swap/program-id-to-label.md). Fetched live and cached; if it cannot be fetched we REFUSE to trade.
 *   - Jupiter v6 swap aggregator program `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`: named in https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming.md ("the Jupiter v6 swap aggregator program"), and it is what `/build` returned as `swapInstruction.programId`.
 *  What is NOT done: no Jito/tips (tipInstruction is refused), no Token-2022 (refused), no platform fee, priority fee: the compute-unit limit is set from our simulation and the price from priorityfee.ts (or Jupiter's, capped) by SolanaChain, no `/execute` or `/submit` (we send through our own node).
 *  The gate cannot read the aggregator's instruction data, so protection for the swap itself is (a) the on-chain slippage we pass, set so Jupiter's own minimum output is >= the engine's minOut, and (b) the simulated balance check. */
import { b58decode, base58, cat, pubkeyBytes, shortvec, ataAddress, PROGRAMS, COMPUTE_BUDGET, u64le, u32le } from './tx.js';
export const JUPITER = {
    buildUrl: 'https://api.jup.ag/swap/v2/build', labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
    v6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', source: 'https://developers.jup.ag/docs/swap/build/index.md',
    v6Source: 'https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming.md', labelsSource: 'https://developers.jup.ag/docs/api-reference/swap/program-id-to-label.md',
};
/** Thrown when the safety gate or a check refuses a Jupiter transaction. Never retried: the caller must treat it as a hard stop. */
export class JupiterRefused extends Error {
}
/* ---------------- v0 message: compile, parse, resolve ---------------- */
const idxOf = (list, k) => { const i = list.indexOf(k); if (i < 0)
    throw new Error(`internal: ${k} missing from account list`); return i; };
/** Compile a v0 message. `tables` come from the CHAIN. Signers and program ids stay static; any other account found in a table is loaded through it. */
export function compileV0(payer, ixs, blockhash, tables) {
    if (blockhash.length !== 32)
        throw new Error('blockhash must be 32 bytes');
    const meta = new Map();
    const touch = (k, s, w, inv = false) => { const m = meta.get(k) ?? { signer: false, writable: false, invoked: false }; m.signer ||= s; m.writable ||= w; m.invoked ||= inv; meta.set(k, m); };
    touch(payer, true, true);
    for (const ix of ixs) {
        touch(ix.programId, false, false, true);
        for (const a of ix.accounts)
            touch(a.pubkey, a.isSigner, a.isWritable);
    }
    const tableOf = (k) => tables.findIndex(t => t.addresses.includes(k));
    const stat = [[], [], [], []], lw = tables.map(() => []), lr = tables.map(() => []); // signer-w, signer-r, nonsigner-w, nonsigner-r
    for (const [k, m] of meta) {
        const t = tableOf(k);
        if (!m.signer && !m.invoked && t >= 0)
            (m.writable ? lw : lr)[t].push(k);
        else
            stat[m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3)].push(k);
    }
    stat[0] = [payer, ...stat[0].filter(k => k !== payer)];
    const statics = stat.flat(), loaded = [...lw.flat(), ...lr.flat()], all = [...statics, ...loaded];
    const header = Uint8Array.of(stat[0].length + stat[1].length, stat[1].length, stat[3].length);
    const parts = [Uint8Array.of(0x80), header, shortvec(statics.length), ...statics.map(pubkeyBytes), blockhash, shortvec(ixs.length)];
    for (const ix of ixs)
        parts.push(Uint8Array.of(idxOf(all, ix.programId)), shortvec(ix.accounts.length), Uint8Array.from(ix.accounts.map(a => idxOf(all, a.pubkey))), shortvec(ix.data.length), ix.data);
    const used = tables.map((t, i) => ({ t, w: lw[i], r: lr[i] })).filter(x => x.w.length || x.r.length);
    parts.push(shortvec(used.length));
    for (const { t, w, r } of used)
        parts.push(pubkeyBytes(t.key), shortvec(w.length), Uint8Array.from(w.map(k => t.addresses.indexOf(k))), shortvec(r.length), Uint8Array.from(r.map(k => t.addresses.indexOf(k))));
    if (all.length > 256)
        throw new Error('too many accounts for one transaction');
    return cat(...parts);
}
export function parseMessage(m) {
    let p = 0;
    const u8 = () => { if (p >= m.length)
        throw new Error('message truncated'); return m[p++]; };
    const sv = () => { let v = 0, sh = 0; for (;;) {
        const b = u8();
        v |= (b & 0x7f) << sh;
        if (!(b & 0x80))
            return v;
        sh += 7;
        if (sh > 21)
            throw new Error('bad shortvec');
    } };
    const take = (n) => { if (p + n > m.length)
        throw new Error('message truncated'); const o = m.subarray(p, p + n); p += n; return o; };
    const version = m[0] & 0x80 ? (((m[0] & 0x7f) === 0) ? 0 : (() => { throw new Error(`unsupported message version ${m[0] & 0x7f}`); })()) : 'legacy';
    if (version === 0)
        p++;
    const signers = u8(), readonlySigned = u8(), readonlyUnsigned = u8();
    const staticKeys = Array.from({ length: sv() }, () => base58(take(32))), blockhash = base58(take(32));
    const ixs = Array.from({ length: sv() }, () => ({ programIdIndex: u8(), accountIndexes: Array.from(take(sv())), data: Uint8Array.from(take(sv())) }));
    const lookups = version === 0 ? Array.from({ length: sv() }, () => ({ table: base58(take(32)), writable: Array.from(take(sv())), readonly: Array.from(take(sv())) })) : [];
    if (p !== m.length)
        throw new Error('trailing bytes after message');
    return { version, signers, readonlySigned, readonlyUnsigned, staticKeys, blockhash, ixs, lookups };
}
/** Back to instructions with flags, resolving lookup-table accounts from `tables` (chain data). */
export function resolveMessage(pm, tables) {
    const loadedW = [], loadedR = [];
    for (const l of pm.lookups) {
        const t = tables.find(x => x.key === l.table);
        if (!t)
            throw new JupiterRefused(`message uses lookup table ${l.table} that was not read from the chain`);
        for (const i of l.writable) {
            if (!t.addresses[i])
                throw new JupiterRefused('lookup index out of range');
            loadedW.push(t.addresses[i]);
        }
        for (const i of l.readonly) {
            if (!t.addresses[i])
                throw new JupiterRefused('lookup index out of range');
            loadedR.push(t.addresses[i]);
        }
    }
    const all = [...pm.staticKeys, ...loadedW, ...loadedR], ns = pm.staticKeys.length;
    const signer = (i) => i < pm.signers, writable = (i) => i < ns ? (i < pm.signers ? i < pm.signers - pm.readonlySigned : i < ns - pm.readonlyUnsigned) : i < ns + loadedW.length;
    return pm.ixs.map(ix => { if (ix.programIdIndex >= ns)
        throw new JupiterRefused('program id loaded through a lookup table'); return { programId: all[ix.programIdIndex], data: ix.data, accounts: ix.accountIndexes.map(i => { if (i >= all.length)
            throw new JupiterRefused('account index out of range'); return { pubkey: all[i], isSigner: signer(i), isWritable: writable(i) }; }) }; });
}
export const unsignedV0 = (message) => cat(shortvec(message[1]), new Uint8Array(64 * message[1]), message); // message[0] is the 0x80 version prefix; message[1] = required signatures
export const wireV0 = (message, sigs) => { if (sigs.length !== message[1])
    throw new Error(`message needs ${message[1]} signature(s), got ${sigs.length}`); return cat(shortvec(sigs.length), ...sigs, message); };
/** Address lookup table account: 56-byte header, then 32-byte addresses. A table being deactivated cannot be trusted to keep its contents. */
export function decodeTable(key, data) {
    if (data.length < 56 || (data.length - 56) % 32 !== 0)
        throw new JupiterRefused(`lookup table ${key} has an unexpected size`);
    if (data.readUInt32LE(0) !== 1)
        throw new JupiterRefused(`account ${key} is not an initialised lookup table`);
    if (data.readBigUInt64LE(4) !== 0xffffffffffffffffn)
        throw new JupiterRefused(`lookup table ${key} is deactivated`);
    return { key, addresses: Array.from({ length: (data.length - 56) / 32 }, (_, i) => base58(data.subarray(56 + i * 32, 88 + i * 32))) };
}
const toIx = (r) => {
    if (!r || typeof r.programId !== 'string' || !Array.isArray(r.accounts) || typeof r.data !== 'string')
        throw new JupiterRefused('Jupiter returned a malformed instruction');
    b58decode(r.programId);
    return { programId: r.programId, data: Uint8Array.from(Buffer.from(r.data, 'base64')), accounts: r.accounts.map((a) => { if (typeof a.pubkey !== 'string' || typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean')
            throw new JupiterRefused('Jupiter returned a malformed account'); b58decode(a.pubkey); return { pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable }; }) };
};
const big = (v, name) => { if (typeof v !== 'string' || !/^\d+$/.test(v))
    throw new JupiterRefused(`Jupiter field ${name} is not an integer string`); return BigInt(v); };
async function getJson(url, c) {
    const f = c.fetchFn ?? fetch;
    let last = '';
    for (let a = 0; a < 4; a++) { // keyless access is 0.5 requests/s: back off on 429 instead of hammering
        const res = await f(url, { headers: c.apiKey ? { 'x-api-key': c.apiKey } : {}, signal: AbortSignal.timeout(c.timeoutMs ?? 15_000) });
        if (res.status === 429) {
            last = 'HTTP 429';
            await new Promise(r => setTimeout(r, 2200 * (a + 1)));
            continue;
        }
        if (!res.ok) {
            const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
            throw new Error(`Jupiter request failed: HTTP ${res.status}${body ? ' (' + body + ')' : ''}`);
        }
        return res.json();
    }
    throw new Error(`Jupiter rate limited us (${last}); try again later or set an API key`);
}
let labelCache;
/** Program ids Jupiter's own endpoint lists as routable DEXes. */
export async function fetchRoutableProgramIds(c = {}) {
    if (labelCache && Date.now() - labelCache.at < 3_600_000 && !c.fetchFn)
        return labelCache.ids;
    const j = await getJson(c.labelsUrl ?? JUPITER.labelsUrl, c);
    if (!j || typeof j !== 'object' || Array.isArray(j))
        throw new JupiterRefused('program-id-to-label answered in an unexpected shape: refusing to trade without a program allowlist');
    const ids = new Set(Object.keys(j));
    for (const k of ids)
        b58decode(k);
    if (ids.size < 10)
        throw new JupiterRefused('program-id-to-label returned too few programs: refusing');
    if (!c.fetchFn)
        labelCache = { at: Date.now(), ids };
    return ids;
}
export async function fetchBuild(o) {
    if (!(o.amount > 0n))
        throw new Error('amount must be positive');
    const u = new URL(o.buildUrl ?? JUPITER.buildUrl);
    u.search = new URLSearchParams({ inputMint: o.inputMint, outputMint: o.outputMint, amount: o.amount.toString(), taker: o.taker, slippageBps: String(o.slippageBps), ...(o.dexes?.length ? { dexes: o.dexes.join(',') } : {}), ...(o.maxAccounts ? { maxAccounts: String(o.maxAccounts) } : {}) }).toString();
    const j = await getJson(u.toString(), o);
    if (j?.error)
        throw new Error(`Jupiter build error: ${String(j.error).slice(0, 200)}`);
    if (j.inputMint !== o.inputMint || j.outputMint !== o.outputMint)
        throw new JupiterRefused('Jupiter answered for a different pair than requested');
    if (j.swapMode !== undefined && j.swapMode !== 'ExactIn')
        throw new JupiterRefused(`unexpected swap mode ${j.swapMode}`);
    if (j.transactionVersion !== 0)
        throw new JupiterRefused(`unexpected transaction version ${j.transactionVersion}: only v0 is supported`);
    if (j.tipInstruction)
        throw new JupiterRefused('Jupiter added a tip instruction, which we never asked for');
    const inAmount = big(j.inAmount, 'inAmount'), outAmount = big(j.outAmount, 'outAmount'), minOut = big(j.otherAmountThreshold, 'otherAmountThreshold');
    if (inAmount !== o.amount)
        throw new JupiterRefused(`Jupiter built for ${inAmount} in, we asked for ${o.amount}`);
    if (outAmount <= 0n || minOut > outAmount)
        throw new JupiterRefused('Jupiter response is inconsistent (zero output or threshold above output)');
    if (!j.swapInstruction)
        throw new JupiterRefused('Jupiter returned no swap instruction');
    const list = (x) => (Array.isArray(x) ? x : []).map(toIx);
    const swap = toIx(j.swapInstruction);
    const ixs = [...list(j.computeBudgetInstructions), ...list(j.setupInstructions), swap, ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : []), ...list(j.otherInstructions)];
    const claimedTables = Object.entries(j.addressesByLookupTableAddress ?? {}).map(([key, a]) => ({ key, addresses: a }));
    return { inAmount, outAmount, minOut, slippageBps: Number(j.slippageBps), priceImpactPct: Number(j.priceImpactPct), ixs, swapIndex: ixs.indexOf(swap), claimedTables, routeLabels: (j.routePlan ?? []).map((r) => String(r?.swapInfo?.label ?? '?')) };
}
const dv = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);
/** Refuses every instruction that is not one of the few shapes a swap legitimately needs. `ixs` is what will be SIGNED (resolved from the final message), in order. */
export function gateInstructions(ixs, c) {
    const refuse = (why) => { throw new JupiterRefused(why); };
    const wsolAta = ataAddress(c.wallet, c.wsol);
    const created = [];
    let createdNonWsol = 0, cuLimit = 0, cuPrice = 0n, swapIndex = -1;
    ixs.forEach((ix, n) => {
        for (const a of ix.accounts)
            if (a.isSigner && a.pubkey !== c.wallet)
                refuse(`instruction ${n} requires a signature from ${a.pubkey}, which is not our wallet`);
        const p = ix.programId;
        if (p === COMPUTE_BUDGET) {
            if (ix.data[0] === 2 && ix.data.length === 5)
                cuLimit = dv(ix.data).getUint32(1, true);
            else if (ix.data[0] === 3 && ix.data.length === 9)
                cuPrice = dv(ix.data).getBigUint64(1, true);
            else
                refuse(`compute budget instruction type ${ix.data[0]} is not allowed`);
        }
        else if (p === PROGRAMS.system) {
            if (ix.data.length !== 12 || dv(ix.data).getUint32(0, true) !== 2)
                refuse('only a plain System transfer is allowed');
            const [from, to] = [ix.accounts[0]?.pubkey, ix.accounts[1]?.pubkey], lamports = dv(ix.data).getBigUint64(4, true);
            if (c.fees?.some(f => f.to === to && f.lamports === lamports)) {
                if (from !== c.wallet)
                    refuse('a fee transfer must come from our wallet');
                return;
            }
            if (c.tip && to === c.tip.to) {
                if (from !== c.wallet || lamports > c.tip.maxLamports)
                    refuse(`the tip transfer is not ours or is above ${c.tip.maxLamports} lamports`);
                return;
            }
            if (from !== c.wallet || to !== wsolAta)
                refuse('a System transfer may only move SOL from our wallet into our own wrapped-SOL account');
            if (c.tokenIn !== c.wsol || lamports > c.amountIn)
                refuse(`a System transfer of ${lamports} lamports exceeds what this swap may spend (${c.tokenIn === c.wsol ? c.amountIn : 0n})`);
        }
        else if (p === PROGRAMS.token) {
            const t = ix.data[0], k = ix.accounts.map(a => a.pubkey);
            if (t === 17 && ix.data.length === 1 && k[0] === wsolAta)
                return; // SyncNative on our wrapped-SOL account
            if (t === 9 && ix.data.length === 1 && k.length >= 3 && k[1] === c.wallet && k[2] === c.wallet)
                return; // CloseAccount: destination and authority are our wallet
            refuse(`token instruction type ${t} is not allowed (only SyncNative on our wSOL account and CloseAccount back to our wallet)`);
        }
        else if (p === PROGRAMS.ata) {
            const k = ix.accounts.map(a => a.pubkey);
            if (!(ix.data.length === 0 || (ix.data.length === 1 && (ix.data[0] === 0 || ix.data[0] === 1))))
                refuse('unexpected associated-token-account instruction');
            if (k.length < 6 || k[0] !== c.wallet || k[2] !== c.wallet)
                refuse('an associated token account may only be created by and for our wallet');
            if (k[1] !== ataAddress(c.wallet, k[3]))
                refuse('associated token account address does not match its mint and owner');
            if (k[4] !== PROGRAMS.system || k[5] !== PROGRAMS.token)
                refuse('associated token accounts must use the System and classic Token programs (Token-2022 is not supported)');
            created.push(k[1]);
            if (k[3] !== c.wsol)
                createdNonWsol++;
        }
        else if (c.allowedPrograms.has(p) || p === JUPITER.v6) {
            if (p === JUPITER.v6) {
                if (swapIndex >= 0)
                    refuse('more than one Jupiter route instruction');
                swapIndex = n;
                if (!ix.accounts.some(a => a.pubkey === c.wallet && a.isSigner))
                    refuse('the route instruction does not use our wallet as the authority');
            }
            else
                refuse(`program ${p} is a routable DEX but may only be invoked through the Jupiter aggregator, not at the top level`);
        }
        else
            refuse(`program ${p} is not on the allowlist`);
    });
    if (swapIndex < 0)
        refuse('no Jupiter route instruction found');
    if (cuLimit > c.maxComputeUnits)
        refuse(`compute unit limit ${cuLimit} is above the cap ${c.maxComputeUnits}`);
    // Without a compute-unit-limit instruction the runtime budgets 200,000 CU for EACH non-compute-budget instruction (capped at 1.4M), and the priority fee is charged on that budget.
    const effLimit = cuLimit || Math.min(1_400_000, 200_000 * ixs.filter(i => i.programId !== COMPUTE_BUDGET).length);
    const priorityLamports = (cuPrice * BigInt(effLimit) + 999999n) / 1000000n;
    if (priorityLamports > c.maxPriorityLamports)
        refuse(`priority fee up to ${priorityLamports} lamports is above the cap ${c.maxPriorityLamports}`);
    return { createdTokenAccounts: created, createdNonWsol, computeUnitLimit: cuLimit, priorityLamports, swapIndex };
}
/** Accounts the route instruction writes that might be the wallet's token accounts: the chain is asked who owns them. */
export function walletTokenAccountsAtRisk(route, wallet, allowed, owned) {
    return route.accounts.filter(a => a.isWritable && !a.isSigner && !allowed.has(a.pubkey) && owned(a.pubkey)).map(a => a.pubkey);
}
/* ---------------- venue ---------------- */
/** A Jupiter route for ONE direction of ONE pair, as a reference snapshot: quote(amount) scales the snapshot linearly (optimistic for large sizes). The REAL route is re-quoted at the exact
 *  amount when the transaction is built, and refused if it cannot meet the engine's minOut, so a stale or optimistic snapshot can cost a retry but never a worse fill. */
export class JupiterVenue {
    id;
    inMint;
    outMint;
    wsol;
    refIn;
    refOut;
    impactBps;
    slot;
    kind = 'cpamm';
    status = 'active';
    successor;
    family = 'jupiter';
    constructor(id, inMint, outMint, wsol, refIn, refOut, impactBps, slot = 0) {
        this.id = id;
        this.inMint = inMint;
        this.outMint = outMint;
        this.wsol = wsol;
        this.refIn = refIn;
        this.refOut = refOut;
        this.impactBps = impactBps;
        this.slot = slot;
    }
    res(t) { return t === 'NATIVE' ? this.wsol : t; }
    supports(a, b) { return this.res(a) === this.inMint && this.res(b) === this.outMint; }
    quote(a, b, amt) {
        if (!this.supports(a, b))
            throw new Error('unsupported pair');
        return { venue: this.id, family: this.family, amountOut: this.refOut * amt / this.refIn, priceImpactBps: this.impactBps, venueFee: 0n, liquidity: this.refOut };
    }
    spotPriceE18(a, b) { if (!this.supports(a, b))
        throw new Error('unsupported pair'); return this.refOut * 10n ** 18n / this.refIn; }
    swap(a, b, amt) { const q = this.quote(a, b, amt); return { amountOut: q.amountOut, venueFee: 0n }; }
    clone() { return new JupiterVenue(this.id, this.inMint, this.outMint, this.wsol, this.refIn, this.refOut, this.impactBps, this.slot); }
}
export { u64le, u32le };
