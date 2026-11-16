/** Wire format shared by the HTTP API and the client: amounts and prices are DECIMAL STRINGS of raw base units (wei, lamports, token units), never JSON numbers,
 *  because a JSON number silently loses precision above 2^53. Everything below turns untrusted input into exact bigints or refuses it with a message that says what to send instead. */
export class SdkError extends Error {
    code;
    fix;
    status;
    constructor(code, message, fix, status = 400) {
        super(message);
        this.code = code;
        this.fix = fix;
        this.status = status;
    }
    toJSON() { return { code: this.code, message: this.message, fix: this.fix }; }
}
/** Raw base units. Accepts a bigint, a string of digits, or a safe whole number; refuses decimals, negatives, hex, exponents and unsafe numbers. */
export function amount(v, name, opts = {}) {
    let r;
    if (typeof v === 'bigint')
        r = v;
    else if (typeof v === 'string' && /^[0-9]{1,78}$/.test(v))
        r = BigInt(v);
    else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
        r = BigInt(v);
    if (r === undefined)
        throw new SdkError('bad_amount', `${name} must be a whole number of raw base units, sent as a string of digits (got ${describe(v)})`, `Send "${name}": "1000000000000000000" (1e18 raw units = 1 token with 18 decimals). Use parseUnits("1.5", 18) in the SDK.`);
    if (r <= 0n && !opts.allowZero)
        throw new SdkError('bad_amount', `${name} must be greater than zero`);
    return r;
}
export function int(v, name, min, max) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
        throw new SdkError('bad_number', `${name} must be a whole number from ${min} to ${max} (got ${describe(v)})`);
    return v;
}
export function str(v, name, re = /^[^\s]{1,128}$/) {
    if (typeof v !== 'string' || !re.test(v))
        throw new SdkError('bad_text', `${name} is missing or not valid (got ${describe(v)})`);
    return v;
}
/** Ids end up in file names (persistence) and keys: letters, digits, dot, dash, underscore, colon only. No path separators, ever. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const id = (v, name = 'id') => str(v, name, ID_RE);
const describe = (v) => v === undefined ? 'nothing' : typeof v === 'string' ? `"${v.slice(0, 24)}"` : typeof v === 'object' ? 'an object' : String(v).slice(0, 24);
/** "1.5" with 18 decimals -> 1500000000000000000n. Refuses more fractional digits than the token has (no silent rounding). */
export function parseUnits(v, decimals) {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
    if (!m)
        throw new SdkError('bad_amount', `"${v}" is not a decimal number`);
    const frac = m[2] ?? '';
    if (frac.length > decimals)
        throw new SdkError('bad_amount', `"${v}" has more than ${decimals} decimal places`);
    return BigInt(m[1] + frac.padEnd(decimals, '0'));
}
export function formatUnits(raw, decimals) {
    const d = 10n ** BigInt(decimals), w = raw / d, f = (raw % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return f ? `${w}.${f}` : `${w}`;
}
/** Price as quote-units-per-token, x1e18 (the engine's price unit). `price` is in WHOLE quote per WHOLE token; the decimals convert between raw units. */
export function priceE18(price, quoteDecimals, tokenDecimals) {
    const p = parseUnits(price, 18);
    return p * 10n ** BigInt(quoteDecimals) / 10n ** BigInt(tokenDecimals);
}
/** JSON with bigint as decimal strings. */
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x));
export const plain = (v) => JSON.parse(toJson(v));
