# Maestro copy-trade and funds-management parity

Status key: **Implemented-local** = engine logic + tests against SimChain only (not fork/testnet/mainnet verified). **Not implemented** = deliberately absent, reason given.
Sources: https://docs.maestrobots.com/sniper/copytrade-buys.md, copytrade-sells.md, funds-management.md (settings names as documented there).

## Copy-trade settings
| Maestro setting | Status | Notes |
|---|---|---|
| Max Buy | Implemented-local (`maxBuy`) | Caps one copied buy after Buy %. |
| Buy % (up to 1000%) | Implemented-local (`ratioBps` ≤ 100000) | Validated at engine construction. |
| Track Only | Implemented-local (`trackOnly`) | Rules run, "track-only: would buy/sell …" is logged; nothing emitted, no allocation/cooldown/daily consumed. |
| Auto Buy Checks: Min/Max MC, Min/Max Liquidity, Max Buy/Sell Tax | Implemented-local (`checks`) | Missing data (market cap, tax) ⇒ skip with reason (fail closed). Tax/market cap come from the `info` dep in CopyRunner; no real source is wired yet. |
| Duplicate Buy | Implemented-local (`duplicateBuy:false` blocks) | Counts held and in-flight. |
| Price Impact Alert (default 20%) | Implemented-local (`priceImpactAlertBps`) | Skips; never raises slippage. Unquotable ⇒ skip. |
| Copy Sell (same %) | Implemented-local (existing) | Sells the same percentage of **our attributed inventory**, not the whole wallet holding (safer; differs from Maestro). |
| Sell filters (stablecoins / airdrop traps) | Implemented-local (`stablecoins`, non-swap events ignored) | |
| TP / SL / Trailing SL | Existing exit engine, not re-done here | |
| Blind Follow, Frontrun (ETH/BSC), Multi Buy | Not implemented | Need mempool access and a latency-sensitive signer; unsafe without that infrastructure. |
| Smart Slippage, Gas Price/Delta | Not implemented | Needs live gas/pool modelling; fixed slippage is used. |
| Auto Sell / Sell Limit presets | Not implemented | Overlaps the exit engine; presets not mapped. |
| Degen Mode | Not implemented | Disables protections; deliberately not offered. |

**Deviation:** `duplicateBuy` and `priceImpactAlertBps` are opt-in (unset = legacy behaviour) so existing callers are unchanged. `MAESTRO_COPY_DEFAULTS` (`duplicateBuy:false`, 2000 bps) applies Maestro's defaults when spread into a config.

## Funds management
| Feature | Status | Notes |
|---|---|---|
| /disperse | Implemented-local (`planDisperse` + `distribute`) | Splits a chosen % equally after a gas reserve; remainder stays in source. |
| /collect | Implemented-local (`collect`) | Native keeps a per-wallet gas reserve; tokens sweep whole raw balance; per-item `done` flags make it resumable; stops at first failed send. |

Collect safety decisions: the receiver must be one of the user's wallets unless `allowExternalReceiver` is set; a per-item `cap` callback limits a send to the wallet's policy cap — a capped item sends exactly the cap, is flagged `capped`, and is **not** looped (sweep again to continue).

Not covered: bridge providers (Relay/deBridge/Houdini), cashback tiers, Wallet/Whale/Buy bot (Maestro's own docs for those are placeholders).
