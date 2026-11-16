# Local node lifecycle check — anvil-local

Run: 2026-11-13T12:43:32.716Z
Node: http://127.0.0.1:8650 (loopback; a local test chain, NOT mainnet or a public testnet)
Result: **FAIL** (16/17 checks)

What this shows: how a real node (not our simulator) answers the situations the engine's reconcile design relies on. Throwaway keys, local funds only; keys are not recorded here.

## Observed node behaviour
- chainId 31337; client anvil/v1.9.0; block 1
- eth_gasPrice 1875000000 wei
- receipt gasUsed 21000, effectiveGasPrice 2640778125
- resubmit of an INCLUDED tx -> rejected: nonce too low
- DIFFERENT tx at a consumed nonce -> rejected: nonce too low
- resubmit of a PENDING tx -> rejected: transaction already imported
- replace pending nonce 3 with a noop at 3x fee -> accepted 0x4fc4ad20aebe860aa6415f1a6b5144f608c4c30de52b2973b202d12dd0aca0b3
- replace with a non-higher fee -> rejected: replacement transaction underpriced
- E (on-chain revert behaviour) needs a deployed contract; not exercised here. See KNOWN_LIMITATIONS.

## Checks
| Check | Result | Detail |
|---|---|---|
| funding tx confirmed | pass | block 2 |
| throwaway wallet funded | pass |  |
| A1 receipt status success | pass |  |
| A2 recipient delta == value | pass | delta 100000000000000000 |
| A3 sender delta == -(value + gasUsed*effectiveGasPrice) | pass | delta -100055456340625000, gas 55456340625000 |
| A4 network fee derivable from receipt alone | pass | 55456340625000 wei |
| B1 resubmit of included tx does not create a second execution | pass | nonce too low |
| B2 different tx at consumed nonce is rejected | pass | nonce too low |
| C1 gapped tx is visible at the node but not mined | pass | pending/queued |
| C2 identical resubmit of pending tx does not duplicate | **FAIL** | transaction already imported |
| C3 no receipt while pending | pass |  |
| D1 replace-by-fee noop accepted | pass |  |
| D2 replacement without a fee bump is rejected | pass | replacement transaction underpriced |
| D3 replaced original is no longer known (engine reads this as "absent") | pass | null |
| D4 noop mined, nonce 3 consumed | pass |  |
| D5 original never executed (recipient got only the first transfer) | pass | b delta 100000000000000000 |
| D6 original has no receipt | pass |  |

## Not covered
- The engine itself is not yet wired to a real node (it runs against the in-memory simulator); these checks validate the assumptions it makes.
- No DEX swap: a bare local chain has no Uniswap/Raydium contracts. Swap fork tests need a mainnet fork (needs `ALCHEMY_API_KEY`).
