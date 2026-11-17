# Production execution server (`apps/server`)

A standalone, horizontally scalable server for the SDK. It runs the same HTTP API as `apps/api` (every route calls a `Trader` method; see `docs/SDK_AND_API.md`),
but as a **cluster of identical nodes** that share one Redis. Add nodes to serve more users; lose a node and its users move to the others.

Status: the cluster mechanics (ownership, routing, failover, durability of orders) are built and tested, including in Docker. The only built-in account mode is
**practice** (simulated chain, fake funds). Real-chain accounts need a signer and key custody that this repository does not have; see "What is not done".

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
| Unit and cluster tests (`apps/server/server.test.ts`, real nodes on real ports, local Redis) | 7 of 7 pass: single-owner leases, fail-closed write after a lost lease, AOF refusal, forwarding, crash failover with orders restored, drain handover, per-node cap, `/solana` sample link |
| Two node processes via `main.ts` | request on the non-owner forwarded; order placed through it; SIGTERM on the owner: the other node owned the user at once, order still active with its chase settings; `PATCH` edit worked on the new owner; no lease left behind |
| Docker: Redis (AOF) + 3 nodes + nginx (`deploy/server`) | requests through the load balancer reached the owner; `docker stop` of the owner: next request answered by a new owner in **1 s**; `SIGKILL` of the next owner: answered after **15 s** (= `LEASE_TTL_MS`); the order stayed active throughout |

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
| `MAX_USERS_PER_NODE` | 500 | A full node turns away unowned users with `503 no_capacity`. |
| `SWEEP_MS` | 2000 | How often a node looks for unowned users. |
| `RATE_PER_SECOND`, `RATE_BURST` | 20, 40 | Per key, **per node**. |
| `REDIS_REQUIRE_AOF` | true | Refuse a Redis without `appendonly yes`. |
| `SOLANA_SAMPLE_URL` | none | Serve the `/solana` test page from a running terminal (`apps/web`), to this machine only. |
| `MODE` | practice | Only `practice` is built in. |

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

- **No real-chain accounts.** `accounts.ts` builds practice accounts only. A real deployment needs a factory over `EvmRpcChain` / `SolanaChain` and a signer with real key
  custody (HSM, KMS or MPC). Server-held hot keys in files are not production custody.
- **No Postgres.** Redis is the only store and the single source of truth. Run it with AOF (`appendfsync everysec` loses at most about a second of state on a Redis
  crash) and back it up. No TLS to Redis, no Sentinel or Cluster support in the client.
- **Rate limits are per node**, not cluster-wide.
- **Redis calls are synchronous** (they block the node's event loop for each call: sub-millisecond on a LAN). Very large user counts per node need measuring.
- **Key rotation** means editing `API_KEYS_FILE` on every node and rolling them. No key management API.
- **TLS** is the load balancer's job; the nodes speak plain HTTP on the private network.
- **Practice balances** are not durable: a user's simulated world is rebuilt with fresh fake funds on the node that takes it over. Orders and the trade journal are durable.
- Not load-tested; the numbers above are correctness and failover checks, not throughput.
