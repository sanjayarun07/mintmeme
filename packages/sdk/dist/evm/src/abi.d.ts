/** Minimal ABI coder: address, bool, uintN, bytes32, address[] / uint256[]. */
export type AbiValue = string | bigint | boolean | (string | bigint)[];
export declare function isAddress(a: string): boolean;
export declare const normAddr: (a: string) => string;
export declare function encodeParams(types: string[], values: AbiValue[]): string;
export declare function encodeCall(sig: string, values: AbiValue[]): string;
export declare function decodeParams(types: string[], data: string | Uint8Array): AbiValue[];
