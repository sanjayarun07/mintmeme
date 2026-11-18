/** TOKEN SAFETY CHECK before a buy. Read-only: the mint account (decoded by the RPC, Token-2022 extensions by name), the largest holders, and whether a sell route exists.
 *  `block` risks mean you could be unable to sell or could lose the tokens; `warn` risks are reasons for care. It is not a safety certification: a token that passes
 *  can still go to zero (a team can sell, liquidity can be pulled), and holder shares can include pools and bonding curves (named where we know them). */
export interface SolRpcLike {
    call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
export type RiskLevel = 'block' | 'warn';
export interface SafetyRisk {
    code: string;
    level: RiskLevel;
    message: string;
}
export interface SafetyReport {
    mint: string;
    verdict: 'ok' | 'warn' | 'block';
    risks: SafetyRisk[];
    facts: {
        program: 'spl-token' | 'token-2022';
        decimals: number;
        supply: string;
        mintAuthority: string | null;
        freezeAuthority: string | null;
        extensions: string[];
        transferFeeBps: number | null;
        topHolderPct: number | null;
        top10Pct: number | null;
        excludedHolders: string[];
        sellRoute: boolean | null;
        buyImpactPct: number | null;
        /** Set when the mint is a known issued asset (an xStock) AND its on-chain authorities match the issuer's pinned keys: the issuer controls are then warnings, not blocks. */
        issuedAsset: {
            symbol: string;
            issuer: string;
        } | null;
    };
    checkedAt: string;
    disclaimer: string;
}
export interface SafetyOptions {
    /** Token accounts that hold supply for trading, not for a person (a bonding curve, a pool vault): left out of the holder shares and listed. */
    liquidityAccounts?: (mint: string) => Promise<string[]> | string[];
    /** Whether the token can be sold back to SOL right now (a pump.fun curve, a Jupiter route). Undefined: not checked. */
    sellRoute?: (mint: string, decimals: number, supply: bigint) => Promise<boolean | undefined>;
    /** Price impact in percent of buying 1 SOL of it now. Undefined: not checked. */
    buyImpactPct?: (mint: string) => Promise<number | undefined>;
    /** Thresholds: a single holder above `topHolderPct` or the top 10 above `top10Pct` (percent of supply) is a warning; impact above `maxImpactPct` too. */
    topHolderPct?: number;
    top10Pct?: number;
    maxImpactPct?: number;
    cacheMs?: number;
    now?: () => number;
    /** Known issued assets (tokenized stocks) whose issuer controls are expected: default STOCKS_SOLANA (xstocks.ts: xStocks, Ondo, Backpack). Pass [] to treat every mint the same. */
    issuedAssets?: readonly IssuedAsset[];
}
/** A REGULATED, ISSUER-CONTROLLED token (a tokenized stock): the issuer keeps freeze, pause and a permanent delegate on purpose (sanctions, court orders, corporate actions).
 *  The allowance applies only while the mint's authorities equal these pinned keys: a lookalike mint, or a change of keys, is checked like any other token. */
export interface IssuedAsset {
    mint: string;
    symbol: string;
    issuer: string; /** permanentDelegate null: the issuer keeps none, and one appearing breaks the pin. */
    keys: {
        freezeAuthority: string;
        permanentDelegate: string | null;
        pauseAuthority: string;
    };
}
export declare class TokenSafety {
    private rpc;
    private o;
    private cache;
    constructor(rpc: SolRpcLike, o?: SafetyOptions);
    check(mint: string): Promise<SafetyReport>;
}
