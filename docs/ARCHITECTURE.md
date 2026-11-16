# Architecture

Date: 2026-11-13. Distinguishes what exists in code today from what is planned. Nothing planned here is built. Everything that exists runs against local simulations (`SimChain` and fixture models); `npm test` passes 187 tests in one run (core, telegram, scraper, evm, live harness), which is simulation, fake and recorded-fixture evidence only.

## 1. Service decomposition

| Service | Responsibility | Exists today? | Where |
|---|---|---|---|
| User API / bot front end | Telegram bot, web UI, auth, command parsing, previews | Stubs and a practice UI only: a transport-agnostic Telegram command handler (no bot token, no auth) and the "Tideline" practice terminal (11 pages, plain Node `http` server on port 3000, no auth, simulated chain and fixture pools, hand-checked, no automated UI tests). Not a production front end | `apps/telegram/handler.ts`, `apps/web/server.ts`, `apps/web/index.html` |
| Telegram scraper | Read user's own channels, extract contract addresses, produce previews or (explicitly enabled) auto candidates | Library only, against a fake transport: `TelegramTransport` interface, encrypted `SessionStore`, `Scraper` with filters/dedup/presets. No MTProto client, so live use is BLOCKED; no desktop shell or UI | `apps/scraper/*` |
| Strategy | Copy trading, conditional orders, launch sniping, signal filtering, reservations; emits `Intent`s | Yes, as library code with no scheduler or process | `copy.ts`, `orders.ts`, `reservations.ts`, `signals.ts`, `snipe.ts` |
| Listeners | Chain event ingestion (leader swaps, new pools, launches), price snapshots, reorg notices | No. Only the input shapes (`LeaderEvent`, `LaunchEvent`, `ChainEvent`, `Snapshot`, `TrendTrade`); `LaunchDetector` and `WalletAlerts` consume caller-supplied events | `copy.ts`, `orders.ts`, `snipe.ts`, `alerts.ts` |
| Quotes / routing | Direct-adapter quoting, graduation successor following, optional aggregator as labeled benchmark only | Yes against SimChain venues | `router.ts`, `venues.ts` |
| Simulation | Pre-submit dry run; risk probing | Yes against SimChain | `simchain.ts` (`simulate`), `risk.ts` |
| Signing | Policy-enforcing signer, audit log | In-process HMAC stand-in only (see CUSTODY_AND_SIGNING.md) | `signer.ts` |
| Submission | Tx state machine, nonce allocation, resubmit, reconcile | Yes against SimChain | `engine.ts`, `store.ts` |
| Reconciliation | Detect tx found/absent/consumed, expire, reorg detection, stuck-nonce healing | Partly, inside the engine driver (`advance`, `healNonce`, `cancelNonce`); no separate service, no periodic sweeper | `engine.ts` |
| Portfolio | Positions, cost basis, P&L, fees, volume from confirmed fills | Yes as a pure fold over an event log; caller supplies fills and prices | `portfolio.ts` |
| Alerts / community / trending | Watchlists, price alerts, wallet and whale alerts, authorized group bot, trending | Pure logic, injected sink, caller-supplied events and time | `alerts.ts` |
| Notifications | User messages for fills, failures, alerts | No delivery; only alert decisions and an injected sink | `alerts.ts` |
| Billing / commerce | Fee ledger, referral/cashback accrual, tiers, subscriptions, fee schedules and sweeps, campaigns, competitions | Models over the in-memory ledger. Tier numbers are placeholders; no payment rail; not called by `Engine` | `ledger.ts`, `commerce.ts` |
| EVM adapter building blocks | Calldata, ABI, Keccak-256, V2 math, CREATE2 pair derivation, approval planning, `Venue` over an injected `EthCall` | Pure TypeScript, zero dependencies, recorded fixtures only. No RPC, signing, submission or chain config; live use BLOCKED. Not wired into `Engine` or `Router` | `packages/evm/src/*` |
| Chain-family adapters | Solana / TON / Tron semantics behind one seam | Standalone fixture simulators (`SimulatedSolana`, `SimulatedTon`, `SimulatedTron`) with fixture-assumption parameters; NOT wired into `Engine` | `chains.ts` |
| Bridge / funds ops | Resumable bridge steps, batch distribute | Fixture-level | `bridge.ts` |

