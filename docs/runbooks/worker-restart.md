<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: worker restart / crash recovery

Restarts are safe by design: state is in Postgres, writes are idempotent.

1. Restart the deployment (`kubectl rollout restart deployment/<release>-<component>`); keep reconciler single-writer unless leader election exists.
2. On start, the reconciler must scan non-terminal `tx_records` (`signed`, `submitted`, `pending`) and reconcile each: lookup by hash, then nonce status, before any resubmit. Resubmit means the same signed tx and nonce.
3. A crash between nonce allocation and signing leaves a `nonce_allocations` gap candidate: check for unused allocated nonces before issuing new ones; do not skip nonces.
4. `outbox`: unpublished rows (`published_at IS NULL`) are re-published; duplicates are absorbed by consumer `inbox.message_id`.
5. Replayed events are safe: ledger `key` and `claims.claim_id` are unique, so reprocessing cannot double-apply.
6. Verify: backlog drains, no growing count of `pending` older than expected, no new errors in logs.
