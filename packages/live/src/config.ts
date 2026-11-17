/** Mainnet RPC endpoint for the Solana test UI and the local-validator fork test. Fetched from Alchemy's docs on 2026-11-13. The key is never logged: callers redact it.
 *  The Ethereum and BNB settings that lived here served harnesses removed in the 2026-11-17 cleanup (tag v0.1.0-full-platform). */
export const urls = (key: string) => ({ sol: `https://solana-mainnet.g.alchemy.com/v2/${key}` });
