# SDK and Execution API

Date: 2026-11-16. This document covers the TypeScript SDK (`packages/sdk`), the HTTP API (`apps/api`), what chains and platforms are supported **today**, what happens in the backend when you send an order, and every parameter that controls execution.

**Read this first.** Everything here has been run on a **practice chain** (a simulator in this repo, fake funds). The SDK and the HTTP API have also been run end to end on a **local fork of Ethereum mainnet** (`npm run verify:trader-fork`, 14/14 checks) and on a **local Solana validator** with the mainnet SOL/USDC Raydium pool cloned (`npm run verify:trader-solana`, 13/13 checks); reports are in `docs/live-verification/`. Nothing has moved real money. See [Supported chains](#2-supported-chains) for the exact level of evidence per chain.

---

## 1. What you get

| Piece | What it is | Where |
|---|---|---|
| **Engine** | The execution core: validates, quotes, simulates, signs (under wallet policy), sends and tracks every trade, crash-safe and idempotent. | `packages/core` |
| **Trader (SDK)** | One TypeScript object exposing the whole engine: market buy/sell, limit buy/sell, take profit, stop loss, trailing stop, bracket, bulk buy/sell, TWAP, sniping, copy trading, price alerts, portfolio, pause. | `packages/sdk/src/trader.ts` |
| **Client (SDK)** | The same method names over HTTP, for programs that do not run the engine themselves. | `packages/sdk/src/client.ts` |
| **HTTP API** | JSON over HTTP with API keys, rate limits, an event stream and an OpenAPI document. | `apps/api` |
| **Telegram bot, web terminal** | The two user interfaces that already existed; they sit on the same engine. | `apps/telegram`, `apps/web` |

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
| **Runtime** | Node.js 22. Zero npm dependencies in the core, SDK and API (`indexer/` has its own dependencies and is optional). |
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

To run against a **real or forked chain**, build the `Engine` the way `apps/web/livemode.ts` does (`EvmRpcChain` + signer + `PolicySigner`) and pass it to `new Trader({ engine, chain, userId, venues: ['uniswap-v2'], persistDir })`. The Trader has been run end to end over `EvmRpcChain` on a mainnet fork and over `SolanaChain` on a local validator (section 2).

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

> The signer in this repository is an in-process stand-in. A real deployment needs an HSM or MPC service behind the same interface. See [CUSTODY_AND_SIGNING.md](CUSTODY_AND_SIGNING.md).

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
5. Report the result back: finalized releases the reservation; failure retries with the same limits until `maxAttempts` (default 3), then `failed`.

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
- Orders survive restarts if the Trader has a `persistDir`. In-flight trades are always recoverable from the engine store.

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

### 6.5 Sniping and copy trading

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
| `priceE18` | required unless `marketCap` | Trigger price. |
| `marketCap` | none | `{ target, basis: 'circulating'/'fdv', circulating, total, supplySource }` instead of a price. |
| `trailBps` | required for trailing | 1 to 9999. |
| `takeProfitE18`, `stopLossE18`, `trailBps` | bracket: at least one | Stop loss must be below take profit. |
| `slippageBps` | 300 | Applied when it fires. |
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
| `GET /v1/orders`, `/v1/orders/:id`; `DELETE /v1/orders/:id` | List, inspect, cancel |
| `POST /v1/bulk/buy`, `/sell`; `GET /v1/bulk/:id` | Bulk |
| `POST /v1/twap`; `GET`, `DELETE /v1/twap/:id` | TWAP |
| `POST /v1/alerts`; `DELETE /v1/alerts/:id` | Price alerts |
| `GET /v1/positions`, `/v1/history` | Portfolio |
| `POST /v1/entries/pause`, `/resume` | Pause new buys |
| `GET /v1/snipes`, `/v1/copies`; `POST` (host-configured) | Sniping and copy trading |
| `GET /v1/events` | Live events |

---

## 9. Safety rules that always apply

- **Pause entries** blocks new **buys** everywhere (manual, orders, bulk, TWAP, snipe, copy). Sells, stop losses and take profits keep working. While paused, snipe and copy runners are not ticked at all (they resume from their saved cursor), which also delays copied *sells* until you resume.
- **No order can exceed the wallet policy.** A per-transaction cap, daily cap or revoked automation switch fails the trade with `signer policy: ...` no matter which feature sent it.
- **Fail closed.** If a price, balance, supply or quote cannot be read, the engine waits or refuses; it does not guess.
- **No mempool games.** There is no front-running, sandwiching or mempool inspection anywhere in the engine.
- **Restart safety.** With `persistDir` (or `Store.open`), orders, bulk and TWAP state and the engine store are written atomically before each action. After a restart, re-create runners with the same ids and call `trader.resume()`: the same idempotency keys are reused, so nothing is sent twice. Killing the process mid-flight was tested with a real kill on a fork (`npm run verify:kill`).

---

## 10. What is not done (read before trusting it with money)

1. **No real funds have ever been used.** Evidence is practice chain, local forks, and mainnet read-only checks.
2. The **Trader and API layer** is verified on the practice chain, an **Ethereum** fork and a **Solana** local validator. Sniping and copy trading through the Trader were not part of those runs (their runners have their own fork and validator reports), and on Solana only the Raydium SOL/USDC pool was used, not Jupiter routes.
3. **The signer is a stand-in**, not an HSM or MPC service, and API users do not hold their own keys here. Custody is unsolved for production.
4. Only **Uniswap-V2-style pools** (Ethereum) and **Raydium AMM v4 / Jupiter routes** (Solana) are supported. No V3, CLMM, DLMM, stable pools or multi-hop routes.
5. Triggers poll about once a second from pool **spot price**; there is no sub-second reaction, no private mempool and no MEV protection. Gas is not tuned (no fee bumping logic beyond replace-by-fee for cancels).
6. Sniping on a networked chain cannot see honeypots before buying; Solana discovery sees pool **creations** only, not later migrations.
7. Rate limits and keys are in memory: a restart of the API process forgets the rate-limit counters, and keys come from the environment only (no rotation UI).
8. Unaudited: the fee router contract, the whole codebase.
9. The practice chain has no clock: its **time moves only when the host moves it** (the practice server advances it one second per second). TWAP and order expiry on it are therefore only as realistic as that clock.

See also: [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CUSTODY_AND_SIGNING.md](CUSTODY_AND_SIGNING.md).


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
`memedesk-sdk/core`, `memedesk-sdk/evm`, `memedesk-sdk/sol`.

Checked: a clean install into an empty folder ran a practice buy to `finalized`, rejected a bad amount with a
clear error, resolved all five import paths, and passed a TypeScript type check. Not done: publishing to
the npm registry (the package is marked private), TLS or auth hardening, and a real signer.
