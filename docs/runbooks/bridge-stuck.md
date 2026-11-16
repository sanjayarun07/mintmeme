<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: bridge transfer stuck

1. Find the source-chain `tx_records` row and its `claims` row (`claim_id` is unique, so a claim cannot be double-processed).
2. Verify the source tx first: lookup by hash and nonce status. If the source tx is unconfirmed, follow `stuck-transaction.md`; do not start the bridge flow over.
3. If the source is confirmed, check the bridge's own status (message/claim ready, proof or attestation available, finality window elapsed). Waiting is often the correct action.
4. If a destination claim is ready: submit it under the existing `claim_id` / idempotency key. Before any resubmit, lookup destination hash and nonce status.
5. Do not create a second claim or a second source transfer to "retry"; funds would be at risk of double-spend or loss.
6. Keep reservations held until the claim is confirmed or the bridge confirms refund; record ledger movements by unique key only.
7. Escalate to the bridge operator with source hash, claim_id and timestamps if the delay exceeds the documented window.
