# SDK and Execution API

Date: 2026-11-17. This document covers the TypeScript SDK (`packages/sdk`), the HTTP API (`apps/api`), what chains and platforms are supported **today**, what happens in the backend when you send an order, and every parameter that controls execution.

**Read this first.** Everything here has been run on a **practice chain** (a simulator in this repo, fake funds). The SDK and the HTTP API have also been run end to end on a **local fork of Ethereum mainnet** (14/14 checks) and on a **local Solana validator** with the mainnet SOL/USDC Raydium pool cloned (13/13 checks); those harnesses and reports are in git tag `v0.1.0-full-platform`. The `/solana` test UI runs the SDK engine and Trader on Solana mainnet with small real amounts, including orders signed by the user's own Privy wallet while the page is closed (`PrivySolSigner`, section 4.4; `KNOWN_LIMITATIONS.md`). The execution server also has a real Solana mode (section 4.5 A), verified on a local validator. See [Supported chains](#2-supported-chains) for the exact level of evidence per chain.

---

## 1. What you get

| Piece | What it is | Where |
|---|---|---|
| **Engine** | The execution core: validates, quotes, simulates, signs (under wallet policy), sends and tracks every trade, crash-safe and idempotent. | `packages/core` |
| **Trader (SDK)** | One TypeScript object exposing the whole engine: market buy/sell, limit buy/sell, take profit, stop loss, trailing stop, bracket, bulk buy/sell, TWAP, sniping, copy trading, price alerts, portfolio, pause. | `packages/sdk/src/trader.ts` |
| **Client (SDK)** | The same method names over HTTP, for programs that do not run the engine themselves. | `packages/sdk/src/client.ts` |
| **HTTP API** | JSON over HTTP with API keys, rate limits, an event stream and an OpenAPI document. | `apps/api` |
| **Execution server, Solana test UI** | A horizontally scalable cluster server for the API (`docs/PRODUCTION_SERVER.md`) and the `/solana` real-funds test page. Both sit on the same engine. | `apps/server`, `apps/web` |

The SDK adds **no trading logic**. Every order, bulk leg, TWAP slice, snipe and copy trade becomes an ordinary engine *intent*, so the same safety rules apply to all of them (section 5).

### Feature coverage

| Feature | SDK method | HTTP route | Notes |
|---|---|---|---|
| Quote | `quote` | `POST /v1/quote` | Nothing is sent. |
| Market buy / sell | `buy`, `sell` | `POST /v1/trades/buy`, `/sell` | Sell by amount or by percentage of balance. |
| Limit buy | `limitBuy` | `POST /v1/orders/limit-buy` | Trigger order, see 6.2. |
| Limit sell | `limitSell` | `POST /v1/orders/limit-sell` | |
| Take profit | `takeProfit` | `POST /v1/orders/take-profit` | |
| Stop loss | `stopLoss` | `POST /v1/orders/stop-loss` | |
| Trailing stop | `trailingStop` | `POST /v1/orders/trailing-stop` | |
| Bracket (TP + SL + trailing, one wins) | `bracket` | `POST /v1/orders/bracket` | OCO group: tokens reserved once. |
| Market-cap trigger | `marketCap` on any price order | same | Disabled with a reason if supply is unknown. |
| Cancel / list / inspect orders | `cancelOrder`, `listOrders`, `getOrder`, `orderStatus` | `DELETE/GET /v1/orders` | |
| Bulk buy / bulk sell (up to 10 wallets) | `bulkBuy`, `bulkSell` | `POST /v1/bulk/buy`, `/sell` | Equal split, exact legs, or % of balance. |
| TWAP (2 to 100 slices) | `twap`, `twapStatus`, `cancelTwap` | `POST/GET/DELETE /v1/twap` | |
| Launch sniping | `addSnipe` | `GET/POST /v1/snipes` | Needs a launch source you supply (see 7.4). |
| Copy trading | `addCopy` | `GET/POST /v1/copies` | Needs a leader source you supply (see 7.4). |
| Price alerts | `addPriceAlert` | `POST/DELETE /v1/alerts` | Delivered as events. |
| Positions, P&L, history | `positions`, `history` | `GET /v1/positions`, `/history` | Unknown cost basis stays unknown. |
| Pause new buys | `pauseEntries`, `resumeEntries` | `POST /v1/entries/pause`, `/resume` | Sells are never blocked. |
| Unstick a wallet | `cancelStuck` | `POST /v1/wallets/:id/cancel-stuck` | No-op nonce replacement. |
| Live events | `on` | `GET /v1/events` (SSE) | trade, order, bulk, twap, snipe, alert, error. |

**Not in the SDK or API:** creating or importing wallets, withdrawals, bridging, subscriptions and billing. Some exist in `packages/core` but are only tested on the simulator and are not exposed here on purpose. Key custody is the host's job (section 9).

---

## 2. Supported chains

Support means a **chain port** (`ChainPort`) implementation plus a **venue** (a pool model). Evidence level is the highest check that was actually run. Source of truth: [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md) and [live-verification/](live-verification/).

