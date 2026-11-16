/** Minimal RESP2 encoder/decoder (enough for Redis commands: strings, integers, nulls, arrays, errors). No dependencies. */
export declare class RespError extends Error {
}
export type RespValue = string | number | null | RespError | RespValue[];
export declare function encodeCommand(args: (string | number)[]): Buffer;
/** Incremental: push() chunks, then next() until it returns undefined (value incomplete). */
export declare class RespParser {
    private buf;
    push(c: Buffer): void;
    next(): {
        value: RespValue;
    } | undefined;
}
