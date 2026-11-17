# MemeDesk

A trading SDK for spot memecoins, an execution server that scales out across nodes, and a Solana test UI.

Original code. Practice chain, local forks and validators throughout; small real-funds tests on Solana mainnet through the test UI only. Read
`docs/KNOWN_LIMITATIONS.md` before trusting any of it with money. The earlier full platform (Telegram bot, full web terminal, markets, indexer, more fork harnesses) is
in git tag `v0.1.0-full-platform`.

Requires Node 22.18 or newer. No npm dependencies (Node runs the TypeScript directly), except the optional Privy login bundle.

## What is here

| Part | Where | Docs |
|---|---|---|
| **SDK**: execution engine, Solana (Raydium, Jupiter, pump.fun) and EVM (Uniswap V2) adapters, `Trader` (market, limit, take profit, stop loss, trailing, bracket, bulk, TWAP, snipe, copy; slippage chase, editable and USD triggers), `MemeClient` | `packages/core`, `packages/sol`, `packages/evm`, `packages/sdk` | `docs/SDK_AND_API.md` |
| **HTTP API** over the `Trader` | `apps/api` | `docs/SDK_AND_API.md` |
| **Execution server**: identical nodes, one Redis, per-user ownership, forwarding, failover, health and metrics, Docker | `apps/server`, `deploy/server` | `docs/PRODUCTION_SERVER.md` |
| **Solana test UI** `/solana`: wallet sign-in (Wallet Standard, Privy), market and standing orders, trading key, holdings, history | `apps/web`, `apps/privy` | `docs/SOLANA_MAINNET_TEST_CHECKLIST.md` |

## Run

```bash
npm test                         # unit, HTTP and cluster tests (cluster tests need a local Redis; skipped without one)
npm run verify:sol-guard         # the /solana back end on a local Solana validator, fake funds (needs solana-test-validator and ALCHEMY_API_KEY)
npm run web                      # Solana test UI at http://localhost:3000/solana: MAINNET, REAL FUNDS, this machine only
API_KEYS="<16+ char key>:alice" npm run api      # practice HTTP API (simulated chain) on 127.0.0.1:3500
npm run server:key -- alice      # make an API key for the execution server
npm run server                   # one execution node (see docs/PRODUCTION_SERVER.md for REDIS_URL, NODE_PUBLIC_URL, API_KEYS_FILE)
npm run build:sdk                # build the SDK package into packages/sdk/dist; npm run pack:sdk makes the .tgz
npm run bench                    # in-process engine benchmark (not network latency)
```
