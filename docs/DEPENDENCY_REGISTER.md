# Dependency Register

Date: 2026-11-13. Every item below is **not provisioned**. No accounts, keys, contracts, vendors, or budgets exist for any of them.

| Dependency | Needed for | Candidate / notes | Trust assumptions | Status |
|---|---|---|---|---|
| RPC providers, EVM chains (Ethereum, BNB, Base, Arbitrum, Avalanche, Sonic, Monad) | Reads, simulation, submit, receipts, logs | Need at least two independent providers per chain; vendor not chosen | Provider can lie, censor, rate-limit, or go down; mitigated only by diversity and verification (not built) | not provisioned |
| RPC, Solana | Same; blockhash, account reads, sends | Vendor not chosen; likely also needs a landing/priority-fee service | Same | not provisioned |
| RPC / API, TON | Same; seqno, traces | Vendor not chosen | Same | not provisioned |
| RPC / API, Tron | Same; resources, expiration | Vendor not chosen | Same | not provisioned |
| Indexers / event streams | Leader tracking, new pool and launch detection, holder data, token metadata | Vendor not chosen; build-vs-buy undecided | Indexer can lag, miss events, or be wrong on reorgs | not provisioned |
| Price feeds / market data | Order triggers, portfolio, quote sanity | Vendor not chosen; on-chain pool price is the alternative | Feed manipulation, staleness | not provisioned |
| Aggregator (benchmark only) | `Router` benchmark label | Vendor not chosen; not an execution path in design | Benchmark quote may be wrong or promotional | not provisioned |
| Bridge providers | Cross-chain moves | Sources conflict: deBridge + Houdini vs Relay (unresolved). Our `BridgeProvider` has a `trust` field to record assumptions | Bridge contract/validator risk, liveness, loss of funds in transit, provider-reported status may be wrong; Houdini-style routing adds an intermediary | not provisioned |
| Telegram Bot API | Bot front end | Bot token not created | Telegram sees message content; account takeover risk | not provisioned |
| Telegram API id/hash (user's own) | Scraper, per Maestro design | Each user supplies their own from my.telegram.org; `apps/scraper` expects them via `Credentials` and never bundles them. Live use is BLOCKED | Session files are sensitive; `SessionStore` encrypts locally (AES-256-GCM/scrypt) but revoke does not end the server-side session | not provisioned |
| MTProto client library (e.g. gramjs / TDLib) | Real `TelegramTransport` for `apps/scraper` | Not chosen, not added; only `FakeTransport` exists. Needs supply-chain review | Third-party code handles the user's Telegram session | not provisioned (BLOCKED) |
| EVM chain config and verified venue addresses | Using `packages/evm` live: chain IDs, router, factory, wrapped native, init code hash, per-venue fee | None recorded; must come from official docs or verified explorers, never invented. Library takes them as injected parameters | A wrong address or init code hash routes funds to the wrong contract | not provisioned (BLOCKED) |
| `EthCall` implementation over an RPC | `V2Venue.load` reads (reserves, allowance, balance) | Interface exists; no implementation. Depends on the EVM RPC row above | See RPC rows | not provisioned |
| Fork / testnet tooling (archive-capable RPC, Foundry/anvil) | Moving rows up the CAPABILITY_MATRIX ladder | Not installed or configured | Fork results depend on the RPC's data | not provisioned |
| Charting license / provider | Charts in UI | Vendor not chosen; license terms unreviewed | Licensing cost and terms | not provisioned |
| Token metadata / security data (holders, LP lock, authorities) | Risk reports | Vendor not chosen | Data errors give false assurance | not provisioned |
| Signer infrastructure (HSM / MPC / KMS) | Real custody | Choice open | Vendor and operator trust | not provisioned |
| Cloud hosting, Postgres, Redis, Redpanda, ClickHouse | Production runtime | None selected; `deploy/` holds unapplied, unvalidated templates only | Cloud operator access | not provisioned |
| Payment rail for Premium | Premium billing | Currency unspecified in source; method undecided | Payment processor, chargeback, tax | not provisioned |
| Legal counsel / KYC / regulatory review | Launch decision | No engagement; jurisdictional analysis not done | n/a | not provisioned |
| Support staffing | User support, incident handling | No staffing plan | n/a | not provisioned |
| Security auditor / pen-test vendor | Audits | None engaged | n/a | not provisioned |
| Monitoring / alerting / on-call | Operations | None | n/a | not provisioned |
| Source docs access (Maestro pages not yet read) | Parity verification | Pages listed in FEATURE_PARITY.md | Public docs may differ from product behavior | partially read, rest not read |

No new external runtime dependencies were added by the scraper, EVM package or web terminal: they use only Node built-ins (`node:crypto`, `node:http`, `node:fs`, `node:test`) and in-repo code. What each needs from the owner before live verification is listed per stage in REAL_TESTING_REQUIREMENTS.md.
