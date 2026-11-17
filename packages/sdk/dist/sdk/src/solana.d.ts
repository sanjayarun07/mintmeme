import type { Backend } from '../../core/src/index.ts';
import { SolanaChain, PrivyApi } from '../../sol/src/index.ts';
import type { PrivyConfig, PriorityConfig } from '../../sol/src/index.ts';
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
