# Launch stream: live read-only check (Solana mainnet)

Run: 2026-11-14T18:24:04.394Z
Listened: 45 s (+8 s to finish decoding), endpoint wss://api.mainnet-beta.solana.com; decoding through the Alchemy HTTP node.

What this shows: new Pump.fun token creations and Raydium AMM v4 pool creations pushed over a WebSocket log subscription, decoded from the transaction, mint-checked, and dry-run against the example sniper rules. Nothing is signed or sent.

## Observed
- notifications received: 24; matched the creation filter: 24; decoded into items: 24; failed to decode: 0; reconnects: 0
- feeds: raydium-v4 subscribed=true received=0; pump-fun-create subscribed=true received=24
- seen-to-block-time lag (seconds, our receive time minus the cluster's block time, whole-second resolution): median 1.5, min 0.7, max 16.6 over 24 items
- items whose name/symbol were read from the Token-2022 metadata extension: 24 of 24
- last error: none

## Items
| Venue | Symbol | Name | Mint | Risk | Lag s |
|---|---|---|---|---|---|
| Pump.fun | TRASH | TRASH KING | CerJ3BzxSCrCNmbRjVgwYWjWcCK5ihw4vfgmKhiypump | quarantined | 1.1 |
| Pump.fun | MAYHEM | Mayhem Mode Coin | DgVQmZmEzZVp5qBzZ34AovLzQebecXuwXQuF2XbJpump | quarantined | 1.1 |
| Pump.fun | BRR | Frozen Cat | 9sgE7dmn6YiBfBz1Hs3cwgPtFFoKDAaZAbnSLvB7pump | quarantined | 1.7 |
| Pump.fun | THISTLY | Thistly | 8Jrvn6cFaXaMsszVSCnA1pd1cRNkR7YyZhsswwTDpump | quarantined | 1 |
| Pump.fun | peekaboo | peekaboo | 6hY1cRVNDkX88o39mwzikn1iL7C63mbdS5uX2YSEpump | quarantined | 1.5 |
| Pump.fun | Alexa | alexa | DvYStniVmms152yB4xqKWLxqHNe9NkaD9UiWju9Jpump | quarantined | 1.5 |
| Pump.fun | STARSHIP | STARSHIP | fbxZVnwjGwumY1Cqn2TVkVWiqpEzeCGJjbZ15rBpump | quarantined | 1.4 |
| Pump.fun | ROT | brainrot | DQecMMGz1QH6mFCANUupvo1EBPh8FcB9HRWwFwqapump | quarantined | 1 |
| Pump.fun | RIch Cat | RIch Cat | 83XmBYoHDF1VSQm1EE5bm2skyeEsuAAFuxpHs5iMpump | quarantined | 0.9 |
| Pump.fun | RIch Cat | RIch Cat | GyT162xC62eRJjdrYK3MN6CDRDBsZ33XSiZpKo6Jpump | quarantined | 1.3 |
| Pump.fun | JSI | Jensen Sex Inu | EXHgqP5Db7r81eZvnYxvgR557GKDUe8Wh5hALyUSpump | quarantined | 1.2 |
| Pump.fun | Fox | Megan Fox | 44tHZe6FQcbcedD5BTqqfVqwmHbh9MoUEfye8ZnEpump | quarantined | 1.4 |
| Pump.fun | down Shrek | Down Shrek | Z6MVkJxRRjy1RjHmwnnodJJn1Vua37nqAfKUBPrpump | quarantined | 1.3 |
| Pump.fun | billie | billie | CwvJhS2LP5zX6fVCRpkLnbkM1JmjUBvcyJWCxFznpump | quarantined | 0.7 |
| Pump.fun | SPM | Simpsons Prediction Market | J2Tysmza7vRiVhm8akvBSScruDmozL5aBw4FXWNepump | quarantined | 0.7 |
| Pump.fun | BINGO | COIN SCRATCH FEVER | 9WAuRh9vN1Hp8HWc3wZrjGqinqBk3hWTL5zBTxRspump | quarantined | 16.6 |
| Pump.fun | PIGEON | Pigeon Tweeting | HABj3XxtEhYpRhSNwY15umWK5h6vU1JiN6UbuHDepump | quarantined | 15.6 |
| Pump.fun | billie | billie | 3531MEu4B5n5RvTP3mWQQWJv9uNRD4Z5SYGcqYkppump | quarantined | 9.6 |
| Pump.fun | ROT | brainrot | 9YtGWunXeop87PQVykAopJkjQCArSafnDCWdKR7kpump | quarantined | 13.6 |
| Pump.fun | billie | billie | FwPpogAP7UmrKC9zsdFyzZ8iGghDun6GjMCK8vdwpump | quarantined | 8.6 |
| Pump.fun | VICE | vicegame | 6nnK2wgbVQRicLNnPaw1AEqamGz1PxKcEnsPUDrepump | quarantined | 3.6 |
| Pump.fun | pickle | pickle ball 🥒  | Cu5YGc98D1cgPzsDSm13jywqgZ9ougayxAhYMrJDpump | quarantined | 2.6 |
| Pump.fun | billie | billie | 6JVDUnauF7SnsSG9iQPfbN7FLD86sZXt7RETKSyMpump | quarantined | 2.6 |
| Pump.fun | LTL | LIETUVOS LITAS | 5Eie2wTDbBXDMp7rn3LspjGqB64FsXusQvUyicRipump | quarantined | 2.7 |

## Not covered
- Raydium v4 pool creations are rare (about one every few days): a short run usually sees none. The Raydium decode is covered by the polled-list mainnet check and unit tests, not by this run unless a row above says Raydium.
- Confirmed commitment, not finalized. A dropped socket leaves a gap that is counted but not backfilled.
- Public endpoint: rate limited, no SLA. No mempool and no pre-confirmation view: nothing here is faster than a mined transaction.
