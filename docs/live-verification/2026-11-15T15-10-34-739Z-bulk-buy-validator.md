# Bulk buy and bulk sell (multi-wallet) on a local Solana validator

Run: 2026-11-15T15:10:34.739Z
Node: local solana-test-validator (http://127.0.0.1:8914) with Raydium AMM v4 and the mainnet SOL/USDC pool cloned. Throwaway keys, fake SOL.

What this shows: one BulkRunner request buys the same token from several wallets. Each leg is an ordinary Engine intent from its own wallet with its own policy and idempotency key. Default mode is sequential: each leg is quoted on the pool as the earlier legs left it.

## Observed
- validator cloned Raydium AMM v4 + SOL/USDC pool from mainnet (reserves 110410053468609 lamports / 7869064052763 micro-USDC); 5 funded wallets and 1 nearly empty wallet, all throwaway keys, fake SOL

## Checks
| Check | Result | Detail |
|---|---|---|
| B1 five wallets each bought through the engine and finalized; the sixth, which could not fund its leg, was skipped with a reason and nothing was sent for it | pass | [["filled",null],["filled",null],["filled",null],["filled",null],["filled",null],["skipped","balance 10000000 is below the 5000000000"]] |
| B2 each wallet holds exactly the USDC its own engine record says it received, and the summary adds up | pass | balances 710866633,1066058926,1420962140,1775480209,2129517325 |
| B3 each wallet's SOL fell by its leg plus the network fee and nothing else (no wrapped-SOL leftovers) | pass |  |
| B4 legs ran one after another on the pool as the earlier legs left it: the USDC per SOL fell with every leg (price moved up) | pass | 0.07108666 > 0.07107060 > 0.07104811 > 0.07101921 > 0.07098391 |
| B5 restarting from the saved bulk state and running it again buys nothing more | pass |  |
| B6 a total that would move the pool more than the 1 bp limit is refused for every leg, with the measured impact in the reason, and nothing is sent | pass | buying the total would move the price 33 bps, above the 1 bps limit |
| B7 a leg above its wallet's own per-transaction limit failed alone with the policy reason; the other two wallets bought | pass | [["filled",null],["failed","signer policy: exceeds per-tx limit"],["filled",null]] |
| B8 five wallets each sold half their USDC through the engine and finalized; the nearly empty wallet, which holds no USDC, was skipped with a reason and nothing was sent for it | pass | filled 5, skipped 1: balance 0 is below the 1000000 this leg needs |
| B9 each wallet gave up exactly its leg of USDC, and its SOL rose by the proceeds its own engine record reports (minus the network fee) | pass | sold 426396676, 603990257, 710481070, 887740104, 1064758662 |
| B10 sells ran one after another on the pool as the earlier legs left it: SOL per USDC fell with every leg (price moved down) | pass | 14021.410448 > 14019.575675 > 14017.235291 > 14014.390592 > 14010.916411 |
| B11 running the same sell id again sends nothing more and sells nothing more | pass |  |

## Not covered
- NOT atomic: legs are independent transactions. Any can fail while others land; the summary lists each leg.
- Parallel mode (all legs at once) was shown to fail later legs by design in the simulated-chain unit tests, not on this validator.
- One pool, one token, one chain, our own throwaway wallets. No wallet creation or management: the caller supplies existing wallet ids.
- Sequential legs are slower: each waits for the previous one to settle. Not suitable where every leg must land in the same block.
