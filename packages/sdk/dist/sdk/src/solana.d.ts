import type { Backend } from '../../core/src/index.ts';
import { SolanaChain, PrivyApi, JitoSubmitter } from '../../sol/src/index.ts';
import type { PrivyConfig, PriorityConfig, JitoOptions, SafetyReport, FeeRecipient } from '../../sol/src/index.ts';
import { Trader } from './trader.ts';
export declare const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Defaults: at most 0.05 SOL per buy and 0.25 SOL of buys per day. Lower them per user if you like; the Privy policy caps SOL transfers separately. */
export declare const SOLANA_DEFAULT_CAPS: {
    maxTradeLamports: bigint;
    dailyCapLamports: bigint;
};
export interface SolanaTraderOptions {
    userId: string;
    /** The user's Privy Solana wallet address (the walletId used in every call). Undefined: a read-only account that refuses trades until a wallet is linked. */
    address?: string;
    rpcUrl: string;
    privy: PrivyConfig | PrivyApi;
    persistDir?: string;
    state?: (name: string) => Backend;
    caps?: {
        maxTradeLamports: bigint;
        dailyCapLamports: bigint;
    };
    venues?: string[];
    /** SOL/USD for USD triggers. Default: a read-only Jupiter quote of 1 SOL into USDC, cached 30 s. */
    solUsd?: () => Promise<{
        price: number;
        at: number;
    } | null>;
    /** The Privy wallet id you saved when the user linked (checked against Privy). Optional. */
    walletId?: string;
    /** Priority fees (packages/sol/src/priorityfee.ts). Default on: 75th percentile of recent fees on the trade's accounts, at most 0.0001 SOL per transaction. false: off. */
    priority?: PriorityConfig | false;
    /** Token safety before buys (packages/sol/src/tokensafety.ts): 'block' (default) refuses tokens you might not be able to sell, 'warn' only reports, 'off' skips. */
    tokenSafety?: 'block' | 'warn' | 'off';
    /** Fee sharing: who receives a fee on each trade and how much (bps of the trade, paid in SOL inside the trade's own transaction). Read at every trade. The user's
     *  `maxFeeBps` on a trade (default 2%) still caps the total: a trade whose fees are above it fails before anything is signed. */
    fees?: () => FeeRecipient[];
    /** MEV protection (off by default): send every trade privately through Jito with a tip from the live tip floor (75th percentile, at most `maxTipLamports`, default
     *  0.0001 SOL), revert protection and the jitodontfront sandwich flag (packages/sol/src/submitter.ts). `jito` passes block-engine options (region URL, uuid, tests). */
    mevProtection?: boolean | MevOptions;
    log?: (m: string) => void;
}
export interface SolanaTrader {
    trader: Trader;
    chain: SolanaChain;
    active: boolean;
    why?: string;
    prepare: (token: string) => Promise<void>;
    sync: () => Promise<void>;
    refuseIfInactive: () => void;
    /** Token safety report (cached 60 s). */ safety: (mint: string) => Promise<SafetyReport>;
    /** Run before a buy: throws `unsafe_token` (409) for a blocked token unless `allowRisky` or tokenSafety is warn/off; returns the report. */ checkBuy: (mint: string, allowRisky?: boolean) => Promise<SafetyReport | undefined>;
    /** Plain units for one API call (see `simpleBody`): returns the body the Trader understands. */
    simple: (path: string, body: any) => Promise<any>;
}
/** Decimal string to integer units ("0.01" SOL, 9 decimals -> 10000000n). Refuses exponents, negatives and more decimals than the unit has. */
export declare function toUnits(v: unknown, decimals: number, what: string): bigint;
/** PLAIN UNITS, the way Jupiter's API reads: `mint` for the token, `sol` for SOL amounts, `tokens` or `pct` for what to sell, `price` in SOL per token or `priceUsd`,
 *  `slippagePct`, `trailPct`, `tpUsd` / `slUsd`; the wallet defaults to the linked one. Raw fields (`token`, `amount`, `priceE18`, `slippageBps`, ...) still work and win.
 *  `pct` on a sell order is taken from the wallet's balance now. Returns a new body; the input is not changed. */
export declare function simpleBody(path: string, b: any, o: {
    address?: string;
    decimals: (mint: string) => Promise<number>;
    balance: (mint: string) => Promise<bigint>;
}): Promise<any>;
/** A shared SOL/USD source (one cache for many Traders). */
export declare function jupiterSolUsd(ttlMs?: number): () => Promise<{
    price: number;
    at: number;
} | null>;
export declare function createSolanaTrader(o: SolanaTraderOptions): Promise<SolanaTrader>;
/** MEV protection options. `enabled` (default true when you pass an object) is the account default; a trade's own `mevProtection` wins either way. The block-engine
 *  settings apply whenever a trade goes privately, also when the default is off. */
export interface MevOptions {
    enabled?: boolean;
    maxTipLamports?: bigint;
    tipPercentile?: 25 | 50 | 75 | 95 | 99;
    jito?: JitoOptions;
}
export declare const mevOn: (m: boolean | MevOptions | undefined) => boolean;
/** The Jito submitter for a `mevProtection` setting (always built, so a single trade can ask for private sending). */
export declare function mevSubmitter(m: boolean | MevOptions): JitoSubmitter;