## 2. Implemented vs planned infrastructure

| Component | Status |
|---|---|
| TypeScript core library (`packages/core`) | Exists (~2,500 lines of source, plus tests; 84 core tests) |
| Store | In-memory `Map`s with JSON `snapshot()`/`restore()`; BigInt-safe. Not durable by itself, single process |
| Rust workers (hot-path listeners/signers) | Not implemented |
| Postgres (system of record) | Not implemented; `Store` is the seam it would implement |
| Redis (locks, rate limits, cache) | Not implemented; current per-key lock is an in-process promise chain |
| Redpanda / Kafka (events, outbox relay) | Not implemented |
| ClickHouse (analytics, PnL history) | Not implemented |
| Helm / Terraform / Postgres schema / collector configs | Templates under `deploy/`, each marked unapplied and unvalidated; no environment exists |
| Telegram / web / scraper apps | Telegram command handler (4 tests); scraper library with fake transport (11 tests, live BLOCKED); "Tideline" practice terminal on the simulated chain (no automated tests). None deployed; no bot token, no Telegram API credentials |
| EVM adapter package (`packages/evm`) | Exists as offline calldata/math (11 tests); no network code |
| Benchmark | `bench/bench.ts`: in-process fixture benchmark, not a network or load test |

## 3. Transaction state machine (from `engine.ts` `NEXT`)

```
created -> validated | failed
validated -> quoted | failed
quoted -> simulated | failed
simulated -> awaiting_authorization | failed
awaiting_authorization -> signed | failed
signed -> submitted | unresolved | expired
submitted -> observed | unresolved | failed | expired
observed -> confirmed | failed | unresolved
confirmed -> finalized | unresolved
unresolved -> submitted | observed | failed | expired
finalized, failed, expired: terminal
```

Behaviors verified only against SimChain:
- Illegal transitions throw. `drive()` loops up to 20 steps per call and is safe to call repeatedly.
- `created` validates amount > 0, slippage 0..5000 bps, deadline in future, platform fee <= `maxFeeBps`.
- `validated` routes; `minOut` = max(user-supplied, quote-derived). Slippage is never widened by retries.
- `quoted` builds the tx and simulates; a revert fails the intent (honeypot sell is caught here). RPC down leaves the state at `quoted` for a later retry.
- `awaiting_authorization` allocates the nonce, calls the signer, increments the local nonce counter, and moves to `signed` BEFORE any network send (write-ahead).
- `submitted`/`observed` poll `lookup`; a reverted receipt is `failed` with no fill; a success receipt computes `Fill` from balance deltas (not from the quote) and sets `shortfall = quotedOut - received`.
- `confirmed -> finalized` after `finalityDepth` (3 in SimChain); a vanished receipt goes back to `unresolved`.
- `unresolved` is the reconcile state; see section 4.
- `confirmed` is provisional until `finalized`. If the receipt disappears or is re-included in a different block, the record goes `confirmed -> unresolved`, is re-observed, and the fill is recomputed from the CURRENT receipt (`confirmedBlock` tracks which receipt the fill came from). Downstream consumers (ledger, portfolio, copy) still receive confirmation from the caller; `Portfolio.revokeTrade`, `reverseAccrual`, and `CopyEngine.recordReorg` exist but nothing calls them automatically from the engine. (Ledger accrual takes a `confirmed` boolean supplied by the caller.)
- `noop` transactions (kind `noop`, from `cancelNonce`) share the same states; they move no value, have no deadline, and are always retryable.

## 4. Idempotency, nonces, reconciliation

