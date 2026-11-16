# Live read-only verification, 2026-11-13

Provider: Alchemy (JSON-RPC, read-only methods only). Address sources fetched 2026-11-13 from official pages (see packages/live/src/config.ts). A pass here means "readable and consistent on mainnet at that block", not "safe to trade".

## Ethereum mainnet (block 26406036, 11 RPC calls)

| Result | Check | Detail |
|---|---|---|
| PASS | eth.chainId | node reports chain id 1 |
| PASS | eth.block | all reads below are pinned to block 26406036 |
| PASS | eth.code.factory | contract code present at 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f (13859 bytes) |
| PASS | eth.code.router | contract code present at 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D (21943 bytes) |
| PASS | eth.code.usdc | contract code present at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (2186 bytes) |
| PASS | eth.router.factory | router.factory() equals the configured factory |
| PASS | eth.router.weth | WETH from official router: 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 |
| PASS | eth.pair | WETH/USDC pair 0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc |
| PASS | eth.reserves | reserves 8992563933784 / 4594139464859758128306 (token0 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) |
| PASS | eth.quote.matches-router | our getAmountOut equals the router's for 1 WETH at block 26406036: 1951103369 USDC units |
| SKIPPED | eth.unconfigured | Uniswap V2 pair init code hash (not on the official deployments page; pairs are read via factory.getPair instead) |

## Ethereum swap dry-run (eth_call simulation, nothing sent) (block 26406036, 14 RPC calls)

| Result | Check | Detail |
|---|---|---|
| PASS | dry.sender-is-eoa | simulated sender 0x1234567890123456789012345678901234567890 has no code (balance is an override, no key exists) |
| PASS | dry.swap.eth-for-usdc | 0.1 ETH -> 195148443 USDC units; matches our math exactly at block 26406036 |
| PASS | dry.minout.exact | amountOutMin equal to the quote is accepted (boundary) |
| PASS | dry.minout.guard | amountOutMin one unit above the quote: reverted with "INSUFFICIENT_OUTPUT_AMOUNT" as expected |
| PASS | dry.deadline.expired | deadline in the past: reverted with "EXPIRED" as expected |
| PASS | dry.fee-on-transfer.variant | SupportingFeeOnTransferTokens variant executes without revert (returns no data, as designed) |
| PASS | dry.gas | estimated gas 138597 (plausible range 60k-400k for a single-hop V2 swap) |
| PASS | dry.approval.plan | fresh sender has allowance 0; plan is one approve for exactly the amount; unlimited approval is refused |
| SKIPPED | dry.sell-leg | USDC -> ETH needs a token balance override, which depends on the token storage layout (not verified). Selling is covered by fork tests later. |

