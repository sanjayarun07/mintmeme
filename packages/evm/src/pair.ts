import { bytesToHex, hexToBytes, keccak256 } from './keccak.ts';
import { normAddr } from './abi.ts';

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** Generic EIP-1014 CREATE2 address. */
export function create2(deployer: string, salt: string, initCodeHash: string): string {
  const h = keccak256(cat(Uint8Array.of(0xff), hexToBytes(normAddr(deployer)), hexToBytes(salt), hexToBytes(initCodeHash)));
  return bytesToHex(h.slice(12));
}

export function sortTokens(a: string, b: string): [string, string] {
  const x = normAddr(a), y = normAddr(b);
  if (x === y) throw new Error('identical tokens');
  return x < y ? [x, y] : [y, x];
}

/** Uniswap-V2-style pair: salt = keccak256(token0 ++ token1). factory/initCodeHash are injected per deployment. */
export function pairAddress(factory: string, initCodeHash: string, tokenA: string, tokenB: string): string {
  const [t0, t1] = sortTokens(tokenA, tokenB);
  const salt = bytesToHex(keccak256(cat(hexToBytes(t0), hexToBytes(t1))));
  return create2(factory, salt, initCodeHash);
}
