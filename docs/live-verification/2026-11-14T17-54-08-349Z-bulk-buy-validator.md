# Bulk buy (multi-wallet) on a local Solana validator

Run: 2026-11-14T17:54:08.349Z
Node: local solana-test-validator (http://127.0.0.1:8914) with Raydium AMM v4 and the mainnet SOL/USDC pool cloned. Throwaway keys, fake SOL.

What this shows: one BulkRunner request buys the same token from several wallets. Each leg is an ordinary Engine intent from its own wallet with its own policy and idempotency key. Default mode is sequential: each leg is quoted on the pool as the earlier legs left it.

## Observed
- validator cloned Raydium AMM v4 + SOL/USDC pool from mainnet (reserves 109234060627416 lamports / 7960486764759 micro-USDC); 5 funded wallets and 1 nearly empty wallet, all throwaway keys, fake SOL

## Checks
| Check | Result | Detail |
|---|---|---|
| B1 five wallets each bought through the engine and finalized; the sixth, which could not fund its leg, was skipped with a reason and nothing was sent for it | pass | [["filled",null],["filled",null],["filled",null],["filled",null],["filled",null],["skipped","balance 10000000 is below the 5000000000"]] |
| B2 each wallet holds exactly the USDC its own engine record says it received, and the summary adds up | pass | balances 726866734,1090051000,1452936502,1815423956,2177414352 |
| B3 each wallet's SOL fell by its leg plus the network fee and nothing else (no wrapped-SOL leftovers) | pass |  |
| B4 legs ran one after another on the pool as the earlier legs left it: the USDC per SOL fell with every leg (price moved up) | pass | 0.07268667 > 0.07267007 > 0.07264683 > 0.07261696 > 0.07258048 |
| B5 restarting from the saved bulk state and running it again buys nothing more | pass |  |
| B6 a total that would move the pool more than the 1 bp limit is refused for every leg, with the measured impact in the reason, and nothing is sent | pass | buying the total would move the price 34 bps, above the 1 bps limit |
| B7 a leg above its wallet's own per-transaction limit failed alone with the policy reason; the other two wallets bought | pass | [["filled",null],["failed","signer policy: exceeds per-tx limit"],["filled",null]] |

## Not covered
- NOT atomic: legs are independent transactions. Any can fail while others land; the summary lists each leg.
- Parallel mode (all legs at once) was shown to fail later legs by design in the simulated-chain unit tests, not on this validator.
- One pool, one token, one chain, our own throwaway wallets. No wallet creation or management: the caller supplies existing wallet ids.
- Sequential legs are slower: each waits for the previous one to settle. Not suitable where every leg must land in the same block.
