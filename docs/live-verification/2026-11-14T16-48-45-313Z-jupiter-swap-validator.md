# Jupiter swap execution on a local validator (real routes cloned from mainnet)

Run: 2026-11-14T16:48:45.313Z
Node: local solana-test-validator (http://127.0.0.1:8899); mainnet only READ (accounts cloned through a loopback proxy). Throwaway ed25519 key, fake SOL. Jupiter Swap API V2 /build and quote were called live.

What this shows: our SolanaChain turns Jupiter's raw instructions into a v0 transaction (lookup tables read from the chain), gates every instruction against an allowlist, simulates and checks the wallet balances, signs and sends it to the local node under the Engine; fills come from balance deltas.

## Observed
- Jupiter /build (live mainnet) for 0.1 SOL -> USDC: out 7223472, min 7187355, route Raydium; for 3 USDC -> SOL: out 41323457, route Raydium
- cloned from mainnet: 6 accounts, 2 programs, 1 lookup tables (patched: last_extended_slot only); 2 route accounts do not exist on mainnet (created at run time, e.g. our token accounts)

## Checks
| Check | Result | Detail |
|---|---|---|
| S1 refresh loaded one Jupiter venue per direction from live quotes (Jupiter venue family, positive reference output) | pass | 2 venues |
| B1 SOL -> USDC through Jupiter and the Engine reached finalized | **FAIL** | unresolved "tx not found at node" |
| B2 the landed transaction is a versioned (v0) transaction that succeeded | **FAIL** | version undefined err undefined |
| B3 the fill is the real balance change: received == wallet USDC; spent == exactly 0.1 SOL | **FAIL** | received undefined balance 0 spent undefined |
| B4 wallet SOL fell by exactly spent + network fee (fee and token-account rent only) | **FAIL** | delta 0 fee undefined |
| B5 executed output vs Jupiter's mainnet quote taken minutes earlier: within 150 bps (a live quote vs a cloned pool, so not exact) | **FAIL** | jupiter 7223472 executed 0 (10000 bps) |
| B6 the executed output respected Jupiter's on-chain minimum (otherAmountThreshold, 50 bps slippage) | **FAIL** | got 0 threshold 7187355 |
| B7 no wrapped-SOL account left behind | pass |  |
| B8 resubmitting the same idempotency key sends nothing new | pass | sends 3 |
| X1 USDC -> SOL (token in, native out, wrapped SOL unwrapped by the route) finalized | **FAIL** | failed "simulation reverted at block 316: simulation failed: {\"InstructionError\":[2,{\"Custom\":6025}]}: Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1789" |
| X2 sold exactly the requested USDC and the wallet received SOL (fill matches the lamport change net of network fee) | **FAIL** | spent undefined recv undefined net 0 fee undefined |
| R1 Jupiter response with an instruction for an unknown program: refused, nothing sent, nothing spent | pass | failed sends 0 "simulation reverted at block 317: program tMykNtwYeHidctei6Yd8E53Eb5n8oVfENyJkop2wCiy is not on the allowlist" |
| R2 an optimistic quote snapshot (+20%) cannot produce a worse fill: the exact route is re-quoted, falls short of minOut, and nothing is sent | **FAIL** | finalized sends 1 "" |

## Not covered
- Routes were restricted to Raydium AMM v4 (`dexes=Raydium`) so their accounts could be cloned. Routes through other DEXes, multi-hop routes via intermediate tokens, and Token-2022 mints were NOT executed here.
- The cloned lookup tables were patched in one field (last-extended slot = 0).
- Single local node: no congestion, forks, or priority-fee competition; no Jito. Jupiter's quote is live mainnet while the pool is the clone, so small output gaps are expected.
- Nothing was sent to mainnet and no real funds were used.