- Idempotency key: `Store.records` is keyed by `idempotencyKey`; a second `submit` with the same key returns the existing record and advances it. Tests 9 and 10 assert one economic execution after ack loss, resubmit, and a simulated restart from a snapshot.
- Strategy-generated keys are deterministic: `order:<id>:a<attempt>`, `copy:<follower>:<chainId:txHash:logIndex>`.
- Nonce: `max(chain confirmed nonce, locally allocated counter)` per `chain:wallet`. If a signed tx later expires or fails and is absent from the node, the wallet's lowest unconsumed nonce is stuck. `healNonce(wallet)` detects this and calls `cancelNonce`, which (reconcile-first) looks the original up, then signs a no-op at the SAME nonce through the signer (kind `noop`, policy-checked), marks the original expired with a reason, releases its signer charge, and advances the no-op. An original still pending is not replaced unless `force`; forced removal uses `SimChain.evict`, which is atomic in the sim, whereas a real node needs replace-by-fee and has an inclusion race. RPC down returns `rpc_down` and changes nothing. Idempotent via `noop:<wallet>:<nonce>:<attempt>` keys.
- Reconcile before rebuild: on `unresolved`, look up the SAME tx hash. Found -> `observed`/`submitted`. Absent and past deadline -> `expired`. Chain nonce already advanced past ours with a different tx -> `failed`. Otherwise resubmit identical bytes, up to `maxResubmits` (3).
- Per-key serialization is an in-process mutex. Multi-process safety would need a DB row lock or lease; not implemented.
- Signer daily-limit accounting is charged at sign time, idempotent per digest, and refunded via `release` when the engine proves a tx can never be included (rejected, expired-and-absent, nonce consumed by another tx, cancelled). A charge is kept for any included tx, including reverts. State is behind a `SpentLedger` seam (only `MemoryLedger` exists). A retry of an already-signed key does not re-sign.
- Testing: `hardening.test.ts` has targeted tests (H1 nonce cancel, H2 signer charge/release/persistence, H3 reorg) and seeded fuzz (seeds 1-3, 500 intents each) injecting submit-ack loss, RPC outage, node mempool drops, restarts at consistent snapshot boundaries, and shallow reorgs, then checking invariants after draining. Fuzz does not crash between a network send and persist.

## 5. OCO and reservation design

- `Reservations` tracks `(wallet, token) -> owner -> amount`. `reserve` fails if `balance - reserved < amount`, so two strategies cannot claim the same balance.
- OCO group reserves ONCE under owner `oco:<group>`; sibling legs share it. Cancel/expire/fail releases only when no live sibling remains.
- Firing: atomic claim of the group in a set; first leg to fire cancels siblings; on failed attempt the claim is released and the order returns to active with identical limits until `maxAttempts`.
- Guards before firing: expiry, quote age (`maxQuoteAgeMs`), minimum liquidity, trigger condition, and an executable-output floor using `maxDeviationBps`. Market-cap triggers convert to price at placement using circulating or total supply; if supply is unavailable the order is `disabled`.
- Limitation: reservations are in memory and are not reconciled against actual on-chain balance changes after placement.

## 6. Copy attribution

- Dedupe key `chain:txHash:logIndex` regardless of data provider. Non-swap events (transfer, liquidity, bridge, airdrop) are skipped.
- Buy sizing: fixed or proportional (bps of leader quote amount), clipped by per-leader, per-token, and daily caps; position count cap; cooldown; liquidity and price-deviation checks; minimum confirmations; allow/block lists.
- Attribution: `recordFill` (to be called on a CONFIRMED fill only) credits inventory to `(follower, leader, token)`. Sells act only on attributed inventory, scaled by the leader's sold fraction, or full attributed amount on leader exit. Unrelated follower holdings are untouched.
- Caps are NET exposure: attributed cost basis (reduced proportionally on sells) plus in-flight buys. In-flight buys are reserved in `pending` until `recordFill` / `recordFailure`. In-flight SELLS are not reserved (known gap).
- Sells: exit modes `proportional`, `full-on-exit`, `full-on-any-sell`, `ignore` (default derived from `followLeaderExit`); proportional amounts floor-round, clamp to attributed inventory, with an optional dust sweep.
- Confirmation presets (`fast` 0 confirmations, `safe` N) trade latency against leader-tx reorg exposure.
- Reorg: `onReorg` / `recordReorg` revoke the tx id (later replays ignored) and reverse already-recorded fills out of attributed inventory, flagging the position `orphaned`. No automatic sell is issued; the tokens remain in the wallet.

## 7. Ledger and outbox/inbox plan

Ledger (exists): append-only double-entry entries, each posting must sum to zero per asset, idempotent by key, reversal by negating entries, claim-once by claim id. Accrual only from confirmed trades: split of `platformFee` into `rewards:<referrer>` commission (one or several referrers), `rewards:<user>` cashback, and `revenue`. Trades flagged by the caller-supplied `AbuseFlags` (self-referral, wash) accrue no commission or cashback: the fee goes to `abuse:flagged` with an audit record.

