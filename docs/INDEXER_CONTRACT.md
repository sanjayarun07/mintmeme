# Indexer contract

The terminal can read market data from **our own indexer** instead of polling a third-party API. The indexer is a separate service (see `indexer/`); the terminal only needs it to speak this small HTTP contract. Set `INDEX_URL=http://host:port` to turn it on. Without `INDEX_URL` nothing changes: the terminal keeps using GeckoTerminal polling.

When `INDEX_URL` is set the terminal asks the indexer first and falls back to the third-party feed for a cycle when the indexer is unreachable, answers with an unexpected shape, or reports it is more than `INDEX_MAX_LAG_S` seconds (default 60) behind the chain. The Whale page response carries `index: { name, serving, lastOkAt, lastError, lagS }` so you can see which source answered and why.

The terminal treats every response as untrusted: items are validated one by one (known pool, matching chain, finite non-negative USD, bounded string lengths, valid timestamp) and anything malformed is dropped.

## Endpoints (implemented by the terminal client today)

### `GET /trades?pools=<comma list>&since=<ISO time>&limit=<n>`
Swaps in the given pools, newest or oldest first (the client sorts). `since` is optional; the client sends the time of the newest trade it has seen.

```json
{ "items": [
    { "pool": "0x…", "chain": "ethereum", "side": "buy", "wallet": "0x…", "usd": 1200.5, "tx": "0x…", "t": "2026-11-15T10:00:00.000Z" }
  ],
  "health": { "lagS": 2 } }
```

- `chain` is `ethereum`, `bnb` or `solana`. `side` is `buy` or `sell` relative to the token (not the quote asset).
- `usd` is the trade value at the time of the swap, computed by the indexer from pool reserves and a documented quote price.
- `wallet` is the transaction sender as read from the chain.

## Endpoints (planned, used in later steps)

- `GET /wallet/<address>/trades?chain=&token=` — token trades for a wallet. Amounts that can exceed 2^53 are **strings** (base units).
- `GET /token/<chain>/<contract>/holders?limit=` — top holders from transfer events.
- `GET /pairs/new?chain=&since=` — newly created pools.
- `GET /lag` (Ponder reserves `/health` for itself) — `{ "lagS": <seconds> }`.

Read-only: the indexer never holds keys and the terminal never sends anything to it except pool lists.
