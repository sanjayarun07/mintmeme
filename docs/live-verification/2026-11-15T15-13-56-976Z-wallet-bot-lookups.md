# Wallet Bot lookups: read-only live check

Run: 2026-11-15T15:13:56.975Z
Result: **PASS** (4/4 checks)

What this shows: the real lookups behind the Wallet Bot (balance by `eth_getBalance`, prices from DexScreener) return sensible values on Ethereum and BNB Smart Chain mainnet. Read-only, public addresses only, nothing signed or sent, nothing posted to Telegram.

## Observed
- wrapped-native contracts read on-chain from the official routers: Ethereum 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2, BSC 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c
- prices (DexScreener, third party): ETH 1806.38, BNB 588.32, USDC 1.00036
- public balances: Ethereum WETH contract holds 2114768.829726385 ETH; BSC WBNB contract holds 1565006.595807913 BNB

## Checks
| Check | Result | Detail |
|---|---|---|
| V1 ETH and BNB prices are sensible positive numbers from the deepest pool on the right chain | pass | ETH 1806.38, BNB 588.32 |
| V1 Arbitrum native price equals the Ethereum one (same coin), and USDC prices near one dollar | pass | ARB-ETH 1806.38, USDC 1.00036 |
| V2 native balances of public contract addresses are read from the real nodes as whole-coin numbers | pass | ETH 2114768.829726385, BNB 1565006.595807913 |
| V2 a chain with no node configured (Arbitrum) answers "unavailable" instead of guessing an endpoint | pass |  |

## Not covered
- Telegram itself: no bot token exists in this repo, so no message was sent or received.
- Arbitrum balances were not read from a real node (no endpoint is configured by default).
- Prices are a third party's numbers for the deepest pool, not an oracle; they can lag or be moved by a thin pool.
