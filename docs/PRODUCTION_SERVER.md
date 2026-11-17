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

Verified (`npm run verify:server-sol`, report in `docs/live-verification/`, 10 of 10): linking through one node; a market buy in plain units sent to the non-owner node, forwarded,
signed by the Privy stand-in and landed; the same idempotency key not trading twice; the per-trade cap; a limit order surviving a crash of the owner node, the other node
asking Privy again, the order edited there and firing by itself; a sell of half the holding in plain units; a compute-unit limit from simulation and a capped priority fee on the landed buy; and a revoked signer failing with nothing sent. `apps/server/realmode.test.ts` covers linking, refusals
and failover without a chain.

**Mainnet, 2026-11-17 (user-approved):** two nodes in `MODE=solana-mainnet`; the user linked their Privy wallet from the `/solana` page's Execution server box (served by a node, same origin
as the API) and bought 0.005 SOL of Bonk through the API in plain units. Routed through Jupiter, signed by real Privy under the app's policy, finalized as tx
`3zMawgRFnseC1daidQZMQarkmFvqHS6scJu5qgCeNAdwUhj95E8ee2SBv1FhTZbXSbWdoUDmwj9Py7dbvQ8tpQ8G` (wallet paid 0.005009668 SOL, received 154,813.93 Bonk).

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
| `MODE` | practice | `practice` (fake funds) or `solana-mainnet` (real funds, Privy; needs the PRIVY_* settings and `SOLANA_RPC_URL` or `ALCHEMY_API_KEY`). |

**API console:** every node serves `/console` (and `/`): paste an API key and use every API action from a page. Each response names the node that ran it
(`x-memedesk-node`), so forwarding is visible. The page holds no secrets; the key stays in the browser tab.

**Hardening from the 2026-11-17 review:** request targets must be paths (no `//host/...`, so forwarding can never be pointed at another host); the `/solana` link
needs a loopback peer AND a loopback `Host` (DNS rebinding) and nginx returns 404 for it and strips `x-memedesk-hop`; claims re-check their lease after starting and
abort during a drain; one Redis call per sweep (`MGET`) and per renewal round (one script for all leases); forwarded event streams close upstream when the client leaves;
a user re-claimed on the same node gets its event stream wired again.

Endpoints besides the API: `/healthz` (process up), `/readyz` (Redis reachable and not draining; use for load-balancer health), `/metrics` (Prometheus text:
users owned, requests, forwarded, forward errors, claims, leases lost, capacity refusals, draining). `nginx.conf` hides `/metrics` from the public entry: scrape each
node on the private network.

## The `/solana` sample page

With `SOLANA_SAMPLE_URL=http://127.0.0.1:3000`, a node serves the Solana terminal page at `/solana` and forwards its `/api/sol/*` calls to that terminal. It answers
**only requests from the same machine**; anything else gets 404. The terminal is a single-user session that can sign real-funds trades, so it must never be reachable
through the public load balancer. The link rewrites `Host`, and an `Origin` equal to the node's own address, to the terminal's, so the terminal's CSRF check still
applies: a request from any other origin is passed through unchanged and refused. Verified: the page renders through the node, and a "Use trading key" click on it
reached the live terminal. Privy sign-in from `127.0.0.1:3500` may be refused if that origin is not in the Privy app's allowed origins (not tested).

## What is not done (read before trusting it with money)

- **Real accounts: Solana only.** `MODE=solana-mainnet` (above): local validator, plus one small mainnet buy. Orders, failover and sells through the server have not run on mainnet. EVM still has no real signer.
  Server-held hot keys in files are not production custody.
- **No Postgres.** Redis is the only store and the single source of truth. Run it with AOF (`appendfsync everysec` loses at most about a second of state on a Redis
  crash) and back it up. No TLS to Redis, no Sentinel or Cluster support in the client.
- **Rate limits are per node**, not cluster-wide.
- **Redis calls are synchronous** (they block the node's event loop for each call: sub-millisecond on a LAN). Very large user counts per node need measuring.
- **Key rotation** means editing `API_KEYS_FILE` on every node and rolling them. No key management API.
- **TLS** is the load balancer's job; the nodes speak plain HTTP on the private network.
- **Practice balances** are not durable: a user's simulated world is rebuilt with fresh fake funds on the node that takes it over. Orders and the trade journal are durable.
- Load-tested on one machine with a local Redis only (throughput section above); nothing above 300 users per node or with a networked Redis has been measured.
