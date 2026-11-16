<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: signer incident / suspected key misuse

1. **Revoke automation via the signer first**: disable automation for affected wallets (`wallets.automation_enabled = false`, `revoked_at`) through the signer's revoke path, so the signer denies further signing. Do this before investigating.
2. Confirm NetworkPolicy still limits signer ingress to the submission service; check for unexpected callers.
3. Review `signer_audit` (append-only) for sign/deny events by wallet, `request_id` and time. Do not alter it.
4. List non-terminal `tx_records` for affected wallets. Reconcile each (lookup by hash, nonce status) before deciding anything; do not rebuild or resubmit blindly.
5. If a key is suspected compromised: move funds per your custody procedure, rotate the `key_ref` target in the secrets/KMS system, record a `rotate` event in `signer_audit`.
6. Private keys are never in Postgres or env vars; if you find one, treat it as compromised.
7. Re-enable automation only after sign-off, one wallet at a time.
