import { base58, findProgramAddress, pubkeyBytes, u64le, cat, PROGRAMS } from './tx.js';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const DISC = { buy: [102, 6, 61, 18, 1, 218, 235, 234], buyExactSolIn: [56, 252, 116, 8, 158, 223, 205, 95], sell: [51, 230, 133, 164, 1, 127, 131, 173], curve: [23, 183, 248, 55, 96, 216, 172, 96], global: [167, 232, 232, 177, 200, 108, 114, 127] };
const FEE_CONFIG_SEED2 = Uint8Array.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, program = PUMP_PROGRAM) => findProgramAddress(seeds, program).address;
const same = (d, o, want) => want.every((b, i) => d[o + i] === b);
/** BondingCurve: 8-byte discriminator, then u64 x5 (virtual token, virtual sol, real token, real sol, total supply), bool complete, pubkey creator, bool mayhem, bool cashback (the last two exist on newer accounts). */
export function decodeCurve(d) {
    if (d.length < 81)
        throw new Error(`bonding curve account is ${d.length} bytes, expected at least 81: refusing to decode`);
    if (!same(d, 0, DISC.curve))
        throw new Error('account is not a pump.fun bonding curve (discriminator mismatch)');
    return { virtualToken: d.readBigUInt64LE(8), virtualSol: d.readBigUInt64LE(16), realToken: d.readBigUInt64LE(24), realSol: d.readBigUInt64LE(32), totalSupply: d.readBigUInt64LE(40), complete: d[48] === 1,
        creator: base58(d.subarray(49, 81)), mayhem: d.length > 81 ? d[81] === 1 : undefined, cashback: d.length > 82 ? d[82] === 1 : undefined, size: d.length };
}
/** Global: discriminator, bool initialized, pubkey authority, pubkey fee_recipient, 4 x u64 reserves, u64 fee_basis_points, pubkey withdraw_authority, bool, u64 pool_migration_fee, u64 creator_fee_basis_points, 7 x pubkey fee_recipients. */
export function decodeGlobal(d) {
    if (d.length < 386)
        throw new Error(`global account is ${d.length} bytes, expected at least 386: refusing to decode`);
    if (!same(d, 0, DISC.global))
        throw new Error('account is not the pump.fun Global account (discriminator mismatch)');
    const pk = (o) => base58(d.subarray(o, o + 32));
    return { feeBps: d.readBigUInt64LE(105), creatorFeeBps: d.readBigUInt64LE(154), feeRecipient: pk(41), feeRecipients: Array.from({ length: 7 }, (_, i) => pk(162 + 32 * i)),
        buybackRecipients: d.length >= 997 ? Array.from({ length: 8 }, (_, i) => pk(741 + 32 * i)) : [] };
}
/** fee_config (owned by the fee program): flat fees at byte 41 (lp, protocol, creator as u64 bps), then a u32 count at 65 and that many 40-byte tiers (u128 market-cap threshold in lamports, then lp, protocol, creator).
 *  Layout worked out from one live account and checked against the program's own GetFeesWithQuoteMint return (0 / 95 / 30 bps); anything implausible is refused rather than guessed. */
export function decodeFeeConfig(d) {
    if (d.length < 69)
        throw new Error('fee config account too short');
    const fs = (o) => ({ lp: d.readBigUInt64LE(o), protocol: d.readBigUInt64LE(o + 8), creator: d.readBigUInt64LE(o + 16) });
    const flat = fs(41), n = d.readUInt32LE(65);
    if (n > 64 || 69 + n * 40 > d.length)
        throw new Error(`fee config reports ${n} tiers: layout not recognised`);
    const tiers = Array.from({ length: n }, (_, i) => { const o = 69 + i * 40; return { marketCap: d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n), fees: fs(o + 16) }; });
    for (const f of [flat, ...tiers.map(t => t.fees)])
        if (f.lp + f.protocol + f.creator > 2000n)
            throw new Error('fee config values implausible: layout not recognised');
    return { flat, tiers };
}
/** Fee bps for a curve at a market cap: the tier with the largest threshold not above it, else the flat fees. */
export function feeBpsAt(c, marketCapLamports) {
    let best = c.flat, at = -1n;
    for (const t of c.tiers)
        if (t.marketCap <= marketCapLamports && t.marketCap > at) {
            best = t.fees;
            at = t.marketCap;
        }
    return best.lp + best.protocol + best.creator;
}
export function pumpAddresses(mint, creator, tokenProgram) {
    const bondingCurve = pda([enc('bonding-curve'), pubkeyBytes(mint)]);
    return { global: pda([enc('global')]), bondingCurve, associatedBondingCurve: ataAddress2(bondingCurve, mint, tokenProgram), creatorVault: pda([enc('creator-vault'), pubkeyBytes(creator)]),
        eventAuthority: pda([enc('__event_authority')]), globalVolumeAccumulator: pda([enc('global_volume_accumulator')]), userVolumeAccumulator: u => pda([enc('user_volume_accumulator'), pubkeyBytes(u)]),
        feeConfig: pda([enc('fee_config'), FEE_CONFIG_SEED2], PUMP_FEE_PROGRAM) };
}
/** Associated token account for any token program (the shared helper in tx.ts is fixed to the classic token program). */
export const ataAddress2 = (owner, mint, tokenProgram) => findProgramAddress([pubkeyBytes(owner), pubkeyBytes(tokenProgram), pubkeyBytes(mint)], PROGRAMS.ata).address;
export const createAtaIdempotent2 = (payer, owner, mint, tokenProgram) => ({ program: PROGRAMS.ata, data: Uint8Array.of(1),
    keys: [{ pubkey: payer, signer: true, writable: true }, { pubkey: ataAddress2(owner, mint, tokenProgram), writable: true }, { pubkey: owner }, { pubkey: mint }, { pubkey: PROGRAMS.system }, { pubkey: tokenProgram }] });
