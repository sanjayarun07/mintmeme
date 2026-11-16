# MemeDesk — multichain spot-memecoin trading platform (local vertical slice)

Original code and branding. **Status: local simulation only.** No live chain, RPC, venue contract, Telegram token or bridge has been connected or verified. See `docs/` for the capability matrix and known limitations.

## Run

```bash
npm test          # 444 tests (re-run before relying on this): engine, hardening+fuzz, signer, orders, copy, snipe, solana, ledger, commerce, portfolio, alerts, chain-family sims, risk, bridge, telegram transport
npm run bench     # in-process fixture benchmark (not network latency)
npm run web:fork      # terminal API on OUR engine + a local anvil mainnet fork (fake ETH, needs ALCHEMY_API_KEY); UI adaptation in progress
npm run verify:bulk # Bulk buy from several wallets on a local Solana validator (needs solana-test-validator and ALCHEMY_API_KEY)
npm run verify:bulk-evm # Bulk buy and bulk sell from several wallets on a local Ethereum mainnet fork (needs anvil and ALCHEMY_API_KEY)
npm run verify:twap # TWAP buy and sell orders on a local Ethereum mainnet fork (needs anvil and ALCHEMY_API_KEY)
npm run verify:community # Wallet Bot read-only lookups against live public data (needs ALCHEMY_API_KEY; sends nothing)
npm run telegram # Standalone community bots only (Buy Bot, Wallet Bot) against real Telegram; no trading. Needs TELEGRAM_BOT_TOKEN. Do not run it together with the terminal below: one token, one poller
npm run web:markets # the terminal; with TELEGRAM_BOT_TOKEN in .env it also runs the bot, with /link, /buy and /sell for the practice account (Community bots page, Trade from Telegram); npm run web:fork does the same on the local fork
npm run verify:kill # TWAP and bulk orders killed with SIGKILL as separate processes and finished by fresh ones (needs anvil and ALCHEMY_API_KEY)
npm run verify:telegram-fork # Telegram trading on the fork terminal, against a fake Bot API (needs anvil and ALCHEMY_API_KEY)
npm run verify:launch-stream [seconds] # Live read-only check of the real-time Solana launch stream against mainnet (needs ALCHEMY_API_KEY; uses the public Solana WebSocket)
npm run verify:solana-snipe-copy # Solana copy trading and sniping on a local validator (needs solana-test-validator and ALCHEMY_API_KEY)
npm run verify:solana # Solana engine on a local validator with Raydium cloned from mainnet (needs solana-test-validator and ALCHEMY_API_KEY)
npm run markets      # READ-ONLY command-line look at real Ethereum and Solana coins (needs ALCHEMY_API_KEY)
npm run web:markets  # terminal UI with REAL Ethereum, BNB and Solana coins on Discover, read-only, no trading (open the printed port; needs ALCHEMY_API_KEY)
npm run verify:usdt   # USDT-style approve-to-zero-first on a local fork
npm run verify:cancel # replace-by-fee cancel of a pending tx on anvil
npm run verify:fee    # unaudited FeeRouter: platform fee collected on-chain on a local fork
npm run verify:jupiter-swap # Jupiter swap execution on a local validator, routes cloned from mainnet (needs solana-test-validator, ALCHEMY_API_KEY, network)
npm run verify:jupiter # Jupiter quote vs our Raydium quote (read-only, quotes only; needs network)
npm run verify:snipe  # sniper + trailing stop on a local mainnet fork (needs Foundry and ALCHEMY_API_KEY)
npm run verify:web    # drives that API over HTTP: quote, buy, sell with approval, orders from real reserves, pause
npm run verify:copy   # copy trading on a local mainnet fork: leader swap read over JSON-RPC, mirrored by the engine, reorg + crash-restart cases
npm run verify:orders # price-triggered orders (limit/TP/SL/OCO), durable across restarts, on a real pool on a local mainnet fork
npm run verify:engine # OUR ENGINE over a real-node adapter on a local mainnet fork (faults injected; needs ALCHEMY_API_KEY + Foundry)
npm run verify:fork   # Uniswap V2 buy/sell on a local mainnet fork (needs ALCHEMY_API_KEY in .env + Foundry)
npm run verify:local -- <rpc-url> <label>   # tx lifecycle checks on a loopback node
npm run web       # practice terminal (Tideline) at http://localhost:3000
```

Requires Node >= 22.18 (runs TypeScript with `--experimental-transform-types`; no npm dependencies).

## Layout

- `packages/core/src` — execution engine (resumable tx state machine, idempotency, nonce/reconcile), direct venue models (constant-product pool, linear bonding curve with graduation), router (aggregator = labeled benchmark only), policy signer, reservations, conditional orders (limit/TP/SL/trailing/OCO/market-cap), copy-trading with leader-attributed inventory, risk reports, double-entry ledger, signal extraction, bridge/funds step machines.
- `packages/sdk` + `apps/api` — SDK (`Trader`, `MemeClient`) and HTTP API over the whole engine; start the practice API with `API_KEYS="<key>:<user>" npm run api`; full guide: `docs/SDK_AND_API.md`
- `packages/core/src/port.ts` — `ChainPort`: what the engine needs from a chain (sync `SimChain` or a networked adapter). `packages/evm/src/rpcchain.ts` — `EvmRpcChain`: JSON-RPC adapter for Uniswap-V2-style pools.
- `packages/core/test` — fixtures on `SimChain`, a local simulated chain.
- `apps/telegram` — transport-agnostic command handler (Bot API wiring blocked: no token).
- `apps/web` — Tideline practice terminal: 11 task-oriented pages (discover, buy & sell, price orders, copy trading, launch check, signals, portfolio, wallets, alerts, activity, plan & fees) on the same engine, with a lifecycle tracker per trade and plain-language messages. Practice mode banner on every page; checked in a browser by hand, no automated browser tests yet.
- `bench` — benchmark harness. `deploy`, `docs` — templates, matrices, runbooks.
