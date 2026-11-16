<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: RPC outage / divergence

1. Confirm scope: one provider or all? Compare block height and latest hash across providers.
2. Fail over reads to a healthy provider. Do not trust a single lagging or forked node for nonce or receipt decisions.
3. Pause new submissions if fewer than two providers agree. In-flight txs stay as-is.
4. **A failed or timed-out broadcast is not a failed transaction.** Leave the record in `submitted`/`pending`.
5. On recovery, reconcile every non-terminal `tx_records` row: lookup by hash, then nonce status, before any resubmit. Resubmit means the same signed tx and nonce.
6. Resume submissions; watch the reconciler backlog and `outbox` lag drain.
7. Post-incident: check for duplicate ledger entries (key uniqueness should have prevented them) and delayed notifications.
