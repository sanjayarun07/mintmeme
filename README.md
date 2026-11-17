# MemeDesk

A trading SDK for spot memecoins, an execution server that scales out across nodes, and a Solana test UI that trades real funds on mainnet behind hard limits.

Original code. Node 22.18+, no npm dependencies (Node runs the TypeScript directly), except the optional Privy login bundle. The earlier full platform (Telegram bot,
full web terminal, markets, indexer, more fork harnesses) is preserved in git tag `v0.1.0-full-platform`.

> **Read before using real money.** The SDK and the server have been verified on a simulated chain, local forks and local validators. Real-funds use so far is small
> Solana mainnet trades through the `/solana` test UI only. Nothing has run on Ethereum mainnet. Limits and what is not done: [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

## Contents

| Part | Where | What it is | Guide |
|---|---|---|---|
| **SDK** | `packages/core`, `packages/sol`, `packages/evm`, `packages/sdk` | Execution engine + `Trader` + `MemeClient`. Solana (Raydium, Jupiter, pump.fun) and Ethereum (Uniswap V2). | [`docs/SDK_AND_API.md`](docs/SDK_AND_API.md) |
| **HTTP API** | `apps/api` | Every `Trader` method over HTTP/JSON with API keys, per-user isolation, rate limits, OpenAPI, live events. | [`docs/SDK_AND_API.md`](docs/SDK_AND_API.md) §8 |
| **Execution server** | `apps/server`, `deploy/server` | Identical nodes on one Redis: per-user ownership, forwarding, failover, health and metrics, Docker. Serves the API and `/console`. | [`docs/PRODUCTION_SERVER.md`](docs/PRODUCTION_SERVER.md) |
| **Solana test UI** | `apps/web`, `apps/privy` | `/solana`: sign in with your wallet (Wallet Standard or Privy), market and standing orders, trading key, holdings, history, kill switch. Mainnet, real funds. | [`docs/SOLANA_MAINNET_TEST_CHECKLIST.md`](docs/SOLANA_MAINNET_TEST_CHECKLIST.md) |

## Setup

```bash
git clone https://github.com/sanjayarun07/mintmeme.git && cd mintmeme
git switch cleanup/sdk-server-only
cp .env.example .env        # then fill in what you need (below)
npm test                    # unit, HTTP and cluster tests (cluster tests need a local Redis; they are skipped without one)
```

| `.env` key | Needed for | Notes |
|---|---|---|
| `ALCHEMY_API_KEY` | `/solana` (mainnet reads), `verify:sol-guard`, `verify:evm` | Never printed or sent to the browser; the UI's RPC relay keeps it on the server. |
| `PRIVY_APP_ID` | Privy login on `/solana` | Public. Build the bundle once: `npm run build:privy`. Add your UI addresses to the Privy app's allowed origins. |
| `API_KEYS` | practice API (`npm run api`) | `"<16+ char key>:<user>[:read\|trade],..."` |
| `REDIS_URL`, `NODE_PUBLIC_URL`, `API_KEYS_FILE` | execution server (`npm run server`) | See the server section. |

Optional tools: Redis (cluster tests and the server), Solana CLI with `solana-test-validator` (`verify:sol-guard`), Foundry's `anvil` (`verify:evm`), Docker (3-node stack).

## Use the SDK

```js
import { createSimTrader, PRACTICE_TOKEN as T } from 'memedesk-sdk';    // or from packages/sdk/src/index.ts in this repo

const { trader } = createSimTrader();                                  // practice chain, wallets w1 and w2, fake funds
await trader.buy({ walletId: 'w1', token: T, amount: '50000', key: 'my-buy-1' });   // same key twice never trades twice
await trader.limitSell({ walletId: 'w1', token: T, amount: '1000', priceE18: '3000000000000000000',
  slippageBps: 300, chase: { stepBps: 100, maxBps: 500 } });           // a failed fill retries at 4%, then 5%
await trader.bracket({ walletId: 'w1', token: T, amount: '1000', takeProfitE18: '...', stopLossE18: '...' });
await trader.editOrder('o-…', { priceE18: '...' });                    // move a trigger in place
trader.start();                                                        // the order loop (1 s)
```

- **Order types:** market buy and sell, limit buy and sell, take profit, stop loss, trailing stop, bracket (OCO), bulk (up to 10 wallets), TWAP, snipe, copy, price alerts.
- **Slippage chase:** `chase: { stepBps, maxBps }` widens slippage on each failed fill, capped.
- **USD triggers:** `priceUsd: '0.0000024'` with a quote/USD feed in `TraderConfig.usd`: the trigger stays fixed in dollars while SOL or ETH moves.
- **Durable state:** `persistDir` (files) or `state` (Redis): orders, journal and settings survive restarts; nothing trades twice.
- **Real chains:** build the `Trader` over `SolanaChain` or `EvmRpcChain` with your signer (see `apps/web/solmainnet.ts` for a working Solana example).
- **Package:** `npm run build:sdk` builds `packages/sdk/dist`; `npm run pack:sdk` makes `memedesk-sdk-0.1.0.tgz`. Build needs `TYPES_ROOT=<node_modules/@types>` if `@types/node` is not installed here.

Full parameter and route reference: [`docs/SDK_AND_API.md`](docs/SDK_AND_API.md).

## Run the HTTP API and the execution server

Single process, practice chain:

```bash
API_KEYS="<16+ char key>:alice" npm run api          # http://127.0.0.1:3500, OpenAPI at /v1/openapi.json
```

Cluster (any number of identical nodes on one Redis):

```bash
npm run server:key -- alice                           # prints the secret once (give it to the client) and a "hash:alice:trade" line
echo "<that hash line>" >> keys.txt
REDIS_URL=redis://127.0.0.1:6379 REDIS_REQUIRE_AOF=false API_KEYS_FILE=keys.txt NODE_PUBLIC_URL=http://127.0.0.1:3500 PORT=3500 npm run server
REDIS_URL=redis://127.0.0.1:6379 REDIS_REQUIRE_AOF=false API_KEYS_FILE=keys.txt NODE_PUBLIC_URL=http://127.0.0.1:3501 PORT=3501 npm run server
```

- **`/console`** on any node: paste an API key and use every API action from a page; each response names the node that ran it.
- **Clients:** `new MemeClient({ baseUrl, apiKey })` or plain HTTP with `Authorization: Bearer <key>`.
- **Health:** `/healthz`, `/readyz`, `/metrics` (users, active orders, event-loop delay, forwarding, claims, lost leases).
- **Docker:** Redis (AOF, password) + 3 nodes + nginx: `deploy/server/docker-compose.yml`.
- **Measured** (3 nodes, one machine, local Redis): about 33 000–39 000 reads/s with p99 under 7 ms; 700–1 060 market buys/s; 3 000 standing orders watched with
  event-loop p99 under 4 ms; failover 1 s after a graceful stop, 15 s (the lease TTL) after a crash, for 200 users at once. Up to 300 users per node measured (the default cap).
  Details: [`docs/PRODUCTION_SERVER.md`](docs/PRODUCTION_SERVER.md).
- **Practice only:** nodes build practice accounts (simulated chain, fake funds). Real-chain accounts follow the custody plan below.

## Use the Solana test UI (real funds)

```bash
npm run web                                           # http://localhost:3000/solana  (this machine only, one user)
```

1. **Sign in** with your wallet (Phantom, Solflare, Backpack, or Privy). Logging in to Privy is not enough: also click your Privy wallet in "Sign in with your wallet"
   and approve the one-time message. A sign-in from another browser or address takes over the session.
2. **Limits** apply to every trade: 0.01 SOL per trade and 0.05 SOL per day by default, max slippage 5%. Change them in the wallet panel.
3. **Trade:** search a token, then **Prepare** (quote and simulation, nothing sent) and **Confirm** (your wallet approves). Standing orders (limit, take profit, stop loss,
   trailing, bracket, TWAP) fire when their trigger is met; with a wallet login each fire needs your approval, so keep the page open.
4. **Trading key** (orders fire unattended): create it, **Fund trading key** from your wallet (at most 0.05 SOL per funding, 0.5 SOL held), then **Use trading key**.
   It is capped at 0.05 SOL per trade and 0.25 SOL per day and expires after 24 h. **Return SOL to your wallet** sends its SOL back, only to a wallet that funded it and
   signed in here. The key is a hot key on this machine (`.state/sol-mainnet/trading-key.json`): keep only small amounts in it. It will be replaced by delegated signing (below).
5. **Kill switch** ("Pause trading" in the header): stops new trades, order fires and funding; orders stay saved. Pausing works from anywhere; resuming needs your
   signed-in session. It survives restarts.

The UI listens on 127.0.0.1 only and refuses posts from any other page (Host, Origin and JSON checks). Sessions are in memory: a server restart signs you out.

## Custody plan: real accounts on the server

The server needs a signer for each user before it can trade real funds. Chosen direction (self-custodial: users keep control and can revoke):

| Chain | Approach | How it works | Status |
|---|---|---|---|
| **Solana** | **Privy delegated signing** (option B) | The user's Privy wallet grants the app a limited, revocable permission ("session signer") with a policy: max per trade, allowed programs (Jupiter, pump.fun), expiry. The server asks Privy to sign within that policy; it never holds the key. Standing orders fire unattended. Replaces the trading key. | **Planned.** Not built yet. |
| **Ethereum / EVM** | **ERC-4337 smart account with session keys** (option C) | The user owns a smart account; it grants the server a session key limited on chain (allowed contracts such as the Uniswap V2 router, token and amount limits, expiry). Even a stolen session key cannot exceed those on-chain limits. | **Planned.** Not built yet. |

**What is needed from you to build it:**
- **Solana (Privy):** turn on delegated signing / session signers for the Privy app; create the server authorization key and the app secret and put them in `.env`
  (`PRIVY_APP_SECRET` and the authorization key; never in chat or git); add the UI addresses to the allowed origins; confirm the policy limits (default: the current
  0.05 SOL per trade, 0.25 SOL per day, swaps only through Jupiter and pump.fun).
- **EVM (ERC-4337):** choose the smart-account implementation and bundler/paymaster providers (account and entry-point addresses must come from the providers' official
  pages, never guessed), the chain (Ethereum mainnet or an L2), and the session-key limits.
- **Build order:** each lands behind tests on a local validator or fork first, then small real amounts that you approve.

Until then, the server stays practice-only, and the `/solana` UI's wallet sign-in and capped trading key are the real-funds paths.

## Test and verify

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | Unit, HTTP, cluster and server tests (379) | Redis for the cluster tests |
| `npm run verify:sol-guard` | The `/solana` back end on a local Solana validator, fake SOL: limits, kill switch, wallet sign-in and signing, orders, TWAP, trading key fund, use and return (55 checks) | `solana-test-validator`, `ALCHEMY_API_KEY` |
| `npm run verify:evm` | The SDK `Trader` and HTTP API on a local Ethereum mainnet fork, real Uniswap V2 WETH/USDC pool, fake ETH: market buy and sell with approval, orders, bulk, TWAP, restart | `anvil`, `ALCHEMY_API_KEY` |
| `npm run server:loadtest` | Throughput, latency, event-loop delay with standing orders, failover with many users (`USERS`, `NODES`, `SECONDS`, `CONCURRENCY`) | Redis |
| `npm run bench` | In-process engine benchmark (not network latency) | – |

Reports from the fork and load runs are written to `docs/live-verification/`.

## Repository layout

```
packages/core     engine, order manager, runners (bulk, TWAP, snipe, copy), policy signer, Redis client, state backends
packages/sol      Solana: chain port, Raydium, Jupiter swap, pump.fun, signers (dev, remote), search, mint checks
packages/evm      EVM: JSON-RPC chain port, Uniswap V2 math and calldata, approvals, HTTP signer hook
packages/sdk      Trader, MemeClient, wire helpers, practice world; dist/ and the .tgz are the built package
packages/live     fork-test harnesses kept: /solana (solguardfork), SDK on Ethereum (traderfork), and their helpers
apps/api          HTTP API over the Trader
apps/server       execution node: leases, forwarding, console, key tool, load test
apps/web          /solana test UI: server, back end (solmainnet), guards, page scripts
apps/privy        Privy login bundle (React, built separately)
deploy/server     Dockerfile, docker-compose (Redis + 3 nodes + nginx), nginx.conf
docs              SDK and API guide, production server, known limitations, Solana test checklist, verification reports
```

## Safety rules this code follows

- Secrets stay in `.env` (git-ignored) and are never printed, logged or sent to a browser. API keys are stored as SHA-256 hashes only.
- No real funds move without an explicit confirmation by the user or a standing order the user placed, always within per-trade and daily limits, with a kill switch.
- Addresses, program ids and endpoints come from official pages and are verified on chain by the fork tests; nothing is filled in from memory.
- Every claim about what was tested points at a test or a report in `docs/live-verification/`.