| Chain | Venue | Port | Evidence | Trade on real money? |
|---|---|---|---|---|
| **Practice chain** (`sim-evm`) | Constant-product pool (Uniswap-V2 style) and a bonding-curve model | `SimChain` | Locally tested, all features | No (fake funds). This is what the API serves out of the box. |
| **Ethereum** | Uniswap V2 (WETH/USDC verified) | `EvmRpcChain` | Mainnet **read-only** verified (quotes, simulated buy leg). **Fork tested, including the SDK and HTTP API** (quote equals the router's `getAmountsOut`; market buy and sell over HTTP, idempotent retry, per-tx policy refusal, limit buy and sell, stop loss, bracket, trailing stop, bulk buy, TWAP, pause, restart):  buy, sell with automatic exact-amount approval, limit/TP/SL/bracket/trailing orders, bulk, TWAP, copy, sniping, restart and crash recovery, lost acknowledgements. | **Not done.** No funded mainnet wallet was ever used. |
| **Solana** | Raydium AMM v4 (SOL/USDC); Jupiter Swap API routes | `SolanaChain` | Mainnet **read-only** verified (pool decode, quote, simulated swap). **Local validator tested** (pool cloned from mainnet): swap, orders, copy, sniping, bulk, and the **SDK and HTTP API** (quote equals the venue's quote; market buy and sell, idempotent retry, per-tx policy refusal, limit buy and sell, stop loss, bracket, trailing stop, bulk buy, TWAP, pause, restart). Jupiter execution: run on a local validator with cloned Raydium routes only; no devnet or mainnet execution. | **Not done.** |
| Ethereum | Uniswap V3 | none | Not implemented | No |
| BNB Chain, Arbitrum, Avalanche, Sonic, Monad | PancakeSwap, Camelot, Trader Joe, others | none | Not implemented. A Uniswap-V2-style pool on another EVM chain would work with `EvmRpcChain` in principle, but no such chain has been run, and chain ids, routers and tokens are not recorded in this repo. | No |
| Base, Robinhood Chain | | none | Deferred: addresses and ids not supplied yet. | No |
| TON, Tron | | none | Only standalone family simulators exist; not wired to the engine. | No |

**What "fork tested" means:** a local node (anvil, or a Solana test validator) started from a copy of mainnet state, with throwaway keys and fake balances. It exercises real contract code and real pool math. It does not prove behaviour under real mempool competition, MEV, real gas markets or real fills.

**Pool models not supported yet:** concentrated liquidity (V3, Raydium CLMM, Orca whirlpools), DLMM (Meteora), stable pools, multi-hop routes. A token whose only liquidity is in one of those cannot be traded.

---

## 3. Supported platforms

| Item | Status |
|---|---|
| **Runtime** | Node.js 22. Zero npm dependencies in the core, SDK, API and server. |
| **OS** | Developed and tested on macOS. Linux should work (no native code), but it has **not** been run there. Windows is untested. |
| **Language** | TypeScript source, run directly with `node --experimental-transform-types`. There is no build step and no published npm package yet. |
| **Interfaces** | TypeScript SDK (in process), HTTP/JSON API with an OpenAPI 3 document, server-sent events, Telegram bot, web terminal. |
| **Not provided** | Browser extension, mobile app, Python/Go clients (generate one from `GET /v1/openapi.json`), published container image (`deploy/` and `docker-compose.yml` are unvalidated templates). |
| **State storage** | Files (atomic write) by default, Redis optional (single-writer lock with fencing). Postgres is a schema template only. |

---

## 4. Quick start

### 4.1 Run the practice API

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # make a key
API_KEYS="<that key>:alice" npm run api                                     # keys: key:user[:read|trade]
```

Each user gets a practice account with wallets `w1` and `w2`, token `0xMEME`, and fake funds. The server listens on `127.0.0.1:3500`. Do not expose it without TLS in front.

```bash
KEY=<your key>
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"side":"buy","token":"0xMEME","amount":"10000"}' http://127.0.0.1:3500/v1/quote

curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: my-first-buy" \
  -d '{"walletId":"w1","token":"0xMEME","amount":"10000","slippageBps":300}' http://127.0.0.1:3500/v1/trades/buy
```

### 4.2 Use the client

```ts
import { MemeClient } from './packages/sdk/src/index.ts';
const api = new MemeClient({ baseUrl: 'http://127.0.0.1:3500', apiKey: process.env.KEY! });

const buy = await api.buy({ walletId: 'w1', token: '0xMEME', amount: 10_000n, slippageBps: 300, key: 'my-first-buy' });
console.log(buy.state, buy.fill);            // 'finalized', { spent, received, platformFee, ... } (amounts are strings)

await api.bracket({ id: 'exit-1', walletId: 'w1', token: '0xMEME', amount: 5_000n,
  takeProfitE18: '2000000000000000000', stopLossE18: '850000000000000000' });   // sell at 2.0 or at 0.85, whichever hits first
await api.twap({ id: 'dca-1', walletId: 'w1', token: '0xMEME', side: 'buy', total: 30_000n, slices: 6, intervalS: 600 });
await api.events(e => console.log(e));       // live trade, order, twap events
```

### 4.3 Use the engine in process (no HTTP)

```ts
import { createSimTrader } from './packages/sdk/src/index.ts';
const { trader } = createSimTrader({ userId: 'u1' });
trader.start(1000);                                                   // drive orders, bulk, TWAP once a second
trader.on(e => console.log(e));
await trader.buy({ walletId: 'w1', token: '0xMEME', amount: 10_000n });
await trader.trailingStop({ walletId: 'w1', token: '0xMEME', amount: 4_000n, trailBps: 1000 });   // sell if price drops 10% from its peak
```

To run against a **real or forked chain**, build the `Engine` the way `apps/web/solmainnet.ts` does for Solana (`SolanaChain` + signer + `PolicySigner`; `EvmRpcChain` for EVM) and pass it to `new Trader({ engine, chain, userId, venues: ['uniswap-v2'], persistDir })`. The Trader has been run end to end over `EvmRpcChain` on a mainnet fork and over `SolanaChain` on a local validator (section 2).

### 4.4 Signers (who signs a Solana transaction)

`SolanaChain` takes any `SolSigner` (`sign(wallet, message) → 64-byte signature`). The engine builds, sends and confirms the transaction itself; the signer only signs.

| Signer | Key held by | Signs orders without the user present | Use |
|---|---|---|---|
| `DevSolSigner` | this process (memory) | yes | tests, local validator, the `/solana` trading key |
| `RemoteSolSigner` | the user's browser wallet | no: each request waits for the wallet | `/solana` wallet sign-in |
| `PrivySolSigner` | Privy (TEE), the user's own wallet | yes, within a Privy policy the user agreed to | `/solana` automatic trading; verified on mainnet |

```ts
import { PrivyApi, PrivySolSigner, SolanaChain, SolJsonRpc } from 'memedesk-sdk/sol';
const api = new PrivyApi({ appId, appSecret, authKey, signerId, policyId });   // values from the Privy dashboard (README → Custody plan)
const d = await api.delegation(userAddress);          // the user must have added signerId with policyId to their wallet (browser: useSigners().addSigners)
if (!d.ok) throw new Error(d.why);                     // also refuses a policy with no ALLOW rule for the method signTransaction
const chain = new SolanaChain(cfg, new SolJsonRpc(rpcUrl), new PrivySolSigner(api, new Map([[userAddress, d.walletId]])));
```

`PrivySolSigner` calls Privy's `signTransaction` with an authorization signature (P-256 over RFC 8785 JSON), and accepts the result only if the signature verifies for the
exact message the engine built. A policy refusal, a revoked signer or an unreachable Privy fails the trade with `... nothing was sent`. Keep `PolicySigner` in front of it:
Privy's policy limits programs and SOL per transfer, while `PolicySigner` keeps the per-trade and daily caps and the automation switch.

### 4.5 Real Solana accounts: two ways for a client

**A. Hosted: call our execution server** (`MODE=solana-mainnet`, docs/PRODUCTION_SERVER.md). The client runs nothing of ours.
1. Get an API key from the operator (`npm run server:key -- <user>`).
2. In the client's frontend, after Privy login, allow the server once: `useSigners().addSigners({ address, signers: [{ signerId, policyIds: [policyId] }] })`. The operator
   publishes `signerId` (`PRIVY_AUTH_KEY_ID`) and `policyId` (`PRIVY_SOLANA_POLICY_ID`); the client's Privy app must be the operator's Privy app.
3. Link the wallet to the API key: `POST /v1/wallet/link/start {address}` returns a message; sign it with the Privy wallet (`useSignMessage`); `POST /v1/wallet/link/finish
   {address, signature}` (base64). `GET /v1/wallet` then shows `active: true`.
4. Trade in plain units (the linked wallet is the default; raw fields such as `amount`, `priceE18`, `walletId` still work and win):

```ts
const api = new MemeClient({ baseUrl, apiKey });
await api.swap({ side: 'buy', mint, sol: '0.01', slippagePct: 3, key: 'buy-1' });          // same key again never trades twice
await api.swap({ side: 'sell', mint, pct: 50 });                                            // half the holding
await api.placeOrder({ type: 'limit-buy', mint, sol: '0.01', priceUsd: '0.0000023' });      // fires by itself, also while the client is offline
await api.placeOrder({ type: 'bracket', mint, pct: 100, tpUsd: '0.00001', slUsd: '0.000001' });
await api.placeOrder({ type: 'trailing-stop', mint, tokens: '150000', trailPct: 15 });
```

   Over plain HTTP: `POST /v1/trades/buy {"mint":"...","sol":"0.01"}`. Plain fields: `mint`, `sol`, `tokens`, `pct`, `price` (SOL per token), `priceUsd`, `slippagePct`,
   `trailPct`, `tpUsd`, `slUsd`. `pct` on a sell order is taken from the balance when the order is placed.
5. To stop: `DELETE /v1/wallet`, or `removeSigners({ address })` in the frontend (Privy then refuses every signature at once).

**B. Embedded: run the SDK in the client's own backend** (the client operates its own Privy app and its own server).
1. In the Privy dashboard: TEE wallets, an authorization key, and a Solana policy with its rules on method `signTransaction` (README → Custody plan, steps 1 to 5).
2. `npm install memedesk-sdk-0.1.0.tgz` (see "Use the SDK outside this repo").
3. Frontend: the same `addSigners` call as A.2, with the client's own `signerId` and `policyId`.
4. Backend, once per user (keep it running; on restart do the same again, state comes back from `persistDir`):

```ts
import { createSolanaTrader } from 'memedesk-sdk';
const s = await createSolanaTrader({ userId: 'u1', address: userWallet, rpcUrl: SOLANA_RPC_URL, persistDir: `state/u1`,
  privy: { appId, appSecret, authKey: PRIVY_AUTH_PRIVATE_KEY, signerId: PRIVY_AUTH_KEY_ID, policyId: PRIVY_SOLANA_POLICY_ID } });
if (!s.active) console.warn(s.why);                       // not allowed in Privy (yet): reads work, trades are refused with this reason
await s.trader.resume(); s.trader.start(2000);           // restored orders keep firing
await s.prepare(mint); await s.sync();                    // learn the token, then read the chain's clock and pools, before a market trade
await s.trader.buy({ walletId: userWallet, token: mint, amount: 5_000_000n, slippageBps: 300, key: 'buy-1' });   // 0.005 SOL; same key never trades twice
await s.prepare(mint); await s.trader.limitBuy({ walletId: userWallet, token: mint, amount: 5_000_000n, priceUsd: '0.0000023' });
s.trader.on(e => console.log(e));
```

### 4.6 Apps: one key for many users, and webhooks

An app with many users holds **one app key** (`npm run server:key -- <appId> app`, key file line `hash:<appId>:app`) and names the end user on every call in the
`X-User-Id` header (1 to 64 letters, digits, dot, dash, underscore). Each end user is a separate account, `<appId>:<userId>`, with its own orders, trades, wallet link,
settings, rate limit (per end user) and failover; one end user can never see another's. End users are created on their first call, up to `MAX_USERS_PER_APP`
(default 10,000).

```ts
const app = new MemeClient({ baseUrl, apiKey: APP_KEY });
const alice = app.forUser('alice');                        // or new MemeClient({ baseUrl, apiKey: APP_KEY, userId: 'alice' })
await alice.swap({ side: 'buy', mint, sol: '0.01' });
const { secret } = await app.setAppWebhook('https://api.yourapp.com/hooks/memedesk');   // the secret is shown once
```

**Webhooks:** every event of every end user (trade, order, bulk, TWAP, alert) is POSTed to the app's URL as
`{ id, type, appId, userId, at, data }`, signed `x-memedesk-signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, with `x-memedesk-event-id`
(the same on retries: deduplicate on it). Verify with `verifyWebhook(secret, rawBody, header)` from the SDK (it also refuses deliveries older than 5 minutes).
A non-2xx answer or timeout is retried after 2 s, 10 s and 60 s. Delivery is best effort while the node runs: retries still waiting when a node stops are lost, so
treat webhooks as notifications and read state through the API. Only https URLs to public hosts are accepted. `POST /v1/app/webhook/test` sends a signed `ping`.

**Priority fees** are on by default (`priority` option; `false` turns them off). Each transaction gets a compute-unit limit from a simulation (units used × 1.2, as
Jupiter's compute-unit guide recommends; Jupiter's `/build` sets no limit, so the fee would otherwise be charged on up to 1.4M units) and a price from Solana's
`getRecentPrioritizationFees` for the accounts the trade writes: the 75th percentile, at least 10,000 micro-lamports per unit, and never more than 0.0001 SOL in total per
transaction. Tune with `priority: { percentile, minMicroLamports, maxLamports }`.

**MEV protection** (off by default; each protected trade pays a small Jito tip). On, a trade is sent privately to Jito's block engine (`sendTransaction` with
`bundleOnly=true`: never broadcast publicly by Jito, all-or-nothing, a failing trade pays no tip), with a tip from Jito's live tip floor (75th percentile, at least 1,000
lamports, at most `maxTipLamports`, default 0.0001 SOL) and the `jitodontfront` flag that asks the block engine to keep it first in its bundle. Jito: this "may help reduce
sandwich attacks but is not guaranteed". It works on Jupiter and pump.fun trades; your minimum output (slippage) still bounds the worst case.

