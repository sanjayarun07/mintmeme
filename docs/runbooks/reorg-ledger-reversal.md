<!-- TEMPLATE — not applied or validated against a live environment. -->
# Runbook: chain reorg and ledger reversal

`ledger_entries` is append-only (trigger blocks UPDATE/DELETE/TRUNCATE). Corrections are new entries.

1. Identify the affected tx: look up by hash, and by wallet nonce (the reorg may have replaced it with a different tx).
2. Wait for the configured finality depth before acting on a shallow reorg unless the tx is clearly gone.
3. Find ledger entries linked via `tx_record_id`; list their `key` values.
4. **Reverse by key**: insert a new entry per original with `reverses_key = <original key>`, negated amount, and a deterministic new key (e.g. `reverse:<original key>`). The unique indexes make the reversal idempotent; a duplicate insert failing is expected and fine.
5. Update `tx_records.state` (`dropped`/`replaced`/`reverted`); release or re-create `reservations` as appropriate.
6. If the tx re-confirms in a later block, reconcile again; apply fresh entries with new keys, never edit old ones.
7. Emit corrective events through `outbox`; consumers dedupe via `inbox.message_id`.
