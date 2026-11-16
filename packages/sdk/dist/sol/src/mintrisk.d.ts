/** Pre-trade risk check for a Solana launch, from the token's MINT account (read-only). Solana has two honeypot mechanisms an EVM-style simulation does not show:
 *   - a FREEZE authority can freeze the buyer's token account so it can never sell  -> verdict `blocked`
 *   - a MINT authority can print unlimited supply                                    -> flag, verdict `warn`
 *  Token-2022 mints (extensions such as transfer fees, transfer hooks, permanent delegate) are not understood by our swap builder: `quarantined`.
 *  It does NOT simulate a sell, read holder concentration, or check LP burn/lock; the report says so. A passing check is not a safety certification. */
import type { Launch, RiskReport } from '../../core/src/index.ts';
import type { SolRpc } from './raydium.ts';
export interface MintFacts {
    mint: string;
    mintAuthority?: string;
    freezeAuthority?: string;
    supply: bigint;
    decimals: number;
    token2022: boolean;
}
export declare function decodeMint(owner: string, data: Buffer, mint: string): MintFacts;
export declare class MintInspector {
    private rpc;
    private now;
    facts: Map<string, MintFacts>;
    constructor(rpc: SolRpc, now?: () => number);
    inspect(mint: string): Promise<MintFacts>;
    /** Synchronous check for SnipeConfig.riskCheck. Call `inspect` first (SnipeRunner's `inspect` hook does): an un-inspected mint is quarantined, never assumed safe. */
    riskCheck: (launch: Pick<Launch, 'token'>, block: number) => RiskReport;
}
