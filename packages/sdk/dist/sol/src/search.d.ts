export interface TokenHit {
    mint: string;
    symbol: string;
    name: string;
    decimals?: number;
    tokenProgram?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    marketCapUsd?: number;
    volume24hUsd?: number;
    holders?: number;
    pairs: {
        dex: string;
        pair: string;
        liquidityUsd?: number;
    }[];
    sources: string[];
    pumpLike: boolean;
}
export declare const JUPITER_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search", DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search", DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/tokens/v1/solana";
export declare const looksLikeMint: (s: string) => boolean;
export interface SearchOptions {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    limit?: number;
}
/** Search by free text or by mint. Results are merged by mint and ordered by liquidity. A source that fails is skipped and named in `errors`. */
export declare function searchSolTokens(query: string, o?: SearchOptions): Promise<{
    hits: TokenHit[];
    errors: string[];
}>;
export interface MintSearchFacts {
    mint: string;
    exists: boolean;
    tokenProgram?: string;
    decimals?: number;
    supply?: bigint;
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    warnings: string[];
}
/** On-chain facts for a mint, read with getAccountInfo (SPL and Token-2022 layouts: supply at 36, decimals at 44, authorities as optional keys). Warnings are plain statements, not a safety verdict. */
export declare function mintFacts(rpc: {
    call<T = any>(m: string, p?: unknown[]): Promise<T>;
}, mint: string): Promise<MintSearchFacts>;
