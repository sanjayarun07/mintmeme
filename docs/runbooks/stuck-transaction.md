<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: stuck transaction

**Principle: reconcile before resubmit.** Never build a new tx until you have checked the chain.

1. Find the `tx_records` row by `idempotency_key`; note `state`, `nonce`, `hash`, `wallet_id`.
2. Look up by `hash` on at least two RPC endpoints. If found/mined: record the receipt, move to `confirmed`/`reverted`, stop.
3. Check nonce status for the wallet: compare on-chain confirmed and pending nonce with `nonce`.
   - On-chain nonce > `nonce` but our hash missing: another tx used the nonce (replaced). Look up by nonce, mark `replaced`, and reconcile ledger by key.
   - Nonce still unused: the tx is merely pending or dropped.
4. If pending/dropped and we hold the signed `tx`: **resubmit the same signed tx, same nonce** (rebroadcast). Do not re-sign or allocate a new nonce.
5. Only if the tx is confirmed dropped AND nonce is still unused AND a fee bump is required: request a replacement via the signer for the **same nonce**; audit it in `signer_audit`.
6. Never edit `nonce_allocations` by hand to "skip" a nonce; a gap blocks every later tx for that wallet.
7. Record the outcome and timeline in the incident notes.
