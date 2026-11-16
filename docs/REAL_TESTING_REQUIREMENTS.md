# Real Testing Requirements

Date: 2026-11-13. This lists, per stage, what the owner must provide before any live verification can start. Today nothing below exists in the repo or has been provisioned (see DEPENDENCY_REGISTER.md). The status ladder these stages map to is in CAPABILITY_MATRIX.md; the final gates are in PRODUCTION_READINESS.md (all boxes unchecked).

## Ground rules (apply to every stage)

- **No real customer funds in any demo.** Demos use burner wallets holding tiny testnet funds only.
- No real private keys, seed phrases, bot tokens, API keys, API id/hash or session strings are ever committed to the repo, pasted into chat, or placed in test fixtures. They live in a secrets manager or local untracked env files and are injected at runtime.
- Burner wallets are generated fresh for testing, never reused for anything else, and never funded beyond what a test needs.
- Contract addresses, chain IDs, program IDs, ABIs and init code hashes are copied from the venue's or chain's official documentation or a verified block-explorer page, with the source URL and retrieval date recorded next to the value. We never invent or guess them, and we never take them from a Telegram message, a search snippet or an LLM.
- Every stage records evidence (dated, with tool versions, block numbers, tx hashes) and a row only moves up the ladder with that evidence.

## (a) Read-only mainnet

Goal: quotes, simulations and reads compared with the real venue; no funds move; no signing keys needed.

Owner provides:
- RPC endpoints per chain in scope: your own node or a provider account per chain, with at least two independent sources where possible. Record plan limits (requests per second, monthly quota, archive access, WebSocket support, `eth_call` and log-range caps) so tests respect them.
- Official chain configuration per chain (chain ID, native token and wrapped-native address, block time and finality guidance) taken from the chain's official docs, plus block-explorer API keys for contract verification and source lookups.
- Venue contract addresses (routers, factories, quoters, init code hashes, fee parameters) taken from each venue's official docs or verified explorer pages. The resolved chain list (the documented 12 vs 13 conflict) must be decided first so we know which chains are in scope.
- Solana, TON and Tron: RPC access and indexer access (account and program reads, token metadata, TON traces, Tron resource and energy data), again with documented rate limits.
- A decision on which venues per chain are in scope for the first pass.

Not yet possible without the above: any `EthCall` implementation, any real `V2Venue` config, any Solana/TON/Tron adapter.

## (b) Fork tests

Goal: run adapters against forked real-chain state at a pinned block; assert quote vs executed output within a stated tolerance.

Owner provides:
- Archive-capable RPC for each chain forked (archive state is needed for pinned historical blocks) with enough quota for fork reads.
- Foundry/anvil installed on the test machines (EVM), and equivalents for other families where they exist (a Solana validator with cloned accounts; TON and Tron local emulation if available). Pin tool versions.
- A per-venue fork block pin: chain, block number and block hash, chosen and recorded by the owner, plus the contract upgrade date check so evidence is not older than the venue's last upgrade.
- Verified token fixtures for edge cases (fee-on-transfer, rebasing, honeypot-like behavior) identified from trusted sources, to be used only inside the fork.

## (c) Testnet

Goal: execute buy and sell on a public testnet with recorded tx hashes.

Owner provides:
- Testnet RPC endpoints per chain.
- Faucet-funded burner wallets, generated for this purpose. Keys are held outside the repo; funding amounts are tiny and only from public faucets. Never a mainnet key, never customer funds.
- Testnet deployments of venues, or verified testnet deployments published by the venue with an official source. If a venue has no testnet deployment, the row stays at Fork tested; we do not deploy our own copy and call it the venue.
- Testnet block-explorer access for evidence links.

## (d) Telegram

Goal: exercise the bot and the scraper against real Telegram in a controlled setting.

Owner provides:
- Bot: a bot token from BotFather for a dedicated test bot (not a production bot), stored in the secrets manager.
- Scraper: API id and API hash from my.telegram.org for a dedicated test account (each real user would supply their own; the app never bundles any), and a decision on the MTProto client library (for example gramjs or TDLib), including supply-chain review. `apps/scraper` currently runs only against `FakeTransport`; live use is BLOCKED until a real `TelegramTransport` is written and reviewed.
- A private test group and test channels the test account already belongs to, seeded with synthetic signal messages (placeholder or testnet addresses only).
- A plan for session revocation: `SessionStore.revoke()` only wipes the local blob, so the test account's server-side session must also be ended in Telegram (Settings, Devices) after each run.

## (e) Signer

Goal: replace the in-process HMAC stand-in (CUSTODY_AND_SIGNING.md) before any real signature is produced.

Owner provides:
- The choice of HSM, KMS or MPC provider and an account with it, including supported curves per chain family (secp256k1 for EVM and Tron, ed25519 for Solana and TON) and the vendor's trust assumptions.
- A documented key ceremony: who attends, how keys are generated, backed up, recovered and rotated, and a recovery drill.
- A secure confirmation device or flow (WebAuthn/passkeys or a hardware device) for withdrawals and limit changes, with enrollment and replay protection requirements.
- Separate test-environment keys, clearly isolated from any production key material.

## (f) Infrastructure

Owner provides accounts and budgets for:
- Postgres (system of record; `deploy/schema.sql` is an unapplied template), Redis (locks, rate limits), Redpanda (events, outbox relay) and ClickHouse (analytics) or a deliberate decision to drop any of them.
- Observability: metrics, traces, logs, alerting and on-call (templates under `deploy/` are unvalidated).
- A secrets manager and an access policy for it, plus CI/CD and environments (staging separate from any production).
- Hosting for the web app if it is ever shared: `apps/web` has no authentication and is not restricted to loopback, so it must stay on a trusted machine until real auth exists.

## (g) Bridge providers

Owner provides:
- Accounts and API keys with the chosen bridge provider(s), and the provider's documented trust assumptions (validators, custody during transit, liveness, failure and refund behavior) recorded in the `BridgeProvider` `trust` field.
- A decision on the open source conflict: deBridge plus Houdini versus Relay. This is UNRESOLVED (the bridge page was not read). Until it is resolved, no provider integration starts.
- Testnet or small-amount support from the provider for burner-wallet testing, if available.

## (h) Price and chart data licences

Owner provides:
- A price/market-data vendor (or an approved decision to use on-chain pool prices) with terms permitting our use, and any required API keys.
- A charting library or provider licence reviewed for commercial use, and attribution/redistribution terms for any displayed data.
- Token metadata and security data licences (holders, LP lock, authorities) if risk reports will use them. Reports remain heuristics, not safety certificates.

## (i) Legal, compliance, audits, support

Owner provides:
- Legal counsel and a jurisdictional review (licensing, registration, KYC/AML position, terms of service, privacy policy, risk disclosures, data protection for Telegram sessions).
- An engaged independent auditor for the signer, API, fee handling and each adapter, and a penetration-test vendor.
- Support staffing and escalation, an incident response plan, and kill-switch ownership for staged rollout (internal, capped-funds beta, public).
- A payment rail and currency decision for Premium, if billing is in scope.

## Order of work

1. Resolve the conflicts (chain list, bridge provider) and choose in-scope chains and venues.
2. (a) read-only mainnet, then (b) fork, then (c) testnet, in the order of the CAPABILITY_MATRIX ladder.
3. (d), (e), (f) in parallel with the above; (e) must be complete before any real signature.
4. (g), (h), (i) before any funded or public use.

Demos at every stage: burner wallets with tiny testnet funds only; no real customer funds.
