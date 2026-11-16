# @memedesk/evm — direct Uniswap-V2-style adapter

Pure TypeScript, zero dependencies. Imports core types from `../core/src`.

- `src/keccak.ts` Keccak-f[1600] / keccak256 / selectors (checked against known vectors; the permutation is also cross-checked against node's SHA3-256 using SHA3 padding)
- `src/abi.ts` minimal ABI encode/decode (address, bool, uintN, bytes32, address[])
- `src/calldata.ts` ERC20 approve/balanceOf/allowance; V2 router swaps, with SupportingFeeOnTransfer variants for taxed tokens
- `src/pair.ts` EIP-1014 CREATE2 and V2 pair derivation (factory and init code hash are injected)
- `src/approval.ts` `planApproval`: approves exactly `amount`, only when allowance < amount; unlimited is refused unless `allowUnlimited`
- `src/v2.ts` exact `getAmountOut`/`getAmountIn`, `decodeReserves`, and `V2Venue` (core `Venue`) backed by an injected async `EthCall`

Test: `node --experimental-transform-types --no-warnings --test "packages/evm/test/*.test.ts"`

Fixtures (`test/fixtures.ts`) use synthetic placeholder addresses and recorded eth_call responses. No network.

## BLOCKED by external dependency (live use)

Nothing here is verified against a real chain. Live use is BLOCKED until these are supplied and verified externally:

- chain IDs, RPC endpoints, and an `EthCall` implementation over them
- real factory, router and wrapped-native addresses, and the factory's init code hash per venue
- per-venue fee (997/1000 is only the Uniswap V2 default) and router ABI variants
- fee-on-transfer token detection (choose `feeOnTransfer` per token), allowance reads, tx signing and submission, gas, nonce, reorg handling
- `V2Venue.quote` is synchronous on a loaded snapshot, so reserves must be refreshed via `V2Venue.load` before use
