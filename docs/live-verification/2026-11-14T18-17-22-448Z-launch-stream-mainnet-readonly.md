# Launch stream: live read-only check (Solana mainnet)

Run: 2026-11-14T18:17:22.448Z
Listened: 45 s (+4 s to finish decoding), endpoint wss://api.mainnet-beta.solana.com; decoding through the Alchemy HTTP node.

What this shows: new Pump.fun token creations and Raydium AMM v4 pool creations pushed over a WebSocket log subscription, decoded from the transaction, mint-checked, and dry-run against the example sniper rules. Nothing is signed or sent.

## Observed
- notifications received: 30; matched the creation filter: 30; decoded into items: 7; failed to decode: 23; reconnects: 0
- feeds: raydium-v4 subscribed=false received=0; pump-fun-create subscribed=false received=30
- seen-to-block-time lag (seconds, our receive time minus the cluster's block time, whole-second resolution): median 0.8, min 0.5, max 1.7 over 7 items
- items whose name/symbol were read from the Token-2022 metadata extension: 7 of 7
- last error: pump-fun-create: could not decode 3hGQuLUh…: transaction not available yet

## Items
| Venue | Symbol | Name | Mint | Risk | Lag s |
|---|---|---|---|---|---|
| Pump.fun | GHOST | Ghost | 9tb8rR96EzWPT4FDAC71wDweEPRWvcBUwLEHfe8Gpump | quarantined | 0.5 |
| Pump.fun | kibble | CA POSTED ON BIO | 5Sv5EuppzwGMyfZuFKHDTpwAgpV8kQ73aSWTtfCCpump | quarantined | 0.9 |
| Pump.fun | Fine | Ok That's Fine | 76469VEX3XSW8xcd3RrSG7VXibUcHLSyiNip3pippump | quarantined | 0.7 |
| Pump.fun | Dumpcoin | Dumpcoin | EspMaVgvqv36KkFcSewJc7XvNMCQrJtW65gJAKfApump | quarantined | 0.5 |
| Pump.fun | Microsoft  | Microsoft Ignite 2026 | EHLsBnMTJgc71pUofrKjUHdfSVDQHXTjYh7fh5Qxpump | quarantined | 1.3 |
| Pump.fun | RIZZMAS | RIZZMAS3 | 93muY85Ysro5c6FaWLFhhnbktMhY78G4ef2yb77Upump | quarantined | 1.7 |
| Pump.fun | kibble | CA POSTED ON BIO | BCVTP3gGh4WEy4i1BhYAprn2Y8s856rwrq6QavGFpump | quarantined | 0.8 |

## Not covered
- Raydium v4 pool creations are rare (about one every few days): a short run usually sees none. The Raydium decode is covered by the polled-list mainnet check and unit tests, not by this run unless a row above says Raydium.
- Confirmed commitment, not finalized. A dropped socket leaves a gap that is counted but not backfilled.
- Public endpoint: rate limited, no SLA. No mempool and no pre-confirmation view: nothing here is faster than a mined transaction.
