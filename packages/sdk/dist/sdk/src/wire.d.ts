/** Wire format shared by the HTTP API and the client: amounts and prices are DECIMAL STRINGS of raw base units (wei, lamports, token units), never JSON numbers,
 *  because a JSON number silently loses precision above 2^53. Everything below turns untrusted input into exact bigints or refuses it with a message that says what to send instead. */
export declare class SdkError extends Error {
    code: string;
    fix?: string | undefined;
    status: number;
    constructor(code: string, message: string, fix?: string | undefined, status?: number);
    toJSON(): {
        code: string;
        message: string;
        fix: string | undefined;
    };
}
/** Raw base units. Accepts a bigint, a string of digits, or a safe whole number; refuses decimals, negatives, hex, exponents and unsafe numbers. */
export declare function amount(v: unknown, name: string, opts?: {
    allowZero?: boolean;
}): bigint;
export declare function int(v: unknown, name: string, min: number, max: number): number;
export declare function str(v: unknown, name: string, re?: RegExp): string;
/** Ids end up in file names (persistence) and keys: letters, digits, dot, dash, underscore, colon only. No path separators, ever. */
export declare const ID_RE: RegExp;
export declare const id: (v: unknown, name?: string) => string;
/** "1.5" with 18 decimals -> 1500000000000000000n. Refuses more fractional digits than the token has (no silent rounding). */
export declare function parseUnits(v: string, decimals: number): bigint;
export declare function formatUnits(raw: bigint, decimals: number): string;
/** Price as quote-units-per-token, x1e18 (the engine's price unit). `price` is in WHOLE quote per WHOLE token; the decimals convert between raw units. */
export declare function priceE18(price: string, quoteDecimals: number, tokenDecimals: number): bigint;
/** JSON with bigint as decimal strings. */
export declare const toJson: (v: unknown) => string;
export declare const plain: <T>(v: T) => unknown;