- **Per account:** `createSolanaTrader({ ..., mevProtection: true })`, or `{ enabled, maxTipLamports, tipPercentile, jito: { url /* region */, uuid } }`.
  Over the API (server in `MODE=solana-mainnet`): `PATCH /v1/settings {"mevProtection": true, "maxTipSol": "0.0001"}` (`maxTipSol` at most 0.001), `GET /v1/settings`;
  client: `api.updateSettings({ mevProtection: true })`.
- **Per trade, overrides the account setting:** `mevProtection: true | false` on any trade or order: `api.swap({ side: 'buy', mint, sol: '0.01', mevProtection: true })`,
  `api.placeOrder({ type: 'stop-loss', mint, pct: 100, priceUsd: '0.000002', mevProtection: true })`, or `trader.buy({ ..., mevProtection: true })`.
  An order applies it to every fill attempt. TWAP and bulk follow the account setting.
- **Limits:** Jito allows 1 request per second per IP by default; every block-engine call in one process is spaced to respect it, so many users on one node queue up
  (a custom limit from Jito, passed as `jito.uuid`, lifts it). A rebroadcast after a skipped block can still expose a transaction (Jito: "uncled blocks").

Defaults: Jupiter and pump.fun only, at most 0.05 SOL per buy and 0.25 SOL of buys per day (`caps` lowers or changes them), sells of held tokens not capped in SOL, SOL/USD
from a Jupiter quote (`solUsd` replaces it). For many users in one process, share one `PrivyApi` and one `jupiterSolUsd()` across them.

