# Production Readiness Checklist

Date: 2026-11-13. All boxes are unchecked: nothing here has been done. Items marked (local) have some SimChain-level coverage but do not satisfy the real gate. Local status as of this revision: 110 tests pass in one `npm test` run (84 core, 4 telegram, 11 scraper, 11 evm); that is simulation, fake-transport and recorded-fixture evidence only and satisfies no gate below. Per-stage owner prerequisites are in REAL_TESTING_REQUIREMENTS.md.

## Security and custody
- [ ] Independent smart-contract / program interaction review for each adapter
- [ ] External security audit of signer, API, and fee handling
- [ ] Real HSM or MPC signer replacing the in-process HMAC stand-in (local: policy checks, charge/release, ledger seam exist on the stand-in)
- [ ] Chain-valid signature schemes per family (EVM, Solana, TON, Tron)
- [ ] Device-key secure confirmation flow with enrollment, expiry, replay protection (policy check is local only)
- [ ] Withdrawal allowlist change delay and multi-channel notification
- [ ] Key backup, recovery drill, and rotation runbook
- [ ] Secrets management; no secrets in logs or constructors (local: scraper session store encrypts at rest with a secrets-never-in-output test; revoke does not end the Telegram server-side session)
- [ ] Penetration test; bug bounty decision
- [ ] Supply-chain controls: lockfiles, SBOM, dependency review, reproducible builds
- [ ] Rate limiting, abuse and anomaly detection, automatic automation revocation (local: caller-supplied abuse flags accepted by `accrue`)

## Correctness and verification
- [ ] Fork tests per venue per chain (CAPABILITY_MATRIX.md ladder) (local: `packages/evm` calldata/math tested offline against vectors and recorded fixtures only; no fork run)
- [ ] Testnet runs where venues are deployed
- [ ] Mainnet read-only quote comparison per venue
- [ ] Fill extraction from real receipts/logs/traces per chain
- [ ] Fee-on-transfer, rebasing, Token-2022, and jetton edge-case suites
- [ ] Nonce cancel/replace and stuck-nonce recovery (local: no-op replacement on SimChain; real nodes need replace-by-fee)
- [ ] Solana blockhash expiry, TON seqno/expiry, Tron resource/expiration handling tested
- [ ] Reorg handling tested with real finality definitions (local: shallow `reorgReinclude` and fuzz)
- [ ] Multi-provider RPC disagreement handling
- [ ] Copy-trade reorg unwind and net-exposure caps (local: net-exposure caps and orphan flagging exist; pending sells unreserved; no automatic unwind by design)
- [ ] Re-run and review existing tests (local: 187 pass; seeded fuzz covers the engine/signer only); add property and fuzz tests for ledger, reservations, copy, orders; fuzz with crashes between send and persist

## Infrastructure
- [ ] Postgres store replacing in-memory `Store`; transactional outbox and inbox
- [ ] Redis or DB-backed distributed locks/leases; multi-worker safety
- [ ] Redpanda event bus; ClickHouse analytics (or deliberate decision to drop)
- [ ] Listener services (leader tracking, launches, price snapshots)
- [ ] Reconciliation sweeper service
- [ ] Telegram bot, production web app, scraper desktop app with a real MTProto client (local: `apps/telegram` handler stub; `apps/web` "Tideline" practice terminal on the simulated chain, hand-checked only, no automated UI tests, no auth; `apps/scraper` library with fake transport, live BLOCKED)
- [ ] Real EVM adapter: chain config, RPC `EthCall`, signing, submission (local: `packages/evm` offline calldata/math only)
- [ ] Automated browser/UI tests for the web app
- [ ] Tier limits enforced across all features, not only price orders (local: web enforces price orders only)
- [ ] Helm / Terraform, environments, CI/CD (templates exist under `deploy/`, unapplied and unvalidated)
- [ ] Load tests and performance targets (`bench/bench.ts` is an in-process fixture benchmark, not a network or load test)
- [ ] Observability: metrics, traces, alerts, on-call, runbooks
- [ ] Backups, disaster recovery, restore drill

## Product
- [ ] Read the unread Maestro pages and update FEATURE_PARITY.md
- [ ] Resolve 12-vs-13 chain conflict and bridge-provider conflict
- [ ] Premium entitlements, billing, currency decision (local: placeholder tiers and subscriptions ledger only)
- [ ] Fee model: Solana in-tx, other chains accrue-and-extract above minimum (local: `FeeCollector` model, not wired into Engine, no real extraction)
- [ ] Referral payout flow and abuse controls wired into accrual (local: `accrue` accepts flags; caller computes them; payout is a ledger move)
- [ ] Portfolio, monitors, whale/wallet/buy bots, Launch Simulator, trending, competitions, campaigns (if in scope) against real data sources (local: pure-logic implementations exist; trending lacks a differencing defense)

## Legal, compliance, operations
- [ ] Legal counsel engaged; jurisdictional review; licensing and registration analysis
- [ ] KYC/AML position decided
- [ ] Terms of service, privacy policy, risk disclosures (including that risk reports are not safety certifications)
- [ ] Data protection assessment for Telegram sessions and user data
- [ ] Support staffing and escalation process
- [ ] Incident response plan and communications template
- [ ] Charting and data-provider license review
- [ ] Staged rollout: internal, capped-funds beta, public; kill switches defined
