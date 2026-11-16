/** Generic EIP-1014 CREATE2 address. */
export declare function create2(deployer: string, salt: string, initCodeHash: string): string;
export declare function sortTokens(a: string, b: string): [string, string];
/** Uniswap-V2-style pair: salt = keccak256(token0 ++ token1). factory/initCodeHash are injected per deployment. */
export declare function pairAddress(factory: string, initCodeHash: string, tokenA: string, tokenB: string): string;