---

## 5. How it works in the backend

### 5.1 The path of one request

```
HTTP request
  -> API: key check (SHA-256, constant time), scope check, rate limit, 256 KB cap, strict validation
  -> Trader: turns it into an Intent (exact bigint amounts, venues you allowed, deadline, slippage)
  -> Engine: the state machine below, one record per idempotency key, checkpointed after every step
  -> ChainPort: simulate, build and sign, submit, look up, receipt
  -> your wallet policy signer: allow or refuse (limits, venues, automation switch)
```

### 5.2 The trade state machine

Every trade is a record that moves through these states. The record is written to storage **after every step**, and the signed transaction is stored **before** it is sent (write-ahead), so a crash at any point resumes instead of repeating.

| State | What happened |
|---|---|
| `created` | Intent accepted. Checks: amount > 0, slippage 0 to 5000 bps, deadline in the future, platform fee within `maxFeeBps`. |
| `validated` | Pool state refreshed. |
| `quoted` | The router asked every venue you authorised and picked the best output. `minOut` is fixed here (5.3). If a sell needs a token allowance, the engine runs it first as its own tracked child transaction for the **exact amount** (never unlimited). |
| `simulated` | The real swap was dry-run (`eth_call` / `simulateTransaction`). A revert here fails the trade before anything is signed or spent. |
| `awaiting_authorization` | The wallet nonce is allocated: the higher of the chain's confirmed nonce and the locally allocated one. |
| `signed` | The policy signer approved (5.4) and the transaction was built and signed. **Persisted before sending.** |
| `submitted` | Sent to the node. If the acknowledgement is lost, the engine looks the same hash up and re-sends identical bytes only if the node does not know it. |
| `observed` | In the mempool or included in a block. |
| `confirmed` | Receipt found. The **fill is computed from the receipt's balance changes**, not from the quote. |
| `finalized` | Enough confirmations (`finalityDepth`: 3 on the EVM port, 32 on Solana). Only now does the trade count as final. If a reorg changes or drops the receipt, the record goes back to `unresolved` and the fill is recomputed. |
| `failed` | Refused by policy, reverted in simulation, reverted on chain, or rejected by the node. `failure` says why. |
| `expired` | Deadline passed and the transaction was never found on chain. |
| `unresolved` | Waiting to reconcile (lost ack, reorg). The engine retries; call `advance(key)` to push it. |

A reverted transaction still costs gas, and the daily-limit charge is **kept** (fail closed). A transaction that can never land (rejected, expired and absent, nonce taken by another transaction) has its limit charge **released**.

### 5.3 Slippage, minimum output and price protection

- `slippageBps` is the largest drop in output you accept between the quote and execution. **Default 300 (3%)**, allowed 0 to 5000.
- At quote time: `derived = bestQuote.amountOut x (10000 - slippageBps) / 10000`.
- `minOut = max(your minOut, derived)`. **It can only be tightened, never loosened.**
- `minOut` is enforced **on chain** as the swap's minimum-output argument. If the price moved too far, the transaction **reverts and no tokens are spent** (you pay gas only). This is the real protection; the simulation before it is only an early warning.
- Retries never widen slippage. An order that fails retries with the **same** limits, up to `maxAttempts`.
- **Taxed tokens:** `fill.shortfall = quotedOut - received` shows transfer tax and drift. Use a higher slippage (or `minOut: 0` plus a tax check) knowingly: tax tokens deliver less than the pool quote by design.
- **Fees:** the platform fee (`platformFeeBps` on the engine, set by whoever runs it; the practice server uses 100 = 1%) is taken from `amountIn` and the pool is quoted on the **net** amount. `maxFeeBps` (default 200) is a cap: if the fee schedule exceeds it, the trade fails before signing. The pool's own fee is shown as `fill.venueFee`, the gas as `fill.networkFee`. Platform and venue fees are never merged.
- **Deadline:** `deadlineS` (default 120, 10 to 3600) is chain-time seconds. A transaction that is still unseen after it is marked `expired`.

### 5.4 Wallet policy (what can stop a trade)