Commerce layer (`commerce.ts`, exists, in-memory, not called by `Engine`):
- Tiers: `TierConfig` with per-tier limits for wallets, monitors, copy wallets, snipes, limit orders; `enforce`. Default numbers and price are placeholders.
- `Subscriptions`: purchase idempotent per payment id, state derived by replaying non-refunded payments, renewal extends from expiry, refund reverses the ledger posting.
- `FeeSchedule` / `FeeCollector`: per-chain, per-tier bps; `in-tx` books straight to revenue, `accrued-then-swept` holds fees in `fees:accrued:<chain>` until `sweep` (once per sweep id, above a per-chain minimum); `reverseCharge` for reorgs.
- `ReferralBook`: sticky first referrer, no self/cycle attribution, per-token split links, `referralsFor` feeds `accrue`.
- Campaigns (single largest active cashback boost, capped) and `Competition` (confirmed, unflagged platform volume only; caps; reorg removal; idempotent prizes).

Planned, not built:
- Transactional outbox: engine state change + event row in one Postgres transaction; relay to Redpanda; consumers (notifications, ledger, analytics) deduplicate with an inbox table keyed by event id.
- Ledger postings driven by finalized (not merely confirmed) events, with automatic reversal on reorg events.
- Fee extraction jobs for non-Solana chains: the accrue/sweep ledger model exists (`FeeCollector`); the actual on-chain extraction transfer, as an idempotent intent, does not.
- Wiring: engine fills driving portfolio, fee, and accrual postings, and engine reorg events driving reversals, are caller responsibilities today.

## 8. Per-chain adaptation notes (design, unverified; only fixture models exist in `chains.ts`, not wired into Engine)

| Chain family | Concern | Plan |
|---|---|---|
| EVM | Per-account sequential nonces; replacement by same nonce + higher fee; reorgs; fee-on-transfer tokens; private relays optional | Keep write-ahead nonce; no-op cancel/replace exists against SimChain, real RBF with fee bump to be added; fills from receipt logs and balance reads; confirmation depth per chain |
| Solana | No nonces; recent blockhash expires (~60-90s window, verify) so a tx can be provably dead after expiry; priority fees; compute limits; Token-2022 extensions | Treat blockhash expiry as the `expired` signal (safe to rebuild only after last valid block height passes); durable-nonce accounts optional; fee taken in-tx |
| TON | seqno per wallet contract; messages carry an expiry (`valid_until`); async multi-message execution so a tx hash may not equal swap completion | Track by external message + resulting trace; expire at `valid_until`; confirm final jetton balances |
| Tron | Resource model (bandwidth, energy) instead of gas price; tx expiration timestamp; fee-limit caps; energy staking/rental cost | Pre-check resources, set fee_limit, treat tx expiration as the expiry signal; model burn cost in quotes |

All four need per-chain finality definitions and RPC disagreement handling that do not exist yet.

## 8a. Components added since the last refresh (what they do and do not touch)

- `apps/scraper`: transport seam (`TelegramTransport`, `FakeTransport` for tests) -> `Scraper.handle` (channel filter, shared `SignalFilter` for age and cross-channel dedup, injected chain validator, per-chain preset) -> `Preview` of an `Intent` (origin `signal`, `minOut: 0n`, idempotency key `scraper:<user>:<chain>:<address>`). Auto mode needs `mode:'auto'`, `autoEnabled=true` and a callback, else it stays preview; the callback is the only exit, the module never signs or submits, so downstream limits, simulation and authorization still apply. Session secrets: AES-256-GCM with a scrypt-derived key; errors are generic; the log is redacted; `toJSON` hides state. Message text is data only. Live Telegram is BLOCKED (no MTProto client).
- `packages/evm`: not connected to `Engine`. `V2Venue` implements core `Venue` over an injected async `EthCall`, so it could be plugged into `Router` once a real `EthCall`, addresses and signing exist. `V2Venue.quote` is synchronous on a loaded snapshot, so reserves must be refreshed with `V2Venue.load`. Pair addresses depend on injected factory and init code hash; none are recorded in the repo.
- `apps/web` ("Tideline"): `server.ts` builds a `world()` from `packages/core/test/fixtures.ts` (fixture pools: healthy, 10% tax, honeypot, not-yet-open) and exposes JSON endpoints (`/api/overview`, `/api/quote`, `/api/trade`, `/api/orders`, `/api/copy`, `/api/portfolio`, `/api/alerts`, `/api/signals`, `/api/launch-check`, `/api/plan`, `/api/audit`, ...). Manual trades, price orders, copy trades and signals all go through the same `Engine`. A lifecycle tracker maps the engine state machine to user stages (preparing, sent, confirmed, final, failed, expired, checking); `explain()` turns engine failure strings into title/why/fix text; a notification feed is polled by the page. Tier enforcement is applied to price orders only. It is a demo harness: single in-memory user and state, lost on restart, no authentication, and `listen(3000)` is not restricted to loopback, so do not expose it on a shared network.

