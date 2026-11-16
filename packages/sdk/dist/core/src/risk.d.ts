import type { SimChain, TokenBehavior } from './simchain.ts';
export interface TokenFacts {
    address: string;
    mintAuthority?: boolean;
    freezeAuthority?: boolean;
    owner?: string | null;
    upgradeable?: boolean;
    pausable?: boolean;
    blacklist?: boolean;
    rebasing?: boolean;
    topHoldersPct?: number;
    lpTopPct?: number;
    lpLockedPct?: number | null;
    knownMalicious?: boolean;
}
export interface RiskReport {
    token: string;
    generatedAt: number;
    block: number;
    verdict: 'blocked' | 'quarantined' | 'warn' | 'no-flags';
    flags: string[];
    buyTaxBps?: number;
    sellTaxBps?: number;
    notes: string[];
    disclaimer: string;
}
/** Simulation-backed risk report: buy then sell dry-runs through the chain; taxes measured from balance deltas. */
export declare function analyze(chain: SimChain, f: TokenFacts, probe: {
    wallet: string;
    quoteToken: string;
    venue: string;
    amount: bigint;
}): RiskReport;
export type { TokenBehavior };