const BPS = 10000n;
/** Tokens received for a SOL budget (fees are taken out of the budget): net = floor(budget x 10000 / (10000 + fee bps)); tokens = floor((net - 1) x virtual token / (virtual sol + net - 1)). Formula from the IDL's own docs. */
export function quoteBuy(budget, c, totalFeeBps) {
    const net = budget * BPS / (BPS + totalFeeBps);
    if (net <= 1n)
        return { tokens: 0n, net, fee: budget - net };
    const raw = (net - 1n) * c.virtualToken / (c.virtualSol + net - 1n);
    const tokens = raw > c.realToken ? c.realToken : raw;
    return { tokens, net, fee: budget - net };
}
/** SOL received for selling `tokens`: gross = floor(tokens x virtual sol / (virtual token + tokens)); the fee is taken from it. */
export function quoteSell(tokens, c, totalFeeBps) {
    const gross = tokens * c.virtualSol / (c.virtualToken + tokens), fee = (gross * totalFeeBps + BPS - 1n) / BPS;
    return { gross, fee, net: gross > fee ? gross - fee : 0n };
}
const ro = (pubkey) => ({ pubkey }), rw = (pubkey) => ({ pubkey, writable: true });
/** Newer program versions take two trailing accounts: the per-mint bonding_curve_v2 PDA and a buyback fee recipient from Global (program error 6062 without it). */
const tail = (c) => c.buybackRecipient ? [rw(pda([enc('bonding-curve-v2'), pubkeyBytes(c.mint)])), rw(c.buybackRecipient)] : [];
const disc = (d) => Uint8Array.from(d);
/** Spend exactly `spendSol` lamports (fees included), receive at least `minTokensOut`. OptionBool arguments are sent as false (no volume tracking, no partial fill). */
export function buyExactSolIn(c, spendSol, minTokensOut) {
    const a = pumpAddresses(c.mint, c.curve.creator, c.tokenProgram);
    return { program: PUMP_PROGRAM, data: cat(disc(DISC.buyExactSolIn), u64le(spendSol), u64le(minTokensOut), Uint8Array.of(0)),
        keys: [ro(a.global), rw(c.feeRecipient), ro(c.mint), rw(a.bondingCurve), rw(a.associatedBondingCurve), rw(ataAddress2(c.user, c.mint, c.tokenProgram)), { pubkey: c.user, signer: true, writable: true },
            ro(PROGRAMS.system), ro(c.tokenProgram), rw(a.creatorVault), ro(a.eventAuthority), ro(PUMP_PROGRAM), ro(a.globalVolumeAccumulator), rw(a.userVolumeAccumulator(c.user)), ro(a.feeConfig), ro(PUMP_FEE_PROGRAM), ...tail(c)] };
}
/** Buy exactly `tokens` for at most `maxSolCost` lamports (fees included). This is the instruction real pump.fun traffic uses today (data: discriminator, u64, u64, OptionBool as one byte; 18 accounts including the two trailing ones), and it is the one the local-validator run accepts: `buy_exact_sol_in` was rejected there with BuyZeroAmount for reasons not found, so it is kept but unused. */
export function buy(c, tokens, maxSolCost) {
    const a = pumpAddresses(c.mint, c.curve.creator, c.tokenProgram);
    return { program: PUMP_PROGRAM, data: cat(disc(DISC.buy), u64le(tokens), u64le(maxSolCost), Uint8Array.of(0)),
        keys: [ro(a.global), rw(c.feeRecipient), ro(c.mint), rw(a.bondingCurve), rw(a.associatedBondingCurve), rw(ataAddress2(c.user, c.mint, c.tokenProgram)), { pubkey: c.user, signer: true, writable: true },
            ro(PROGRAMS.system), ro(c.tokenProgram), rw(a.creatorVault), ro(a.eventAuthority), ro(PUMP_PROGRAM), ro(a.globalVolumeAccumulator), rw(a.userVolumeAccumulator(c.user)), ro(a.feeConfig), ro(PUMP_FEE_PROGRAM), ...tail(c)] };
}
/** Sell exactly `tokens`, receive at least `minSolOut` lamports. */
export function sell(c, tokens, minSolOut) {
    const a = pumpAddresses(c.mint, c.curve.creator, c.tokenProgram);
    return { program: PUMP_PROGRAM, data: cat(disc(DISC.sell), u64le(tokens), u64le(minSolOut)),
        keys: [ro(a.global), rw(c.feeRecipient), ro(c.mint), rw(a.bondingCurve), rw(a.associatedBondingCurve), rw(ataAddress2(c.user, c.mint, c.tokenProgram)), { pubkey: c.user, signer: true, writable: true },
            ro(PROGRAMS.system), rw(a.creatorVault), ro(c.tokenProgram), ro(a.eventAuthority), ro(PUMP_PROGRAM), ro(a.feeConfig), ro(PUMP_FEE_PROGRAM), ...tail(c)] };
}
/** Engine venue for one pump.fun curve. Token ids are the mint address; 'NATIVE' is SOL (a curve trades SOL directly, no wrapped SOL). */
export class PumpVenue {
    id;
    mint;
    tokenProgram;
    curve;
    global;
    tradableReason;
    slot;
    fees;
    kind = 'curve';
    family = 'pump';
    successor;
    status;
    constructor(id, mint, tokenProgram, curve, global, tradableReason, slot = 0, fees) {
        this.id = id;
        this.mint = mint;
        this.tokenProgram = tokenProgram;
        this.curve = curve;
        this.global = global;
        this.tradableReason = tradableReason;
        this.slot = slot;
        this.fees = fees;
        this.status = curve.complete ? 'graduated' : 'active';
    }
    get totalFeeBps() { if (!this.fees)
        return this.global.feeBps + this.global.creatorFeeBps; const c = this.curve; return feeBpsAt(this.fees, c.virtualToken > 0n ? c.virtualSol * c.totalSupply / c.virtualToken : 0n); }
    get tradable() { return !this.tradableReason && !this.curve.complete; }
    supports(a, b) { return this.tradable && ((a === 'NATIVE' && b === this.mint) || (a === this.mint && b === 'NATIVE')); }
    buying(a, b) { if (!this.supports(a, b))
        throw new Error('unsupported pair'); return a === 'NATIVE'; }
    quote(a, b, amt) {
        const c = this.curve, buy = this.buying(a, b);
        const out = buy ? quoteBuy(amt, c, this.totalFeeBps).tokens : quoteSell(amt, c, this.totalFeeBps).net;
        const spot = buy ? amt * c.virtualToken / c.virtualSol : amt * c.virtualSol / c.virtualToken;
        const impact = spot === 0n ? 0 : Math.max(0, Number((spot - out) * BPS / spot));
        return { venue: this.id, family: this.family, amountOut: out, priceImpactBps: impact, venueFee: buy ? amt - amt * BPS / (BPS + this.totalFeeBps) : quoteSell(amt, c, this.totalFeeBps).fee, liquidity: c.realSol };
    }
    spotPriceE18(a, b) { const buy = this.buying(a, b), c = this.curve; return buy ? c.virtualToken * 10n ** 18n / c.virtualSol : c.virtualSol * 10n ** 18n / c.virtualToken; }
    swap(a, b, amt) {
        const buy = this.buying(a, b), c = this.curve;
        if (buy) {
            const q = quoteBuy(amt, c, this.totalFeeBps);
            c.virtualSol += q.net;
            c.realSol += q.net;
            c.virtualToken -= q.tokens;
            c.realToken -= q.tokens;
            return { amountOut: q.tokens, venueFee: q.fee };
        }
        const q = quoteSell(amt, c, this.totalFeeBps);
        c.virtualSol -= q.gross;
        c.realSol -= q.gross > c.realSol ? c.realSol : q.gross;
        c.virtualToken += amt;
        c.realToken += amt;
        return { amountOut: q.net, venueFee: q.fee };
    }
    clone() { return new PumpVenue(this.id, this.mint, this.tokenProgram, { ...this.curve }, this.global, this.tradableReason, this.slot); }
}
/** Why this curve cannot be traded by us, or undefined when it can. */
export function untradableReason(curve, mintOwner) {
    if (curve.complete)
        return 'the curve is complete: liquidity has moved to PumpSwap, which this adapter does not trade';
    if (curve.mayhem)
        return 'mayhem-mode coin: its instructions need accounts this adapter has not verified';
    if (curve.cashback)
        return 'cashback coin: selling needs extra accounts this adapter has not verified';
    if (mintOwner !== PROGRAMS.token && mintOwner !== TOKEN_2022)
        return `mint is owned by ${mintOwner}, not the SPL Token or Token-2022 program`;
    if (curve.mayhem === undefined || curve.cashback === undefined)
        return 'older curve layout without the mayhem and cashback flags: not verified';
    return undefined;
}