## 9. Threat model (STRIDE-style)

| Threat | STRIDE | Scenario | Current mitigation in code | Gap / planned |
|---|---|---|---|---|
| Telegram account compromise | Spoofing, Elevation | Attacker controls user's Telegram, tries withdraw or raises limits | Withdrawals require device-key HMAC approval plus destination allowlist; telegram origin alone is denied (test 12) | Real device-key flow, enrollment, allowlist-change delay do not exist; automation can still trade within limits |
| Malicious channel content | Tampering, Elevation | Signal text contains instructions ("raise my limit", "withdraw to 0xdead") or fake contracts | `extract()` yields address candidates only; cannot alter config/limits; requires on-chain validation callback; age and dedupe (test 7); scraper config is frozen and a hostile-message test checks config, wallet and limits stay unchanged; auto mode needs three explicit conditions | No LLM/command parsing exists; validation callback is a test stub; scraper runs in the host process (no sandbox) and has only run against a fake transport |
| Rug / honeypot / taxed token | Tampering, Denial | Token blocks sells or taxes heavily | Simulation catches revert on honeypot sell; `minOut` blocks tax beyond slippage; risk report; sniper pre-trade checks and `simulateLaunch`; shortfall recorded (tests 8, 8b, snipe 4d, 4f) | Heuristics are for SimChain; real tokens can detect simulation, change behavior after block; report is not a safety certificate |
| RPC lies / outage | Spoofing, Denial, Info | Provider returns false state, hides txs, drops submits | Reconcile by tx hash, identical resubmit, outage keeps state (tests 9, 9b) | Single provider assumed; no quorum, no provider diversity, no state-proof checks |
| Signer compromise | Elevation, Info | Key extraction or policy bypass | Policy checks, tenant isolation, audit without secrets, daily-limit charge/release with ledger seam | Signer is in-process; no HSM/MPC, no key isolation, policies live in process memory |
| Reorgs | Tampering | Included tx dropped; leader trade reorged | `confirmed -> unresolved` with fill recompute; `reorgReinclude` tests and fuzz; copy `recordReorg` (orphan flag, no auto-sell); `LaunchDetector.revoke`; `WalletAlerts.revokeBlock`; `Portfolio.revokeTrade`; ledger/competition reversal; finality depth | Only fixture-level and shallow; reversals are caller-invoked, accrual not wired to finality; follower trades are not unwound |
| Referral abuse | Spoofing, Repudiation | Self-referral, wash trading between owned wallets to farm commission | `ReferralBook` blocks self/cycle; `accrue` honors `AbuseFlags` (flagged fees parked in `abuse:flagged`, audited); `washFlag`/`washIndices` with owner and cluster mappings; competition excludes flagged trades; confirmed-only accrual; claim-once | Caller must compute and pass the flags; device/IP signals not collected; payout is a ledger move |
| Trending / alert manipulation | Tampering | Wash trades or many small wallets inflate trending; aggregate differenced to expose individuals | Round-trip exclusion, per-wallet cap, min liquidity, decay, k-anonymity on the public aggregate (alerts tests) | No differencing defense or noise on the aggregate; non-round-trip multi-wallet manipulation only partly defended |
| Supply chain | Tampering | Malicious npm/cargo dependency, compromised build, poisoned contract ABI source | None. Core uses only `node:crypto` and `node:test` | Lockfile pinning, SBOM, reproducible builds, ABI provenance checks, CI hardening |
| Repudiation generally | Repudiation | User disputes a trade | Tx history per record, signer audit log | Audit log is in memory, not append-only storage or tamper-evident |
| Info disclosure | Info | Secrets in logs | Audit omits device secret (test 12); scraper session store encrypts at rest, uses generic errors, redacted log and `toJSON`, with a test that secrets never appear in logs, errors or JSON | Secrets are plain strings in constructor args; JS strings cannot be reliably zeroed, so this is not a defense against a hostile host process or memory inspection; `SessionStore.revoke()` does not end the session on Telegram's servers |
| Denial of service | Denial | Flood of intents or signals | None | Rate limiting, quotas, queue backpressure |