The policy signer is a separate component the engine must pass through before any signature. Per wallet it enforces: allowed chains, allowed venues, **per-transaction cap and daily cap per token**, an **automation switch** (revoking it blocks every non-manual origin: orders, bulk, TWAP, snipe, copy), and for transfers a destination allowlist plus an out-of-band device confirmation. A wallet belongs to one user; another user's request for it is refused. Every decision is audited.

> The policy check itself is an in-process stand-in (an HMAC, not a security boundary). The key that signs is separate: for Solana it can be the user's own Privy wallet
> (`PrivySolSigner`, section 4.4), where Privy enforces its own policy as well. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) (Security).

### 5.5 Idempotency (why retrying is safe)

Every economic action has a deterministic key. The same key never creates a second execution, including across restarts.

| Action | Key |
|---|---|
| Market trade | the `Idempotency-Key` header (API stores it as `<user>.<key>`) or the `key` option; random if omitted |
| Order attempt | `order:<orderId>:a<attempt>` |
| Bulk leg | `bulk:<bulkId>:<walletId>` |
| TWAP slice | `twap:<twapId>:<n>` |
| Approval child | `<tradeKey>:approve` (and `:reset:approve` for tokens that need a reset) |

Sending the same `id` for an order, bulk or TWAP twice returns the existing one. **Always send your own id or Idempotency-Key** so a network retry cannot trade twice.

### 5.6 Multi-tenant isolation (API)

Every id you send is stored as `<userId>.<id>` and responses show the stored id. You can only read, cancel or advance ids under your own prefix; anything else answers `404`, exactly like a missing id. Event streams are per user. Two users sending the same id never collide.

---

## 6. How each order type executes

### 6.1 The order loop

Orders are **not** resting on-chain orders. They are watched by the engine and become a normal market swap when their condition is met. On each tick (every second in `start()`):

1. Refresh pool state from the chain.
2. For every active order, build a **snapshot**: spot price from the best authorised venue, its liquidity, the time the data was read, and the **executable output** for the order's exact size.
3. Evaluate. An order fires only if **all** hold:
   - not expired (`ttlS`, default 7 days);
   - the snapshot is **fresh** (`maxQuoteAgeMs`, default 15 000);
   - liquidity is at least `minLiquidity`;
   - the price condition is met;
   - the **executable output** is at least `amount x triggerPrice x (1 - maxDeviationBps/10000)`. This stops an order from firing on a thin or manipulated price it could not actually get.
4. Mark it `fired` (write-ahead checkpoint), put the intent in an outbox, hand it to the engine under key `order:<id>:a<n>`.
5. Report the result back: finalized releases the reservation; failure retries with the same limits until `maxAttempts` (default 3), then `failed`. With **chase** (6.5) each retry adds slippage up to a cap; without it, slippage never widens.

Before step 3, orders with a **USD trigger** (6.6) get their quote-token trigger re-derived from the current quote/USD price.

The order **reserves** its balance when placed (buys reserve the quote budget, sells reserve the tokens), so two strategies cannot spend the same funds. Placing fails with `order_refused` if the unreserved balance is too small.

### 6.2 Order kinds

| Kind | Condition (price = quote token per token) | Executes |
|---|---|---|
| `limit_buy` | price <= `priceE18` | market buy of `amount` (quote budget) |
| `limit_sell` | price >= `priceE18` | market sell of `amount` tokens |
| `take_profit` | price >= `priceE18` | market sell |
| `stop_loss` | price <= `priceE18` | market sell |
| `trailing_stop` | price <= peak x (1 - `trailBps`/10000); peak = highest price seen since placement | market sell |
| bracket | any of take profit / stop loss / trailing; **first to fire wins**, the others are cancelled | market sell, tokens reserved once |

**What this means in practice**
- A "limit" order is a **trigger**: when it fires it takes the current pool price within your slippage. It does not guarantee your exact limit price; `maxDeviationBps` bounds how far from the trigger price the executable output may be.
- The trailing peak is updated **when the order loop looks at the price** (about once a second), so a spike shorter than a tick is not seen. This is the same for every trigger: no mempool watching, no sub-second reaction.
- Triggers use the pool's **spot** price. Heavy trades or thin liquidity can make the executed price worse than spot; that is what the executable-output check and slippage are for.
- If a venue cannot report a spot price or cannot quote the order's size, the order is **not evaluated** and `orderStatus(id).notEvaluated` says why. It never guesses.
- **Market-cap triggers:** you give a target market cap and the supply; the order converts it to a price once at placement. With no known supply the order is `disabled` with the reason.
- Orders survive restarts if the Trader has a `persistDir` (or a `state` backend such as Redis). In-flight trades are always recoverable from the engine store. Chase settings and USD triggers are fields of the order, so they are saved and restored with it.

**Editing a trigger.** `editOrder(id, { priceE18 })` or `{ priceUsd }` (HTTP: `PATCH /v1/orders/:id`) moves an **active** order's trigger in place: the reserved balance, attempts and bracket link are kept, nothing is signed. Refused for a non-active order, a trailing stop (no fixed price, cancel and re-place), a market-cap order, a price of zero, and a bracket edit that would put the take profit at or below its stop loss (or the stop loss at or above its take profit). A `priceE18` edit makes the trigger fixed in the quote token again; a `priceUsd` edit makes it fixed in dollars.

### 6.3 Bulk buy and bulk sell

One request, **up to 10 wallets**. Each leg is an independent engine intent from **its own wallet**, with that wallet's own policy, nonce and idempotency key. It is **not atomic**: some legs can land and others fail, and the report says exactly which.

- Split: `legs` (exact amount per wallet), `wallets` + `total` (equal split; the remainder goes one unit at a time to the first wallets, so legs sum exactly to `total`), or for sells `wallets` + `pctBps` (a percentage of each balance; wallets holding none are left out).
- **Preflight (once):** every wallet must be able to fund its leg, else that leg is `skipped` with the reason. `maxImpactBps` refuses the **whole** bulk if trading the total in the best pool would move its price more than that; `maxTotal` is a hard cap on the sum.
- `mode: 'sequential'` (default): one leg at a time; the pool is refreshed after each, so each leg is priced on the pool as earlier legs left it. `mode: 'parallel'`: all legs are quoted from the same state and land one after another; later legs may revert on their own `minOut` (nothing is spent when they do). `perTick` staggers how many go out per tick.
- `onFailure: 'continue'` (default) or `'stop'` (skip the unsent legs after the first failure).
- Leg status: `pending`, `inflight`, `filled`, `failed`, `skipped`. Summary: `filled`, `failed`, `skipped`, `open`, total `spent` and `received`, `done`, and `refused` when the whole bulk was refused.

