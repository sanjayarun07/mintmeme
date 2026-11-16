# SDK on a Robinhood Chain testnet fork (self-deployed Uniswap V2)

Run: 2026-11-16T15:44:05.105Z
Node: local anvil fork of Robinhood Chain testnet (chain 46630) at http://127.0.0.1:8668. NOT the real testnet; nothing was sent to it. Throwaway keys, fake ETH.
Deployed on the fork only: factory 0x00000000000000000000000000000000f0000001, router 0x00000000000000000000000000000000f0000002, token 0x00000000000000000000000000000000f0000003 (Uniswap's own V2 bytecode read from Ethereum mainnet; WETH9 code reused as a plain ERC-20). WETH: 0x7943e237c7F95DA44E0301572D358911207852Fa (documented at https://docs.robinhood.com/chain/protocol-contracts).
Result: **PASS** (21/21 checks)

## Observed
- fork of Robinhood Chain testnet (local fork, self-deployed Uniswap V2), chain time 1794843819; spot 1.0000e-4 ETH per raw token unit; pool wrapped-native reserve 50.000 ETH; wallets w1, w2, w3 hold 10 fake native coin each; the API runs on loopback and the client is MemeClient

## Checks
| Check | Result | Detail |
|---|---|---|
| R0 the fork reports chain id 46630 | pass |  |
| R1 the documented testnet WETH has code on the chain | pass | https://docs.robinhood.com/chain/protocol-contracts |
| R2 the Uniswap V2 addresses listed for "Robinhood Chain" have no code on this testnet (so they are not usable here) | pass | eth_getCode on both returned 0x |
| R3 the router bytecode embeds the factory and WETH addresses as constants and both were swapped | pass | factory x27, WETH x27 |
| R4 router.factory() and router.WETH() return our factory and the documented testnet WETH | pass | 0x00000000000000000000000000000000f0000001 0x7943e237c7f95da44e0301572d358911207852fa |
| R5 a pool with 50 ETH and 500,000 tokens exists through our factory | pass | reserves 50000000000000000000 / 500000000000000000000000 |
| R6 the pool fee is read from the router's own getAmountsOut | pass | router 9969801202164028849 |
| R1x the API quote equals the real Uniswap V2 router getAmountsOut for the same amount | pass | API 995015938219190933279, router 995015938219190933279, venue uni:WETH-USDC |
| R2x a market buy over HTTP is finalized, the wallet received exactly the fill, and one transaction was sent | pass | state finalized, received 995015938219190933279, minOut 965165460072615205280, nonce 0->1 |
| R3x repeating the same Idempotency-Key trades nothing: same USDC, same nonce | pass |  |
| R4x a 50% sell is finalized, sold exactly half the balance, and used an exact-amount approval (child tx) | pass | sold 497507969109595466639 of 995015938219190933279 |
| R5x a buy above the wallet's per-transaction cap is refused by the policy signer and nothing is sent | pass | signer policy: exceeds per-tx limit |
| R6x a limit buy whose trigger is met fires and buys real USDC; a limit sell 5x above the market stays active and says why | pass | buy fired, sell active: trigger not met |
| R7x a stop loss whose trigger is above the price fires and sells exactly its amount of real USDC | pass | sold 49750796910959546664 |
| R8x in a bracket the leg that hit fires and the other is cancelled; only one sale happened | pass | tp cancelled, sl fired |
| R9x a trailing stop follows the price up (peak rises, not fired), then fires once the price falls 3% from its peak | pass | base 100362228851518, peak 117726256644943, status fired |
| R10x a bulk buy from 2 wallets: both legs filled from their own wallets, one transaction each, the legs sum to the total | pass | filled 2, spent 200000000000000000 |
| R11x a 3-slice TWAP traded one slice per interval: 3 filled, 3 transactions, slices exactly 300 s apart | pass | filled 3, nonce +3 |
| R12x while paused a buy is refused (nothing sent) and a sell still works (one swap, plus its approval) | pass | buy: entries_paused, sell: finalized, transactions sent: 2 (the sell, plus its exact-amount approval) |
| R13x after a restart the new Trader loads the active order from its state file and placing the same id again does not create a second one | pass | files: bulk-u1.bb.json, orders.json, trader.json, twap-u1.tw.json |
| R14x no private key material is written to any state file | pass | checked engine and trader state files |

## Not covered
- There is no Uniswap V2 on the real Robinhood testnet that we could find: the listed addresses have no code there. This run does not show that Uniswap or any DEX works on the real testnet, only that the SDK works against this chain's RPC and fork behaviour with a V2-style pool.
- No transaction went to the real testnet.
- The fork uses anvil's EVM, not Arbitrum Nitro: Nitro gas accounting (L1 data fee) and precompiles are not reproduced.
- Uniswap V3 and Robinhood's stock tokens are not exercised.