export declare function sponge256(data: Uint8Array, pad: number): Uint8Array;
export declare const keccak256: (data: Uint8Array) => Uint8Array;
export declare function hexToBytes(h: string): Uint8Array;
export declare const bytesToHex: (b: Uint8Array) => string;
export declare const keccakHex: (data: Uint8Array | string) => string;
/** 4-byte selector, e.g. selector('transfer(address,uint256)') = 0xa9059cbb */
export declare const selector: (sig: string) => string;
