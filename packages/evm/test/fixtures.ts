// Deterministic recorded state. All addresses are SYNTHETIC placeholders, not real chain deployments.
import type { EthCall } from '../src/v2.ts';
import { pairCalls } from '../src/calldata.ts';

export const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
export const TOKEN0 = A(0x1001);     // sorts below TOKEN1
export const TOKEN1 = A(0x2002);
export const WRAPPED = TOKEN0;       // treat token0 as the wrapped native in this fixture
export const PAIR = A(0x9999);
export const OWNER = A(0xabc);
export const ROUTER = A(0xdddd);
export const FACTORY = A(0xfac7);
export const INIT_CODE_HASH = '0x' + '11'.repeat(32); // placeholder

const w = (n: bigint) => n.toString(16).padStart(64, '0');
export const RESERVES_HEX = '0x' + w(10_000n) + w(20_000n) + w(0x65n); // r0=10000 r1=20000 ts=0x65
export const RESERVES = { r0: 10_000n, r1: 20_000n };

/** Recorded eth_call responses keyed by `to:data`; any unrecorded call throws (no network). */
export function recordedCall(log: string[] = []): EthCall {
  const book = new Map<string, string>([
    [`${PAIR}:${pairCalls.token0(PAIR).data}`, '0x' + TOKEN0.slice(2).padStart(64, '0')],
    [`${PAIR}:0xd21220a7`, '0x' + TOKEN1.slice(2).padStart(64, '0')],
    [`${PAIR}:${pairCalls.getReserves(PAIR).data}`, RESERVES_HEX],
  ]);
  return async (req, block) => {
    const k = `${req.to}:${req.data}`;
    log.push(`${k}@${block}`);
    const v = book.get(k);
    if (!v) throw new Error(`unrecorded eth_call ${k}`);
    return v;
  };
}
