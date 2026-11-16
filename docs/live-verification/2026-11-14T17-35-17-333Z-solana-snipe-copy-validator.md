# Solana copy trading and sniping on a local validator

Run: 2026-11-14T17:35:17.333Z
Node: local solana-test-validator (http://127.0.0.1:8912) with the Raydium AMM v4 program, the mainnet SOL/USDC pool and its serum market cloned. Throwaway keys, fake SOL.

What this shows: the same CopyRunner and SnipeRunner that drive EVM drive Solana through SolanaChain. Copy: leader swaps are read from the leader's own transactions (balance changes), mirrored for a follower, restart-safe, sells mirror only what was attributed. Snipe: the Solana mint check refuses a freezable token by default; with an explicit opt-in it buys and places TP/SL exits.

## Observed
- validator cloned Raydium AMM v4 + SOL/USDC pool from mainnet; leader CN1g5rHg…, follower rrcAqki7… (throwaway keys, fake SOL)

## Checks
| Check | Result | Detail |
|---|---|---|
| C1 the leader's buy was detected from ITS OWN transaction over plain JSON-RPC: one swap event, buy, correct token, price from its balance changes | pass | [["swap","buy","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]] |
| C1 event amounts equal the leader's real balance change: tokens == its USDC balance, SOL spent == 2 SOL exactly (fee and account rent excluded) | pass | event 145589639/2000000000 balance 145589639 |
| C1 the follower mirrored it through the engine: finalized, origin copy, fixed 0.1 SOL, key tied to the leader signature | pass | finalized copy:f-rrcAqk:sol-local:FzhiDCyXCsADs3Jmfbikv3HmnACS4utyXfG99c22mDNGZKQXFaNhZzCg7mah4brVfv7pX9LRrZtgvKX6UuPMtRp:0 |
| C1 attribution == the follower's real USDC balance; cost basis == SOL spent | pass | attributed 7279342 balance 7279342 |
| C2 re-scanning with no new leader trade sends nothing | pass |  |
| C3 restarted from the two state files only: the earlier leader trade is not seen or copied again | pass |  |
| C4 the leader's full exit was detected as a sell with balance before > 0 and after == 0 | pass | ["sell","145589639","0"] |
| C4 the follower sold exactly its attributed tokens, finalized, and now holds none; attribution back to zero | pass | finalized sold 7279342 of 7279342 |
| C5 a leader buy of a blocked token is skipped with a recorded reason and nothing is sent | pass | ["skip: token filtered"] |
| N1 the Solana mint check read the real USDC mint: freeze authority set -> the buy is refused (a freezable token can trap the buyer), nothing sent | pass | status: risk: risk verdict blocked: freeze authority is set (7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar): the issuer can freeze your token account and stop you selling; mint authority is set (BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG): supply can be increased at will; sell was not simulated and holder concentration / LP lock were not checked |
| N1 the launch was handed to the chain: the pool was (re)registered through addPool with the configured program | pass |  |
| N2 with the explicit opt-in it bought through the engine: finalized, origin snipe, exactly maxSpend (0.5 SOL), tokens received == wallet balance | pass | finalized 36397239 vs 36397239 |
| N2 exits were placed on the real pool: a take-profit and a stop-loss sharing one OCO group, one reservation of the bought tokens | pass | take_profit,stop_loss reserved 36397239 |
| N3 the launch is done: later ticks buy nothing more (one attempt, budget and attempts respected) | pass |  |

## Not covered
- The launch event in the snipe checks is SYNTHETIC. Pool-creation detection is unit-tested and was checked read-only against real mainnet creation transactions in a separate step; a live pool creation was not reproduced here.
- Only Raydium AMM v4. Most new Solana memecoins launch on Pump.fun or other programs that this engine cannot execute against: copy of a leader trade there is skipped (no venue), and Pump.fun launches are not sniped.
- The mint check covers mint/freeze authority and Token-2022 only: no sell simulation, no holder concentration, no LP burn/lock check.
- Single-node validator: no forks, rollbacks or congestion; reorg handling is unit-tested with a scripted node, not exercised here.
- No bundles, no Jito tips, no private relay, no mempool access: the snipe acts only on MINED pool creations, so it is always after the creator.
