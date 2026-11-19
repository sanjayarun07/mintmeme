# Production execution server (`apps/server`)

A standalone, horizontally scalable server for the SDK. It runs the same HTTP API as `apps/api` (every route calls a `Trader` method; see `docs/SDK_AND_API.md`),
but as a **cluster of identical nodes** that share one Redis. Add nodes to serve more users; lose a node and its users move to the others.

Status: the cluster mechanics (ownership, routing, failover, durability of orders) are built and tested, including in Docker. Two account modes:
**practice** (simulated chain, fake funds) and **solana-mainnet** (real funds: each user links their own Privy wallet and the owner node signs through Privy; see
"Real Solana accounts" below). The real mode has been run on a local validator with two nodes and a Privy stand-in, and with one small user-approved buy on mainnet.

## Real Solana accounts (`MODE=solana-mainnet`)

Each node needs, besides the usual settings: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTH_KEY_ID`, `PRIVY_AUTH_PRIVATE_KEY`, `PRIVY_SOLANA_POLICY_ID` (README → Custody
plan) and `SOLANA_RPC_URL` (or `ALCHEMY_API_KEY`). A node refuses to start without them.

- **Linking** (per API user, once): `POST /v1/wallet/link/start {address}` returns a one-time message; the user's Privy wallet signs it; `POST /v1/wallet/link/finish
  {address, signature}`. The signature proves this API user controls the wallet, then the node asks Privy whether the wallet carries the server signer with the policy.
  Only then is `{address, walletId}` saved under the user in Redis, through the user's lease. `GET /v1/wallet` shows it; `DELETE /v1/wallet` removes it.
- **Signing:** the owner node runs `createSolanaTrader` (packages/sdk/src/solana.ts) over the user's Redis state. Trades go through `PolicySigner` (0.05 SOL per buy,
  0.25 SOL per day, ledger in Redis) and then Privy, which applies the policy and signs. No node holds a private key.
- **Every new owner asks Privy again** before anything is signed (failover, drain, restart). A revoked wallet comes up `active: false` and every trade is refused.
  If Privy is unreachable, the claim fails and the next sweep retries it.
- **Before each trade** the node learns the token (its venues) and reads the chain's clock and pools; each tick refreshes pools and learns the tokens of restored orders.

Verified (`npm run verify:server-sol`, report in `docs/live-verification/`, 15 of 15): linking through one node; a market buy in plain units sent to the non-owner node, forwarded,
signed by the Privy stand-in and landed; the same idempotency key not trading twice; the per-trade cap; a limit order surviving a crash of the owner node, the other node
asking Privy again, the order edited there and firing by itself; a sell of half the holding in plain units; a compute-unit limit from simulation and a capped priority fee on the landed buy; MEV protection (a stand-in Jito block engine forwarding to the validator): with the setting on, a buy sent with `bundleOnly=true`, a 10,000-lamport tip from the tip floor and the jitodontfront flag, landed; with it off, a plain buy sent publicly and one with `mevProtection: true` sent privately; and a revoked signer failing with nothing sent. `apps/server/realmode.test.ts` covers linking, refusals
and failover without a chain.

**Mainnet, 2026-11-17 (user-approved):** two nodes in `MODE=solana-mainnet`; the user linked their Privy wallet from the `/solana` page's Execution server box (served by a node, same origin
as the API) and bought 0.005 SOL of Bonk through the API in plain units. Routed through Jupiter, signed by real Privy under the app's policy, finalized as tx
`3zMawgRFnseC1daidQZMQarkmFvqHS6scJu5qgCeNAdwUhj95E8ee2SBv1FhTZbXSbWdoUDmwj9Py7dbvQ8tpQ8G` (wallet paid 0.005009668 SOL, received 154,813.93 Bonk).

## Real Base accounts (`MODE=base-mainnet`)

The same server for Base. Each API user links their own **Privy embedded Ethereum wallet** (`apps/server/baseaccount.ts`), and the owner node runs `createBaseTrader` over the
user's Redis state. Env: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTH_KEY_ID`, `PRIVY_AUTH_PRIVATE_KEY`, `PRIVY_BASE_POLICY_ID` (README → Base policy rules), and `BASE_RPC_URL`
or `ALCHEMY_API_KEY` with Base enabled. Optional: `BASE_MAX_TRADE_ETH=0.01`, `BASE_DAILY_CAP_ETH=0.05`. `PLATFORM_FEE_BPS` is refused in this mode: Base has no fee router yet.
Linking is the same routes as Solana: `/v1/wallet/link/start` and `/link/finish`. The signature is a `personal_sign` (0x, 65 bytes). The server recovers the signer from it, then asks Privy for the signer and the Base policy.