### 6.4 TWAP

Trades `total` in `slices` equal parts (2 to 100), one every `intervalS` seconds, from **one** wallet, so a large order does not hit the pool at once.

- The wallet must hold the **whole** amount when the order starts, else it is refused. The schedule is fixed at that moment.
- A slice is sent only when it is **due**, the previous slice has **settled**, and the limits allow: balance, a quotable authorised venue, `limitPriceE18` (a buy waits while the price is above it, a sell waits while below), and `maxSliceImpactBps`.
- A slice that cannot go within `windowS` (default one interval) after its due time is **skipped and reported**, never made up later. Cancelling skips the unsent slices; a slice already in flight finishes.
- `jitterPct` (0 to 50) moves each slice by up to that percent of half an interval, fixed per order id so the schedule is reproducible.
- A TWAP spreads **timing**. It does **not** guarantee an average price. `avgPriceE18` in the status is what was actually achieved.

### 6.5 Slippage chase (opt-in, price orders)

`chase: { stepBps, maxBps }` on any price order or bracket. When a fired order's swap fails (typically a revert because the price moved past the slippage between quote and landing), the next attempt uses `slippageBps + attempts x stepBps`, never above `maxBps` and never below the original. Example `slippageBps: 300, chase: { stepBps: 100, maxBps: 500 }`: attempts at 3%, 4%, 5%, 5%. When `maxAttempts` is not given, it is raised so the chase can reach its cap (at most 10). Validation: `stepBps` 10 to 1000, `maxBps` above `slippageBps` and at most 5000.

What it does **not** do: it is not an order-book chase (there is no book on an AMM; a triggered order already takes the pool price). It does not retry a trigger that is no longer met: each retry happens on a later tick only if the condition still holds. TWAP slices do not chase: a slice that cannot go in its window is skipped, as before. Each attempt has its own idempotency key (`order:<id>:a<n>`).

### 6.6 USD triggers (opt-in, needs a price feed)

Prices are compared in the quote token, so a trigger typed in dollars would drift as the quote token (SOL, ETH) moves. Give the Trader a feed and send `priceUsd` (or `takeProfitUsd` / `stopLossUsd` on a bracket) as a **decimal string** of USD per whole token:

```js
new Trader({ ...config, usd: {
  quoteUsd: async () => ({ price: 73.5, at: Date.now() }),   // USD per whole quote token, and when it was observed
  quoteDecimals: 9,                                         // SOL 9, ETH 18
  tokenDecimals: mint => decimalsOf(mint),
  maxAgeMs: 120_000,                                        // default
} });
await trader.limitSell({ walletId, token, amount, priceUsd: '0.0000024' });
```

The order stores `usdPrice` and, on every tick, its quote-token trigger is re-derived at the current rate, so it fires when the token's **dollar** price reaches the number. A rate older than `maxAgeMs` moves nothing (the order keeps its last quote-token trigger) and placing or editing a USD trigger is refused with `503 unavailable`. Bracket legs move in the order that keeps take profit above stop loss throughout. Exponent strings (`"1e-7"`) are refused: send `"0.0000001"`. Without a feed, a USD trigger is refused with a message that names `TraderConfig.usd`. The practice server (`apps/api/start.ts`) does not configure a feed.

### 6.7 Sniping and copy trading

- **Sniping** reacts only to **mined** launch events and current pool state. It is always after the launch transaction: no mempool inspection, no front-running. Before buying, the real buy is dry-run; a revert such as "trading not enabled" is waited out, never bypassed. Bounded by `maxSpend` (total per launch), `maxAttempts`, `delayBlocks`, `minLiquidity`, `maxTaxBps`, optional `maxValuation`. Exits (`exit.takeProfitBps`, `stopLossBps`, `trailingStopBps`) become price orders. On a networked chain only the buy is dry-run: honeypots and sell tax are **not** detected before buying; the report states this.
- **Copy trading** mirrors a leader's confirmed swaps with caps (per leader, per token, daily), cooldown, max positions, exit modes (`proportional`, `full-on-exit`, `full-on-any-sell`, `ignore`), `trackOnly`, buy checks (market cap, liquidity, tax), duplicate-buy and price-impact guards. Attribution is exact: it only sells what it bought for that leader. A reorged leader trade flags the position `orphaned`; it does not sell automatically.
- Both need a **source** (`LaunchSource` / `LeaderSource`) that fits your chain. The HTTP API lists them (`GET /v1/snipes`, `/v1/copies`) and returns `501 not_configured` for creation unless the host supplied `makeSnipe` / `makeCopy`.

---

## 7. Parameter reference

All amounts are **raw base units as decimal strings** (wei, lamports, token units). JSON numbers lose precision above 2^53, so the API rejects `1.5`, `-1`, `0x10`, `1e18` and unsafe numbers with a message that says what to send. The SDK helpers `parseUnits("1.5", 18)`, `formatUnits(raw, 18)` and `priceE18(price, quoteDecimals, tokenDecimals)` convert for you. **Prices are `quote units per token x 1e18`.**

### 7.1 Market trades

| Param | Type | Default | Meaning |
|---|---|---|---|
| `walletId` | string | required | The wallet that trades. |
| `token` | string | required | Token to buy or sell. The quote token (native by default) is the other side. |
| `amount` | raw string | required (sell: or `pctBps`) | Buy: quote budget **including the platform fee**. Sell: token amount. |
| `pctBps` | int 1 to 10000 | none | Sell only: percentage of the wallet balance. Send `amount` or `pctBps`, not both. |
| `slippageBps` | int 0 to 5000 | 300 | See 5.3. |
| `minOut` | raw string | 0 | Extra floor on output. Only tightens. |
| `deadlineS` | int 10 to 3600 | 120 | Seconds of chain time. |
| `maxFeeBps` | int 0 to 1000 | 200 | Cap on the platform fee. |
| `key` / `Idempotency-Key` | string | random | Retry-safe identity. |

### 7.2 Price orders (all kinds)

