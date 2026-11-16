# Custody and Signing

Date: 2026-11-13.

## Honest status statement

The current signer (`packages/core/src/signer.ts`, class `PolicySigner`) is an in-process stand-in. "Signing" is `HMAC-SHA256(walletSecretString, txDigest)`. It does NOT produce chain-valid signatures, it is NOT an HSM, NOT MPC, NOT a TEE, and has no key isolation: keys and policies are plain values in the same process memory as the engine. Its value today is exercising the policy interface and failure paths. It must not be used with real keys or funds.

## 1. Custody model (target specification, not built)

| Wallet class | Purpose | Key location | Signing path |
|---|---|---|---|
| Generated trading wallets | Automated and bot trading (snipes, copy, orders) | Generated inside an isolated signer service; never exported in plaintext to the app tier | Signer checks policy on every request; app tier sees signatures only |
| External wallets | Interactive use, user holds keys | User's wallet | User signs in their own wallet; we build and simulate the tx, never hold keys |
| Watch-only | Tracking, copy leaders, monitors | No key | None |
| Imported keys | Opt-in only, explicit risk acknowledgement, off by default | Same isolated signer after import; the import channel (Telegram message) is a leak risk and should be discouraged | Same as generated wallets |
| Session keys / delegated authority | Only on chains/accounts that support scoped delegation natively | On-chain scoped permission, revocable on-chain | Not designed; support varies by chain and is unverified |

Principle: the user-facing chat channel can request actions within pre-approved policy but can never expand policy, add withdrawal destinations, or approve withdrawals alone.

## 2. Policy fields (from `signer.ts`)

`WalletPolicy`:
| Field | Meaning | Enforced as |
|---|---|---|
| `userId` | Owner | Request `userId` must match, else "wallet belongs to another user" (tenant isolation) |
| `chains` | Allowed chain ids | Else "chain not allowed" |
| `allowedVenues` | Venue families the wallet may swap on | Swaps only; else "venue not allowed" |
| `maxPerTx` | Per token max amount | Missing entry or exceeded -> "exceeds per-tx limit" (default deny for unlisted token) |
| `dailyLimit` | Per token per day cap | Tracked per wallet+token+day in memory; exceeded -> "exceeds daily limit" |
| `destinations` | Transfer allowlist | Transfers only; else "destination not allowlisted" |
| `automationRevoked` | Kill switch | Denies swaps whose origin is not `manual` |
| `deviceSecret` | Key for the separate secure-confirmation device | Used to verify withdrawal approvals |

`SignRequest`: userId, walletId, chain, kind (`swap` | `transfer` | `noop`), token, amount, venue, to, digest, origin, approval, day. `noop` is nonce-replacement housekeeping: tenant isolation and chain checks still apply, but there are no venue, limit, or automation checks and no charge (it moves no value). Every allow/deny is appended to `audit` (day, wallet, kind, decision, reason, digest); the device secret is not logged (asserted by test 12). Releases are audited as `kind: 'release'`.

Daily-limit accounting: `sign` charges the amount against (wallet, token, day), idempotently per digest (re-signing the same digest never double-charges). `release(digest)` refunds a charge and is called by the engine only when the tx can never be included (submit rejected, expired and absent, nonce consumed by another tx, or cancelled/replaced). A charge is kept once the tx was included, even if it reverted (conservative, fail-closed). Spend and charge records go through a `SpentLedger` seam; `MemoryLedger` supports snapshot/restore, and tests show limits and releases surviving a signer restart. Write order (charge: spent then marker; release: tombstone then spent) means a crash between writes can leave the counter too high, never too low. No durable `SpentLedger` implementation exists, and the fuzz test does not crash mid-write.

Limitations in the stand-in: with the default `MemoryLedger` the counters are lost on process loss unless the caller snapshots; `at` in the audit is a day number, not a timestamp; a tx charged at sign time that is merely slow still holds allowance until it resolves; `day` is supplied by the caller; policy mutation (`revokeAutomation`) is a direct method call with no authentication; swap destination (the receiving address) is not part of the policy; no per-venue contract address pinning; no cumulative cap across tokens.

## 3. Secure confirmation flow for withdrawals (spec; check logic implemented, flow not)

1. Request arrives (any channel, including Telegram). System builds the transfer and its `digest`.
2. Destination must already be on the allowlist. Adding a destination is itself a secure-confirmation action, with a proposed time delay and notice on all channels.
3. User is shown the full details (asset, amount, destination, chain, fees) on a SEPARATE device/app and approves there with a device-held key. The approval is `HMAC(deviceSecret, "approve:" + digest)` in the stand-in; a real design would use an asymmetric signature from a hardware-backed key, bound to digest, expiry, and a nonce.
4. Signer verifies approval in constant time, then limits, then signs.
5. Telegram session control alone yields "missing or invalid secure confirmation" (test 12 covers: no approval, forged approval, non-allowlisted destination, over limit, cross-tenant, and success with valid approval).

Not built: device enrollment and recovery, approval expiry and replay protection, asymmetric keys, allowlist-change delay, out-of-band notifications.

## 4. Key lifecycle (spec)

| Stage | Requirement |
|---|---|
| Generation | Inside the isolated signer; entropy source documented; public address returned only |
| Storage | HSM or MPC-held; encrypted backups with split custody; no plaintext at rest |
| Use | Policy check, rate limit, audit per request; no bulk-export API |
| Rotation | New wallet generated; funds moved by a secure-confirmed transfer; old wallet disabled |
| Backup/recovery | Documented and drilled; key shares held by separate parties |
| Export | Only on explicit user request through secure confirmation, with warnings; logged |
| Destruction | Deletion on account closure after balances are zero; retention of audit records |

## 5. Revocation

- Automation kill switch: `revokeAutomation(walletId)` denies all non-manual swaps (test 12). Needed additionally: automatic revocation triggers (anomaly, user command from any authenticated channel), propagation to in-flight intents, and cancellation of open orders and reservations.
- Device key revocation, session-key revocation on-chain, and import-key quarantine: not designed in code.
- Fail-closed rule: unknown wallet, missing policy field, or missing token limit all deny.

## 6. Not provided today

HSM/MPC, attestation, asymmetric signatures, real chain signature schemes (secp256k1, ed25519 for Solana/TON, Tron signing), key backup, multi-party approval, third-party audit, incident runbook.