## 10. Implementation overview (2026-11-15)

### Tech stack
| Layer | What is used | Notes |
|---|---|---|
| Language and runtime | TypeScript on Node 22 (type stripping, `--experimental-transform-types`) | Core, EVM, Solana, live and apps have zero npm dependencies |
| Tests | `node:test`, 425 tests | Fake chains, fake HTTP/WebSocket servers, child-process end-to-end tests |
| Web terminal | `node:http` server, vanilla JS, CSS tokens (Mint UI), WCAG 4.5:1 contrast | `apps/web`; modes: practice, real markets (`web:markets`), fork (`web:fork`) |
| Telegram | Bot API long polling, one poller per token | `apps/telegram`; private chats trade, groups only run Buy Bot (admin-checked) |
| EVM | Own ABI, keccak, calldata, Uniswap/Pancake V2 math, JSON-RPC chain | `packages/evm` |
| Solana | Own tx builder, Jupiter and Raydium adapters, mint-risk checks | `packages/sol` |
| Real data | Alchemy RPC, GeckoTerminal, Jupiter, Helius WebSocket | `packages/live`; every real call is read-only (RPC method allowlist) |
| Indexer | Ponder 0.18 + viem + Hono, embedded PGlite | `indexer/`, separate `package.json`; opt-in with `INDEX_URL` |
| Local chains | Foundry `anvil` (mainnet fork), `cast` for throwaway keys, Solana test validator | Fake funds only |
| Deploy templates | Helm, Terraform, Prometheus, OpenTelemetry, `schema.sql` | Templates, not applied |

### How a request flows
1. A client (web, Telegram, runner) calls the terminal server. Telegram chats must be linked to an account by a one-time code.
2. The Engine checks wallet policy (per-trade, daily, kill switch), quotes against pool math and caps price impact.
3. It writes a checkpoint with an idempotency key BEFORE signing, then signs through the signer port and submits through a ChainPort (`SimChain`, `EvmRpcChain`, Solana).
4. It tracks the transaction to confirmed/final, or failed/reorged, and reports a plain-language result. After a crash `resume()` replays checkpoints; the same key prevents a double send.
5. Runners (bulk, TWAP, copy, snipe, orders) are loops over this same path with their own persisted state.

### Market data path
Whale feed and Buy Bot read a `TradeSource`. With `INDEX_URL` set it is our Ponder indexer first and GeckoTerminal as fallback (error, bad shape or lag over `INDEX_MAX_LAG_S`); otherwise GeckoTerminal only. `/api/whales` reports which source answered. The Wallet Tracker, for Solana wallets and when `HELIUS_API_KEY` is set, holds a read-only `logsSubscribe` per wallet (max 5); activity drops that wallet's cached history and the page re-reads within its next refresh. Contract: `docs/INDEXER_CONTRACT.md`.

### Verified
Fork reports in `docs/live-verification/`: bulk (17/17), Telegram on fork (10/10), kill test (8/8), indexer (10/10), wallet push on live Helius (12 checks). Not verified: BNB indexing, real Telegram on the fork terminal, torn writes and power loss, real funds, a real signer or HSM.

Update 2026-11-16: with `HELIUS_API_KEY`, the Solana launch stream (Pump.fun and Raydium creations) uses Helius for the WebSocket and for transaction reads (`Paced` spaces every call 150 ms apart across concurrent decoders); Discover lists the newest eight in a "New on Solana" strip and the Sniper page keeps the full board. One terminal per free Helius key.