| Param | Default | Meaning |
|---|---|---|
| `id` | random | Your order id. Same id again returns the existing order. |
| `walletId`, `token`, `amount` | required | Buy: quote budget. Sell: token amount. |
| `priceE18` | one of `priceE18` / `priceUsd` / `marketCap` | Trigger price, fixed in the quote token. |
| `priceUsd` | none | Trigger fixed in USD per whole token, decimal string. Needs `TraderConfig.usd` (6.6). |
| `marketCap` | none | `{ target, basis: 'circulating'/'fdv', circulating, total, supplySource }` instead of a price. |
| `trailBps` | required for trailing | 1 to 9999. |
| `takeProfitE18` or `takeProfitUsd`, `stopLossE18` or `stopLossUsd`, `trailBps` | bracket: at least one | Stop loss must be below take profit. |
| `slippageBps` | 300 | Applied when it fires. |
| `chase` | none | `{ stepBps, maxBps }`: widen slippage on each failed attempt, capped (6.5). |
| `ttlS` | 604800 (7 days) | Expiry, 60 to 31 536 000. |
| `maxDeviationBps` | 1500 | How far below the trigger the executable output may be. 0 to 10000. |
| `maxAttempts` | 3 | Retries after a failed execution, 1 to 10. |
| `maxQuoteAgeMs` | 15000 | Staleness limit for the price snapshot. |
| `minLiquidity` | 0 | Do not fire below this pool liquidity (quote units). |

Order status values: `active`, `fired`, `cancelled`, `expired`, `failed`, `disabled`. `GET /v1/orders/:id` also returns `detail.reason` (why it has not fired yet) and `detail.notEvaluated`.

### 7.3 Bulk and TWAP

Bulk: `id`, `token`, one of (`legs` | `wallets`+`total` | sell: `wallets`+`pctBps`), `slippageBps`, `maxTotal`, `maxImpactBps`, `onFailure`, `mode`, `perTick`. Wallets 1 to 10, no duplicates.

TWAP: `id`, `walletId`, `token`, `side`, `total`, `slices` (2 to 100), `intervalS` (1 to 604800), `startAt` (chain seconds, default now), `windowS`, `slippageBps`, `limitPriceE18`, `maxSliceImpactBps`, `jitterPct`, `onFailure`. `total` must be at least `slices` units.

### 7.4 In-process only: snipe and copy configs

`trader.addSnipe(id, { cfg, source, inspect? })` takes a `SnipeConfig` (see `packages/core/src/snipe.ts`: `maxSpend`, `delayBlocks`, `minLiquidity`, `maxLiquidity`, `maxValuation`, `maxTaxBps`, `maxAttempts`, `slippageBps`, `exit`, `blockedTokens`, `rejectVerdicts`). `trader.addCopy(id, { cfgs, source, info? })` takes `CopyConfig`s (`packages/core/src/copy.ts`: `mode`, `fixed`, `ratioBps`, `sides`, `maxPerLeader`, `maxPerToken`, `dailyLimit`, `maxPositions`, `cooldownS`, `exitMode`, `trackOnly`, `checks`, ...). The Trader fills in `userId`, `chain`, `quoteToken` and `venues`.

### 7.5 Trade object

`key`, `state`, `walletId`, `origin` (`manual`, `order`, `bulk`, `twap`, `snipe`, `copy`), `tokenIn`, `tokenOut`, `amountIn`, `venue`, `txHash`, `failure`, `history[]`, and `fill`: `spent`, `received`, `platformFee`, `venueFee`, `networkFee`, `quotedOut`, `shortfall`.

---

## 8. API reference

Base path `/v1`. Auth: `Authorization: Bearer <key>`. Open routes: `GET /v1/health`, `GET /v1/openapi.json` (the machine-readable list of every route; use it to generate a client in any language).

**Keys.** Set `API_KEYS="key:user[:scope],..."`. Keys are at least 16 characters, kept only as SHA-256 hashes in memory, compared in constant time, never logged. Scope `trade` (default) can do everything; `read` can only call `GET` and `POST /v1/quote`.

**Limits.** 256 KB body, JSON object only, 20 requests per second sustained with a burst of 40 per key (`429` with `Retry-After`). Listens on `127.0.0.1` unless `API_HOST` is set; put TLS in front before exposing it, because keys are bearer secrets.

**Errors** always look like `{ "error": { "code", "message", "fix" } }` and never include stack traces.

| Status | Codes | Meaning |
|---|---|---|
| 400 | `bad_amount`, `bad_number`, `bad_text`, `bad_json`, `bad_request`, `no_route` | Fix the request; `fix` says how. |
| 401 | `unauthorized` | Missing or unknown key. |
| 403 | `read_only_key`, `no_account` | Key lacks scope, or no account is set up. |
| 404 | `not_found` | Missing, or belongs to another user. |
| 409 | `entries_paused`, `order_refused`, `exists` | Buys are paused; the balance cannot be reserved; duplicate. |
| 413 | `too_large` | Body over 256 KB. |
| 429 | `rate_limited` | Slow down. |
| 501 | `not_configured` | Snipe or copy creation without a host-supplied source. |
| 500 | `internal` | Retry; details are in the server log only. |

A trade that the engine **refuses or that fails** (policy limit, simulation revert, on-chain revert) is returned with `200` and `state: "failed"` plus `failure`, because the request itself was valid and the record exists. Check `state`.

**Events** (`GET /v1/events`, text/event-stream): `trade` (`key`, `state`, `failure`), `order` (`id`, `status`, `reason`, `attempts`), `bulk` and `twap` (`filled`, `failed`, `skipped`, `open`, `done`), `snipe`, `alert`, `error`. Heartbeat comment every 15 s.