Every transaction Privy signs is decoded and compared with what the engine built: destination, value, data, nonce, gas, fees and chain. Its signer is recovered from the signature and must be the
linked wallet. Otherwise it is refused and nothing is sent. Trades route through Uniswap V2 WETH pools, and through Relay for tokens with no or a thin V2 pool (each Relay transaction decoded, checked and simulated before signing; `no_route` when neither has a route). Local proof: `npm run verify:server-base`, 15 checks including a Relay buy and sell.

**Mainnet, 2026-11-18 (user-approved), the newer features together:** a 0.005 SOL Bonk buy through the API with `mevProtection: true`, finalized as tx
`4EbzSNurPKE54KjuxFdZJKEMNGW9U9iYKWyG6GzVxRDNrsn4cj9EptYVhfd7DmoE5iGCfCFdt8iKowRXdTqHGm9j`: it passed the token safety check, was sent privately to Jito with a
7,754-lamport tip (the tip floor's 75th percentile) to a Jito tip account and the `jitodontfront` flag, carried a compute-unit limit of 67,250 from simulation
(56,191 used) at 10,000 micro-lamports per unit (672 lamports of priority fee), and was stored in Postgres with every state it went through and its audit entry.
The first try was refused before signing: on a longer route the transaction would have been about 1,263 bytes, over the 1,232-byte limit. Too-large Jupiter routes
are now asked again with fewer accounts (48, 36, 28) and refused only if none fits.

## Several chains on one server (`CHAINS=solana,base,bnb,robinhood`)

One node group can serve every chain at once, so a user trades Solana, Base, BNB Chain and Robinhood Chain through the same nodes and the same API key.
`CHAINS` lists the chains (`practice`, `solana`, `base`, `bnb`, `robinhood`; `apps/server/chains.ts`); `MODE` stays as a one-chain shorthand (`MODE=base-mainnet` is
`CHAINS=base`). Each chain needs the settings of its own section (Solana and Base above, BNB and Robinhood below); a node names every missing one and refuses to start.

- **One lease, one account per chain.** Each user is still owned by one node (one Redis lease). On that node the user has one account per chain: its own Trader,
  wallet link, orders, journal, spend ledger, settings and copies. Leases, forwarding, failover, Redis, rate limits (one budget per key across chains), `/metrics`,
  `/status` and webhooks are shared. A chain whose account cannot start (its RPC or Privy is down) answers `503 chain_unavailable` for that chain only and is
  retried every 10 s by the sweep and the next request; the user's other chains keep running.
- **Requests name the chain with a path prefix:** `/v1/<chain>/...`, for example `POST /v1/base/trades/buy`, `GET /v1/bnb/orders`, `GET /v1/robinhood/events`.
  A path **without** a prefix goes to the **default chain**, the first one in `CHAINS`, so a single-chain server, its clients and its old paths keep working.
  `GET /v1/chains` (no key) lists the chains and the default. `/v1/app/*` has no prefix (apps are the same on every chain). A known chain this server does not run
  answers `404 chain_not_enabled`. The SDK client: `new MemeClient({ baseUrl, apiKey, chain: 'base' })` or `client.forChain('bnb')`.
- **Wallets are linked per chain:** `POST /v1/base/wallet/link/start {address}` then `/v1/base/wallet/link/finish`, and the same under `/v1/solana/`, `/v1/bnb/`,
  `/v1/robinhood/`. One Privy Ethereum wallet can be linked on every EVM chain; each link is checked against **that chain's** policy id
  (`PRIVY_BASE_POLICY_ID`, `PRIVY_BNB_POLICY_ID`, `PRIVY_ROBINHOOD_POLICY_ID`), and the engine applies that chain's caps. The wallet's server signer must carry each of
  those policy ids (`addSigners({ signers: [{ signerId, policyIds: [basePolicyId, bnbPolicyId, robinhoodPolicyId] }] })`); setting the same id in several variables also
  works, with one Privy policy that has rules per chain id.
- **State stays separate and old data still loads.** The default chain keeps the unprefixed Redis names it always had (`<ns>:u:<user>:engine`, `...:solwallet`); every
  other chain is under `<ns>:u:<user>:@<chain>:<name>` (`@` cannot occur in an app end user's id, so the two never collide). The first start with `CHAINS` writes the default chain to `<ns>:chains:default`; a node whose first chain differs
  refuses to start, because its unprefixed state belongs to the other chain. That first start also refuses a default chain when the namespace already holds another
  chain's single-chain accounts (a `basewallet` written by a `MODE=base-mainnet` server), whether or not that chain is listed: list it first, or use another namespace. Two existing single-chain namespaces (for example
  Solana on 3501 and Base on 3500) cannot be merged without copying the second one's keys under its chain prefix; keep the larger as the default and move the other.
- **Every node of a group must run the same `CHAINS`.** A node that lacks a chain answers `404 chain_not_enabled` instead of forwarding, and a user owned by such a
  node has that chain's orders unwatched. Roll a `CHAINS` change out to all nodes together (drain, restart).
- **Postgres and webhooks** say the chain: trades have the `chain` column set, trade keys of non-default chains are stored as `<chain>/<key>`, and webhook events carry
  `chain` when a server runs more than one. `GET /v1/records/trades` lists the user's trades on every chain (each row has `chain`), whichever prefix it is called with.
- **The next EVM chain is configuration:** an entry in `CHAIN_SPECS` (`apps/server/chains.ts`: chain id, the env names of its RPC, Privy policy and caps, aggregator) and its
  contracts in `EVM_NETWORKS` (`packages/sdk/src/base.ts`: V2 router and factory, wrapped native coin, a dollar pool for USD prices, pool fee, finality depth). No server
  code changes.

Verified: `apps/server/chains.test.ts` (routing, per-chain linking and state, forwarding and failover with two chains, the pinned default chain, the legacy-namespace refusal,
a chain failing alone, one rate budget across chains); `npm run verify:server-multi`: two nodes serving Solana, Base, BNB and Robinhood forks for one key (below).

## BNB Chain and Robinhood Chain (`CHAINS=...,bnb,robinhood`)

The Base account code with another network's contracts (`EVM_NETWORKS` in packages/sdk/src/base.ts, every address read back from the chain on 2026-11-18):

| Chain | Chain id | DEX | Wrapped native | USD price from | Env |
|---|---|---|---|---|---|
| BNB Chain | 56 | PancakeSwap V2 (router `0x10ed43c7…024e`, 0.25% pool fee) | WBNB | WBNB/USDT pool | `BNB_RPC_URL` (or `ALCHEMY_API_KEY` with BNB enabled), `PRIVY_BNB_POLICY_ID`, `BNB_MAX_TRADE_ETH=0.02`, `BNB_DAILY_CAP_ETH=0.1` (in BNB) |
| Robinhood Chain | 4663 | Uniswap V2 (router `0x89e5db8b…9eba`), and KyberSwap (router `0x6131b5fa…37b5`, chain name `robinhood`) for tokens with no usable V2 pool: `ROBINHOOD_AGGREGATOR=kyberswap` (default) or `off` | WETH | WETH/USDG pool | `ROBINHOOD_RPC_URL` (or `ALCHEMY_API_KEY` with Robinhood enabled), `PRIVY_ROBINHOOD_POLICY_ID`, `ROBINHOOD_MAX_TRADE_ETH=0.01`, `ROBINHOOD_DAILY_CAP_ETH=0.05` |

Plain units: `bnb` for BNB amounts on BNB Chain (`eth` on Base and Robinhood). Tokens trade only against their V2 pool with the wrapped native coin: Relay and KyberSwap
are not wired on these chains (`no_route` otherwise). The quote venue is reported as `uniswap-v2` on both (PancakeSwap V2 is a Uniswap V2 fork with a 0.25% fee, which
the quote math uses). Each chain's Privy policy must allow that chain's V2 router (swaps, value capped) and `approve(router)`, with its chain id (README → Base policy
rules, with that chain's router). Not yet traded on either mainnet.

**Robinhood Chain:**
- **Venues:** it has KyberSwap besides V2 (`ROBINHOOD_AGGREGATOR`, default `kyberswap`), so the BNB note above (V2 pools only) does not apply here.
- **Privy policy:** `memedesk-robinhood` (chain id 4663, created 2026-11-19) allows both routers, approvals to those two routers only, and buys up to 0.01 ETH.
- **Stock tokens:** they work as Base stocks do. Look one up by ticker (`token: "TSLA"`); buys need `STOCKS_ENABLED=1`; the share-price check counts `uiMultiplier()` shares per token (docs/XSTOCKS.md, "Robinhood Chain").

## How it works

```
               clients (MemeClient / HTTP, Bearer API key)
                              |
                      load balancer (TLS)            any node can take any request
               /              |              \
          node1            node2            node3     identical; each owns some users
             \               |               /
                    Redis (AOF on, password)          all state + one lease per user
```

- **One owner per user.** Each user's state (engine trade journal, orders, TWAP and bulk jobs, trader settings) lives in Redis under `<ns>:u:<user>:*` and is guarded by a
  lease key. The node holding the lease is the only one that runs the user's `Trader` and the only one allowed to write that state. Every write is a Lua script that checks the
  lease token, so a node that lost its lease (a long pause, a network split) **fails closed** on its next write instead of overwriting the new owner.
- **Routing.** A node authenticates the key, finds the user, then serves it (owner), forwards it in one hop (another node owns it; streamed, `/v1/events` included), or claims it
  (nobody owns it and the node has room). A forwarded request carries `x-memedesk-hop`; a second hop is refused, so ownership churn cannot loop.
- **Orders run with no traffic.** Every `SWEEP_MS` each node claims unowned users (up to `MAX_USERS_PER_NODE`), so standing orders are always watched by some node.
- **Failover.** A node renews its leases every `LEASE_TTL_MS / 3`. A node that dies stops renewing; after the TTL another node takes the user over and **resumes from Redis**:
  same order ids, same idempotency keys, so nothing trades twice.
- **Graceful shutdown.** On SIGTERM a node stops claiming, stops its `Trader`s and **releases** its leases, so other nodes take over at once.
- **Keys.** The server holds only SHA-256 hashes of API keys (`API_KEYS_FILE`). Make keys with `npm run server:key -- <user> [trade|read]`: the secret is printed once.

## Measured (this machine, 2026-11-17)

| What | Result |
|---|---|
| Unit and cluster tests (`apps/server/server.test.ts`, real nodes on real ports, local Redis) | 10 of 10 pass: single-owner leases, fail-closed write after a lost lease, AOF refusal, forwarding, crash failover with orders restored, drain handover, per-node cap, `/solana` sample link, `/console` and the node header, non-path request targets refused, trading after a practice failover |
| API end to end through two nodes (every call made on purpose to the owner or the non-owner) | 24 of 24: market trades, every order type with chase, edit, cancel, an order firing by itself, bulk, TWAP, the event stream through the forwarding node, isolation, read-only keys, drain handover |
| `/console` in a browser, through the non-owner node | every action: quote, buy, sell, all six order types, edit, cancel, a self-firing limit buy, bulk, TWAP, pause and resume, live events |
| Two node processes via `main.ts` | request on the non-owner forwarded; order placed through it; SIGTERM on the owner: the other node owned the user at once, order still active with its chase settings; `PATCH` edit worked on the new owner; no lease left behind |
| Docker: Redis (AOF) + 3 nodes + nginx (`deploy/server`) | requests through the load balancer reached the owner; `docker stop` of the owner: next request answered by a new owner in **1 s**; `SIGKILL` of the next owner: answered after **15 s** (= `LEASE_TTL_MS`); the order stayed active throughout |

### Throughput (npm run server:loadtest)

Three node processes on one machine (Apple M3 Max, 16 threads) and one local Redis, practice accounts, 64 concurrent clients, 15 s per phase. Each request went to the
user's owner node half the time and to a random node otherwise, so about a third were forwarded one hop. Reports: `docs/live-verification/2026-11-17T15-04-11Z-server-load-200u.md`
and `…15-05-23Z-server-load-600u.md`.

| | 200 users (about 66 per node) | 600 users (about 200 per node) |
|---|---|---|
| Reads (`GET /v1/overview`), all nodes together | 38 849/s, p50 1.4 ms, p99 5.6 ms, 0 errors | 33 503/s, p50 1.4 ms, p99 6.9 ms, 0 errors |
| Forwarding cost on reads (p50 direct vs forwarded) | 1.0 vs 2.4 ms | 0.9 vs 3.3 ms |
| Market buys (each a full engine trade with write-ahead saves), all nodes | 689/s, p50 64.6 ms, p99 407 ms, 1 error in 10 340 | 1 065/s, p50 42.2 ms, p99 250 ms, 0 errors |
| Standing orders watched every tick | 1 000 | 3 000 |
| Event-loop delay per node with those orders, under read load (p99) | 1.6 to 2.6 ms | 3.0 to 3.6 ms |
| SIGKILL of one node (lease TTL 15 s) | its 68 users all answered again after 15.1 s | its 201 users all answered again after 14.8 s |

After that failover the two survivors carried about 300 users and 1 500 orders each with no errors, so 300 users per node is the measured ceiling and the default
`MAX_USERS_PER_NODE`. Buys get faster with more users because each user's trades are serialised; reads and order watching barely load the event loop at this scale.
These are one machine's numbers with a local Redis: a networked Redis adds its round trip to every synchronous call, so measure on the target hardware.

The first Docker run took 60 s per failover: nginx's default connect timeout on a stopped container. `nginx.conf` now sets `proxy_connect_timeout 2s` and node-to-node
forwarding has a 3 s connect timeout; the numbers above are after that fix.

## Run it

Local, two nodes (practice mode):

```bash
npm run server:key -- alice            # prints the secret once, and a "hash:alice:trade" line
echo "<that line>" > /tmp/keys.txt
REDIS_URL=redis://127.0.0.1:6379 REDIS_REQUIRE_AOF=false API_KEYS_FILE=/tmp/keys.txt NODE_PUBLIC_URL=http://127.0.0.1:3601 PORT=3601 npm run server
REDIS_URL=redis://127.0.0.1:6379 REDIS_REQUIRE_AOF=false API_KEYS_FILE=/tmp/keys.txt NODE_PUBLIC_URL=http://127.0.0.1:3602 PORT=3602 npm run server
```

Docker (Redis with AOF and a password, three nodes, nginx on 127.0.0.1:8080): see the header of `deploy/server/docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | required | `redis://[:password@]host:6379`. No TLS client: keep Redis on a private network. |
| `NODE_PUBLIC_URL` | required | How the other nodes reach this one. Must be routable between nodes. |
| `API_KEYS_FILE` | required | Lines of `sha256hex:userId[:read\|trade]`. Plain keys are refused. |
| `PORT`, `HOST` | 3500, 127.0.0.1 | `HOST=0.0.0.0` in a container. |
| `NAMESPACE` | memedesk | Redis key prefix. One namespace per environment. |
| `LEASE_TTL_MS` | 15000 | Worst-case takeover time after a crash. Lower = faster failover, more renewals. |
| `MAX_USERS_PER_NODE` | 300 | A full node turns away unowned users with `503 no_capacity`. 300 is the most measured per node (load test below); raise it only after measuring your hardware. |
| `SWEEP_MS` | 2000 | How often a node looks for unowned users. |
| `RATE_PER_SECOND`, `RATE_BURST` | 20, 40 | Per key, **per node**. |
| `REDIS_REQUIRE_AOF` | true | Refuse a Redis without `appendonly yes`. |
| `SOLANA_SAMPLE_URL` | none | Serve the `/solana` test page from a running terminal (`apps/web`), to this machine only. |
| `PG_URL` | none | Optional Postgres for the stored trade history and audit log, e.g. `postgres://user:pass@host:5432/db?sslmode=require` (or `verify-full`). Tables are created on start. |
| `MAX_USERS_PER_APP` | 10000 | End users one app key may create (each is a separate account; section 4.6 of SDK_AND_API.md). |
| `PLATFORM_FEE_WALLET`, `PLATFORM_FEE_BPS` | none, 0 | The operator's fee on every real trade, paid in SOL inside the trade (0 to 100 bps; SDK_AND_API.md 4.8). |
| `APP_FEE_MAX_BPS` | 100 | The most an app may charge its users with `PUT /v1/app/fees`. |
| `WEBHOOKS_ALLOW_HTTP` | false | Local testing only: allow http and private hosts as webhook targets. |
| `JUPITER_API_KEY` | none | `MODE=solana-mainnet`: Jupiter's API key, sent as `x-api-key` on route building, quotes, SOL/USD and share prices. Without it the node is held to Jupiter's keyless rate limit (about one request every 2 seconds) across all its users. |
| `SOLANA_MAX_TRADE_SOL`, `SOLANA_DAILY_CAP_SOL` | `0.05`, `0.25` | `MODE=solana-mainnet`: the engine's SOL caps on buys, per user, per trade and per day (the daily cap must be at least the per-trade cap). The users' Privy policy limits plain SOL transfers separately (`sol-cap`, README → Solana policy rules). A normal Jupiter buy wraps its SOL with such a transfer, so a buy above that rule is refused by Privy whatever these caps say. A JupiterZ fill moves SOL inside the Order Engine and is limited by these caps alone. |
| `JUPITERZ` | `off` | `MODE=solana-mainnet`: `on` lets large trades take a JupiterZ market-maker (RFQ) fill when it beats the normal route (docs/JUPITERZ.md). The firm quote is checked by the RFQ gate, simulated, and for a stock held to the share-price check before the user's Privy wallet signs. Jupiter's `/execute` lands it, because the maker co-signs there. Needs the Order Engine program in the users' Privy policy (README → Solana policy rules); until then Privy refuses those signatures and the normal route runs. A trade that carries a platform fee (`PLATFORM_FEE_BPS` or an app fee) never uses RFQ, because the fee is paid in SOL inside the transaction and an RFQ transaction cannot carry it. Market makers quote stocks only from about $1,000, so `SOLANA_MAX_TRADE_SOL` must allow that size; the server refuses to start when `JUPITERZ_MIN_SOL` is above it. |
| `JUPITERZ_MIN_SOL` | `100` | With `JUPITERZ=on`: the smallest SOL side (SOL spent on a buy, the minimum SOL received on a sell) that asks market makers. |
| `JUPITERZ_MARGIN_BPS` | `20` | With `JUPITERZ=on`: how much more the firm quote must pay than the normal `/build` route, in basis points (0 to 1000). |
| `STOCKS_ENABLED` | off | `1` lets users of a `solana-mainnet` server **buy** tokenized stocks (SDK_AND_API.md 4.9). Off: stock buys fail with `stocks_disabled` 403; sells always work. No issuer offers these tokens to US persons: enable only behind your own eligibility checks. |
| `BASE_RPC_URL`, `PRIVY_BASE_POLICY_ID`, `BASE_MAX_TRADE_ETH`, `BASE_DAILY_CAP_ETH` | Alchemy, none, 0.01, 0.05 | `MODE=base-mainnet` (section above). |
| `RELAY_API_KEY`, `BASE_RELAY` | none, on | `MODE=base-mainnet`: Relay's API key (needed for production; Relay's docs say from 2 Oct 2026), and `BASE_RELAY=off` to trade only Uniswap V2 pools. |
| `BASE_AGGREGATOR`, `KYBER_CLIENT_ID` | relay, memedesk | `MODE=base-mainnet`: `kyberswap` routes tokens with no usable V2 pool through KyberSwap's router instead of Relay (gated and simulated the same way; the Privy Base policy needs `kyberswap-swaps` and `approve-kyberswap`, README → Base policy rules). `KYBER_CLIENT_ID` is sent as KyberSwap's `x-client-id`. |
| `CHAINS` | none | Several chains on one server, default first: `solana,base,bnb,robinhood` (section above). Wins over `MODE`. |
| `BNB_RPC_URL`, `PRIVY_BNB_POLICY_ID`, `BNB_MAX_TRADE_ETH`, `BNB_DAILY_CAP_ETH` | Alchemy, none, 0.02, 0.1 | `bnb` in `CHAINS` (section above; caps in BNB). |
| `ROBINHOOD_RPC_URL`, `PRIVY_ROBINHOOD_POLICY_ID`, `ROBINHOOD_MAX_TRADE_ETH`, `ROBINHOOD_DAILY_CAP_ETH` | Alchemy, none, 0.01, 0.05 | `robinhood` in `CHAINS`. |
| `ROBINHOOD_AGGREGATOR` | kyberswap | `robinhood` in `CHAINS`: `kyberswap` routes tokens with no usable V2 pool through KyberSwap (the Robinhood Privy policy needs the KyberSwap rules with chain id 4663), `off` trades V2 pools only. Relay does not serve this chain. |
| `MODE` | practice | `practice` (fake funds), `solana-mainnet` (real funds, Privy; needs the PRIVY_* settings and `SOLANA_RPC_URL` or `ALCHEMY_API_KEY`) or `base-mainnet` (real funds on Base, Privy Ethereum wallets; needs `PRIVY_BASE_POLICY_ID`). |

**API console:** every node serves `/console` (and `/`): paste an API key and use every API action from a page. Each response names the node that ran it
(`x-memedesk-node`), so forwarding is visible. The page holds no secrets; the key stays in the browser tab.

**Hardening from the 2026-11-17 review:** request targets must be paths (no `//host/...`, so forwarding can never be pointed at another host); the `/solana` link
needs a loopback peer AND a loopback `Host` (DNS rebinding) and nginx returns 404 for it and strips `x-memedesk-hop`; claims re-check their lease after starting and
abort during a drain; one Redis call per sweep (`MGET`) and per renewal round (one script for all leases); forwarded event streams close upstream when the client leaves;
a user re-claimed on the same node gets its event stream wired again.

Endpoints besides the API: `/healthz` (process up, and the chains served), `/readyz` (Redis reachable and not draining; use for load-balancer health), `/metrics` (Prometheus text:
users owned, requests, forwarded, forward errors, claims, leases lost, capacity refusals, chain accounts unavailable, draining). `nginx.conf` hides `/metrics` from the public entry: scrape each
node on the private network.

## Trade history, audit log and the status page

- **Postgres (`PG_URL`, optional):** `trades` (one row per trade, upserted as its state changes, with its fill), `trade_states` (every state it was seen in) and `audit_log`
  (every API call that changed something: account, key id, method, path, a summary of the body with secrets and signatures removed, status, duration, node).
  Written in batches every second by the node that served the call or runs the account, never on the trading path: if Postgres is slow or down, trading continues
  and records wait in a bounded buffer (10,000; the oldest are dropped beyond that, and counted). A crashed node loses its last unwritten second.
  The client (`packages/core/src/pg.ts`) has no dependencies: TLS (`sslmode=require` or `verify-full`), SCRAM-SHA-256, MD5 or cleartext passwords, parameters never interpolated.
- **Status page:** every node serves `/status` (HTML, refreshes every 15 s) and `/status.json`: Redis, the nodes (each writes a heartbeat every 5 s; a node not
  heard from for 15 s, or drained, leaves the list), Postgres with trades landed in the last hour, and in `MODE=solana-mainnet` reachability of the Solana RPC, Privy and
  Jito. It shows no user data, no secrets, and node addresses only as short hashes, so it can be public. Unlike `/metrics`, nginx can pass it through.
- **Verified** (`apps/server/records.test.ts` with `PG_TEST_URL`, two real nodes): stored trades and fills, the audit log without the webhook secret anywhere in
  the table, app-wide records, the status page with both nodes and then one after a drain, and a trade finishing while Postgres was paused, its record written once it
  was back. On the local validator (`verify:server-sol` with `PG_TEST_URL`, S16): a buy stored with the states it went through on the chain.

## The `/solana` sample page

With `SOLANA_SAMPLE_URL=http://127.0.0.1:3000`, a node serves the Solana terminal page at `/solana` and forwards its `/api/sol/*` calls to that terminal. It answers
**only requests from the same machine**; anything else gets 404. The terminal is a single-user session that can sign real-funds trades, so it must never be reachable
through the public load balancer. The link rewrites `Host`, and an `Origin` equal to the node's own address, to the terminal's, so the terminal's CSRF check still
applies: a request from any other origin is passed through unchanged and refused. Verified: the page renders through the node, and a "Use trading key" click on it
reached the live terminal. Privy sign-in from `127.0.0.1:3500` may be refused if that origin is not in the Privy app's allowed origins (not tested).

## What is not done (read before trusting it with money)

- **Real accounts: Solana and Base.** `MODE=solana-mainnet` (above): local validator, plus small mainnet buys. `MODE=base-mainnet`: a local Base fork with a Privy stand-in, plus one 0.0002 ETH mainnet buy (tx `0x431b6a…`). Orders, failover and sells through the server have not run on mainnet. Base is limited to Uniswap V2 pools plus Relay or KyberSwap, with no token safety check and no fee sharing; BNB Chain and Robinhood Chain to their V2 pools, local forks only so far. `PLATFORM_FEE_BPS` with `CHAINS` charges Solana trades only.
  Server-held hot keys in files are not production custody.
- **Postgres is a record, not the source of truth.** Redis holds running accounts; with `PG_URL`, trades and an audit log are copied to Postgres in the background (below). Run it with AOF (`appendfsync everysec` loses at most about a second of state on a Redis
  crash) and back it up. No TLS to Redis, no Sentinel or Cluster support in the client.
- **Rate limits are per node**, not cluster-wide. With app keys the limit is per end user.
- **Webhooks are best effort:** retried in memory (2 s, 10 s, 60 s) by the node that runs the end user; lost if that node stops before delivery. Every registered end user is
  claimed by the sweep like any user, so many idle end users cost node capacity (MAX_USERS_PER_NODE) even without orders.
- **Redis calls are synchronous** (they block the node's event loop for each call: sub-millisecond on a LAN). Very large user counts per node need measuring.
- **Key rotation** means editing `API_KEYS_FILE` on every node and rolling them. No key management API.
- **TLS** is the load balancer's job; the nodes speak plain HTTP on the private network.
- **Practice balances** are not durable: a user's simulated world is rebuilt with fresh fake funds on the node that takes it over. Orders and the trade journal are durable.
- Load-tested on one machine with a local Redis only (throughput section above); nothing above 300 users per node or with a networked Redis has been measured.
