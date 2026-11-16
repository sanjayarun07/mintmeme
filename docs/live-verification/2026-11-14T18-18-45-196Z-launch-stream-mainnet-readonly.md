# Launch stream: live read-only check (Solana mainnet)

Run: 2026-11-14T18:18:45.195Z
Listened: 45 s (+8 s to finish decoding), endpoint wss://api.mainnet-beta.solana.com; decoding through the Alchemy HTTP node.

What this shows: new Pump.fun token creations and Raydium AMM v4 pool creations pushed over a WebSocket log subscription, decoded from the transaction, mint-checked, and dry-run against the example sniper rules. Nothing is signed or sent.

## Observed
- notifications received: 24; matched the creation filter: 24; decoded into items: 2; failed to decode: 12; reconnects: 0
- feeds: raydium-v4 subscribed=true received=0; pump-fun-create subscribed=true received=24
- seen-to-block-time lag (seconds, our receive time minus the cluster's block time, whole-second resolution): median 1.2, min 0.6, max 1.2 over 2 items
- items whose name/symbol were read from the Token-2022 metadata extension: 2 of 2
- last error: pump-fun-create: could not decode 55LU1WfR…: transaction not available yet

## Items
| Venue | Symbol | Name | Mint | Risk | Lag s |
|---|---|---|---|---|---|
| Pump.fun | SORRY | I'M SORRY | 8KMNfeZApNkuyKVU8cNaXeoF1Rd7AoHBTkVu1sbmpump | quarantined | 0.6 |
| Pump.fun | Minecraft | Minecraft MID-OFFS | 4GJryZaqBDcPZbDLAEVGpy6ekP7BZQsUgckHLY5bpump | quarantined | 1.2 |

## Not covered
- Raydium v4 pool creations are rare (about one every few days): a short run usually sees none. The Raydium decode is covered by the polled-list mainnet check and unit tests, not by this run unless a row above says Raydium.
- Confirmed commitment, not finalized. A dropped socket leaves a gap that is counted but not backfilled.
- Public endpoint: rate limited, no SLA. No mempool and no pre-confirmation view: nothing here is faster than a mined transaction.