| Route | Purpose |
|---|---|
| `GET /v1/overview` | Chain, block, paused flag, active orders, running bulk and TWAP counts |
| `POST /v1/quote` | Best price now, `minOut`, impact, fees, alternatives |
| `POST /v1/trades/buy`, `/sell` | Market trades (use `Idempotency-Key`) |
| `GET /v1/trades`, `/v1/trades/:key`; `POST /v1/trades/:key/advance` | List, inspect, push a waiting trade |
| `POST /v1/wallets/:id/cancel-stuck` | Replace a stuck nonce with a no-op |
| `POST /v1/orders/{limit-buy,limit-sell,take-profit,stop-loss,trailing-stop,bracket}` | Place orders |
| `GET /v1/orders`, `/v1/orders/:id`; `PATCH /v1/orders/:id`; `DELETE /v1/orders/:id` | List, inspect, move the trigger (`priceE18` or `priceUsd`), cancel |
| `POST /v1/bulk/buy`, `/sell`; `GET /v1/bulk/:id` | Bulk |
| `POST /v1/twap`; `GET`, `DELETE /v1/twap/:id` | TWAP |
| `POST /v1/alerts`; `DELETE /v1/alerts/:id` | Price alerts |
| `GET /v1/positions`, `/v1/history` | Portfolio |
| `POST /v1/entries/pause`, `/resume` | Pause new buys |
| `GET /v1/snipes`, `/v1/copies`; `POST` (host-configured) | Sniping and copy trading |
| `GET /v1/events` | Live events |
| `GET /v1/wallet`; `POST /v1/wallet/link/start`, `/v1/wallet/link/finish`; `DELETE /v1/wallet` | Execution server in `MODE=solana-mainnet` only: link the user's Privy wallet (section 4.5 A), see whether it may trade now, unlink. Errors: `bad_signature` 401, `not_delegated` 409, `link_expired` 410, `privy_unavailable` 503; trades on an account whose wallet is not active: `wallet_not_active` 409 |
| `GET /v1/settings`; `PATCH /v1/settings` | `MODE=solana-mainnet` only: per-user `mevProtection` (default false) and `maxTipSol` (default 0.0001, at most 0.001). Any trade or order also takes `mevProtection: true|false` for itself |
| `GET`, `PUT`, `DELETE /v1/app/webhook`; `POST /v1/app/webhook/test`; `GET /v1/app/users` | App keys only (section 4.6): the app's signed webhook and its end users. With an app key every other route needs `X-User-Id` (`missing_user` 400 without it; `app_user_limit` 403 past MAX_USERS_PER_APP; `not_an_app_key` 403 for /v1/app with a user key) |

---

## 9. Safety rules that always apply

- **Pause entries** blocks new **buys** everywhere (manual, orders, bulk, TWAP, snipe, copy). Sells, stop losses and take profits keep working. While paused, snipe and copy runners are not ticked at all (they resume from their saved cursor), which also delays copied *sells* until you resume.
- **No order can exceed the wallet policy.** A per-transaction cap, daily cap or revoked automation switch fails the trade with `signer policy: ...` no matter which feature sent it.
- **Fail closed.** If a price, balance, supply or quote cannot be read, the engine waits or refuses; it does not guess.
- **No mempool games.** There is no front-running, sandwiching or mempool inspection anywhere in the engine.
- **Restart safety.** With `persistDir` (or `Store.open`), orders, bulk and TWAP state and the engine store are written atomically before each action. After a restart, re-create runners with the same ids and call `trader.resume()`: the same idempotency keys are reused, so nothing is sent twice. Killing the process mid-flight was tested with a real kill on a fork (a SIGKILL test (harness in tag `v0.1.0-full-platform`)).

---

## 10. What is not done (read before trusting it with money)

1. **Real funds only in small amounts on Solana, through the `/solana` UI** (KNOWN_LIMITATIONS.md, evidence levels): market trades, limit orders, the trading key, and
   Privy automatic trading (a confirmed buy and a standing order that fired by itself, both signed by real Privy). Nothing on Ethereum mainnet. The execution server's real mode (`MODE=solana-mainnet`)
   has been run on a local validator only.
2. The **Trader and API layer** is verified on the practice chain, an **Ethereum** fork and a **Solana** local validator. Sniping and copy trading through the Trader were not part of those runs (their runners have their own fork and validator reports), and on Solana only the Raydium SOL/USDC pool was used, not Jupiter routes.
3. **Custody:** Solana has a production-grade option in the SDK (`PrivySolSigner`: the user's own Privy wallet, server signing under a Privy policy), used by `/solana`.
   The execution server uses it in `MODE=solana-mainnet` (verified on a local validator with two nodes and a Privy stand-in, not yet on mainnet). EVM has no real signer yet (ERC-4337 or Privy smart wallets are the plan, README → Custody plan).
4. Only **Uniswap-V2-style pools** (Ethereum) and **Raydium AMM v4 / Jupiter routes** (Solana) are supported. No V3, CLMM, DLMM, stable pools or multi-hop routes.
5. Triggers poll about once a second from pool **spot price**; there is no sub-second reaction, no private mempool and no MEV protection. Gas is not tuned (no fee bumping logic beyond replace-by-fee for cancels).
6. Sniping on a networked chain cannot see honeypots before buying; Solana discovery sees pool **creations** only, not later migrations.
7. Rate limits and keys are in memory: a restart of the API process forgets the rate-limit counters, and keys come from the environment only (no rotation UI).
8. Unaudited: the fee router contract, the whole codebase.
9. The practice chain has no clock: its **time moves only when the host moves it** (the practice server advances it one second per second). TWAP and order expiry on it are therefore only as realistic as that clock.

See also: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [PRODUCTION_SERVER.md](PRODUCTION_SERVER.md), [SOLANA_MAINNET_TEST_CHECKLIST.md](SOLANA_MAINNET_TEST_CHECKLIST.md). Earlier design and capability documents are in git tag `v0.1.0-full-platform`.


## Use the SDK outside this repo

`packages/sdk` is a real package (`memedesk-sdk`, private, version 0.1.0). It bundles the engine,
the Ethereum adapter and the Solana adapter as plain JavaScript with type definitions, and has no
runtime dependencies. It needs Node 22 or newer.

Build and pack (needs `tsc` 5.7+ on PATH and a `node_modules/@types` folder that contains `node`):

```bash
TYPES_ROOT=/path/to/node_modules/@types npm run pack:sdk
```

This writes `packages/sdk/memedesk-sdk-0.1.0.tgz`. In any other project:

```bash
npm install /path/to/memedesk-sdk-0.1.0.tgz
```

Imports: `memedesk-sdk` (Trader, practice world, client, helpers), `memedesk-sdk/client` (HTTP client only),
`memedesk-sdk/core`, `memedesk-sdk/evm`, `memedesk-sdk/sol` (includes `PrivyApi` and `PrivySolSigner`, section 4.4).

Checked: a clean install into an empty folder ran a practice buy to `finalized`, rejected a bad amount with a
clear error, resolved all five import paths, and passed a TypeScript type check. Not done: publishing to
the npm registry (the package is marked private), TLS or auth hardening, and an EVM signer with real custody.
