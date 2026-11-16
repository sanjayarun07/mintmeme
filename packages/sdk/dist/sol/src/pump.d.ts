/** pump.fun bonding curve: account layouts, quote maths, program-derived addresses and the buy / sell instructions, plus a `Venue` for the engine.
 *  Sources: pump-fun/pump-public-docs (idl/pump.json and docs/PUMP_PROGRAM_README.md). Instructions used: `buy_exact_sol_in` (spend an exact SOL budget, get at least `min_tokens_out`)
 *  and `sell` (sell an exact token amount, get at least `min_sol_output`). Both take the same fixed account list as the IDL. Layout offsets below are cross-checked against the account
 *  discriminators at decode time; anything that does not match is refused, never guessed.
 *  NOT supported (the venue reports itself as not tradable, with the reason): curves that are complete (liquidity moved to PumpSwap), "mayhem" coins and "cashback" coins
 *  (their instructions need extra accounts we have not verified), and curves whose account layout we do not recognise. */
import type { Venue, Quote } from '../../core/src/index.ts';
import type { Ix } from './tx.ts';
export declare const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export declare const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export declare const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export declare const DISC: {
    readonly buy: readonly [102, 6, 61, 18, 1, 218, 235, 234];
    readonly buyExactSolIn: readonly [56, 252, 116, 8, 158, 223, 205, 95];
    readonly sell: readonly [51, 230, 133, 164, 1, 127, 131, 173];
    readonly curve: readonly [23, 183, 248, 55, 96, 216, 172, 96];
    readonly global: readonly [167, 232, 232, 177, 200, 108, 114, 127];
};
export interface CurveState {
    virtualToken: bigint;
    virtualSol: bigint;
    realToken: bigint;
    realSol: bigint;
    totalSupply: bigint;
    complete: boolean;
    creator: string;
    mayhem?: boolean;
    cashback?: boolean;
    size: number;
}
/** BondingCurve: 8-byte discriminator, then u64 x5 (virtual token, virtual sol, real token, real sol, total supply), bool complete, pubkey creator, bool mayhem, bool cashback (the last two exist on newer accounts). */
export declare function decodeCurve(d: Buffer): CurveState;
export interface GlobalState {
    feeBps: bigint;
    creatorFeeBps: bigint;
    feeRecipient: string;
    feeRecipients: string[];
    buybackRecipients: string[];
}
/** Global: discriminator, bool initialized, pubkey authority, pubkey fee_recipient, 4 x u64 reserves, u64 fee_basis_points, pubkey withdraw_authority, bool, u64 pool_migration_fee, u64 creator_fee_basis_points, 7 x pubkey fee_recipients. */
export declare function decodeGlobal(d: Buffer): GlobalState;
export interface FeeSet {
    lp: bigint;
    protocol: bigint;
    creator: bigint;
}
export interface FeeConfig {
    flat: FeeSet;
    tiers: {
        marketCap: bigint;
        fees: FeeSet;
    }[];
}
/** fee_config (owned by the fee program): flat fees at byte 41 (lp, protocol, creator as u64 bps), then a u32 count at 65 and that many 40-byte tiers (u128 market-cap threshold in lamports, then lp, protocol, creator).
 *  Layout worked out from one live account and checked against the program's own GetFeesWithQuoteMint return (0 / 95 / 30 bps); anything implausible is refused rather than guessed. */
export declare function decodeFeeConfig(d: Buffer): FeeConfig;
/** Fee bps for a curve at a market cap: the tier with the largest threshold not above it, else the flat fees. */
export declare function feeBpsAt(c: FeeConfig, marketCapLamports: bigint): bigint;
export interface PumpAddresses {
    global: string;
    bondingCurve: string;
    associatedBondingCurve: string;
    creatorVault: string;
    eventAuthority: string;
    globalVolumeAccumulator: string;
    userVolumeAccumulator: (user: string) => string;
    feeConfig: string;
}
export declare function pumpAddresses(mint: string, creator: string, tokenProgram: string): PumpAddresses;
/** Associated token account for any token program (the shared helper in tx.ts is fixed to the classic token program). */
export declare const ataAddress2: (owner: string, mint: string, tokenProgram: string) => string;
export declare const createAtaIdempotent2: (payer: string, owner: string, mint: string, tokenProgram: string) => Ix;
/** Tokens received for a SOL budget (fees are taken out of the budget): net = floor(budget x 10000 / (10000 + fee bps)); tokens = floor((net - 1) x virtual token / (virtual sol + net - 1)). Formula from the IDL's own docs. */
export declare function quoteBuy(budget: bigint, c: Pick<CurveState, 'virtualToken' | 'virtualSol' | 'realToken'>, totalFeeBps: bigint): {
    tokens: bigint;
    net: bigint;
    fee: bigint;
};
/** SOL received for selling `tokens`: gross = floor(tokens x virtual sol / (virtual token + tokens)); the fee is taken from it. */
export declare function quoteSell(tokens: bigint, c: Pick<CurveState, 'virtualToken' | 'virtualSol'>, totalFeeBps: bigint): {
    gross: bigint;
    fee: bigint;
    net: bigint;
};
export interface PumpCtx {
    user: string;
    mint: string;
    tokenProgram: string;
    curve: CurveState;
    feeRecipient: string;
    buybackRecipient?: string;
}
/** Spend exactly `spendSol` lamports (fees included), receive at least `minTokensOut`. OptionBool arguments are sent as false (no volume tracking, no partial fill). */
export declare function buyExactSolIn(c: PumpCtx, spendSol: bigint, minTokensOut: bigint): Ix;
/** Buy exactly `tokens` for at most `maxSolCost` lamports (fees included). This is the instruction real pump.fun traffic uses today (data: discriminator, u64, u64, OptionBool as one byte; 18 accounts including the two trailing ones), and it is the one the local-validator run accepts: `buy_exact_sol_in` was rejected there with BuyZeroAmount for reasons not found, so it is kept but unused. */
export declare function buy(c: PumpCtx, tokens: bigint, maxSolCost: bigint): Ix;
/** Sell exactly `tokens`, receive at least `minSolOut` lamports. */
export declare function sell(c: PumpCtx, tokens: bigint, minSolOut: bigint): Ix;
/** Engine venue for one pump.fun curve. Token ids are the mint address; 'NATIVE' is SOL (a curve trades SOL directly, no wrapped SOL). */
export declare class PumpVenue implements Venue {
    id: string;
    mint: string;
    tokenProgram: string;
    curve: CurveState;
    global: GlobalState;
    tradableReason?: string | undefined;
    slot: number;
    fees?: FeeConfig | undefined;
    kind: 'curve';
    family: string;
    successor?: string;
    status: 'active' | 'graduated';
    constructor(id: string, mint: string, tokenProgram: string, curve: CurveState, global: GlobalState, tradableReason?: string | undefined, slot?: number, fees?: FeeConfig | undefined);
    get totalFeeBps(): bigint;
    get tradable(): boolean;
    supports(a: string, b: string): boolean;
    private buying;
    quote(a: string, b: string, amt: bigint): Omit<Quote, 'block' | 'source'>;
    spotPriceE18(a: string, b: string): bigint;
    swap(a: string, b: string, amt: bigint): {
        amountOut: bigint;
        venueFee: bigint;
    };
    clone(): PumpVenue;
}
/** Why this curve cannot be traded by us, or undefined when it can. */
export declare function untradableReason(curve: CurveState, mintOwner: string): string | undefined;
