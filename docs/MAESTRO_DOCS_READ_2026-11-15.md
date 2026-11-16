# Maestro docs: pages read on 2026-11-15

All 68 pages listed in `https://docs.maestrobots.com/llms.txt` were downloaded (public pages, read-only). 65 were read in full by reading agents; the other 3 (wallet, whale, buy) are one-line placeholders that say "on the way". The 19-section manual, the 12 scraper pages and the FAQ are all covered. Earlier parity notes said many of these were unread.

The detailed, paraphrased per-page facts are in `docs/maestro-reading/`:

- `trading-pages.md`: limit orders, sell and approve settings, signals, pasted contracts and token report, premium, positions, trade monitor menu.
- `snipe-and-setup-pages.md`: auto snipe (index, config, activation, per chain), getting started, wallet setup, FAQ on chains, wallet settings, multi-wallet, manual transactions, error messages.
- `scraper-and-faq-pages.md`: the 12 scraper pages, campaigns, competition, fees, security, call channels, auto-buy warnings, trade monitor FAQ, copytrade FAQ, monetization, referral, index.

Method and limits: the pages were read by three reading agents, one group each. They were told to paraphrase and write "not stated" where a page gives no value. I spot-checked the claims below against the raw page text. I did not re-read every bullet. Treat the per-page files as a working summary, and check the page itself before relying on a number.

## What the pages settle

- **Chain count: 12.** Getting Started, the supported-chains FAQ, the scraper's channel page (auto-buy amounts) and the fees FAQ all list the same 12: Solana, BSC, Base, Ethereum, Monad, Sonic, Avalanche, Arbitrum, Hyper EVM, Robinhood, Tron, TON. Elysium and Arc appear nowhere in the docs. The homepage's 13-chain claim stays unexplained, but the documentation is consistent on 12.
- **Bridge:** Getting Started says the bridge is powered by Relay. The docs index names deBridge and Houdini. The bridge page itself lists all three routes (read on 2026-11-14). No page gives a bridge chain list or minimums.
- **Scraper:** it is a desktop app that forwards detected addresses to the Maestro bot (`@maestro` or `@maestropro`), which decides and buys. Auto-buy amounts are set per chain in the scraper (minimums such as 0.001 for most native coins, 0.1 MON, 0.01 S, 1 TRX, 0.05 TON).
- **Fees:** one flat 1% on every successful buy and sell. On Solana it is taken in the same transaction. On other chains it accrues per Telegram account and is taken from the highest-balance wallet once it passes a chain minimum. Three minimums are stated (0.5 TON, 1 MON, 10 TRX); the others are not.

## Where Maestro's own pages disagree

| Topic | Page A | Page B | What we do |
|---|---|---|---|
| Wallets per chain | `wallet-setup`: 8 (10 premium) | `faq/multi-wallet`: 4 (6 premium) | Keep 8/10 as "documented on one page" and record the conflict. Our limits are placeholders either way. |
| Price Impact Alert default | `buy-settings`: 20% buys. `sell-settings`: 20% sells | `faq/transaction-error-messages`: 25% buys, and a different default for sells | Not matched. Do not state a single Maestro default. |
| Auto Snipe on Arbitrum | `auto-snipe` index: Ethereum, BSC, Base, Solana only | `faq/manual-transactions` mentions Arbitrum Auto Snipe in one sentence | Treat the index as authoritative; the FAQ line is likely stale. |

## Where our own docs were wrong or out of date

- `FEATURE_PARITY.md` said Auto Snipe config, signals settings, limit orders, sell settings, scraper pages and Getting Started were not read. They are read now.
- The scraper row (row 10) describes cross-channel de-duplication held in memory. Maestro's scraper de-duplicates per chat (address plus chat id), keeps the history on disk, and caps it at 10,000 entries. Our design differs on purpose; it is not a parity match.
- Row 10 also lists keyword, age and allowlist filters and a preview/auto split. Maestro documents sender-category toggles (admins and users, humans and bots, pinned, self) and forwarding to its bot. Our filters are our own design.
- `FEATURE_PARITY.md` line 80 says there is no Solana sniping, while `CAPABILITY_MATRIX.md` reports a Solana snipe tested on a local validator. The matrix is the newer and tested statement. Both docs now say so.
- Our Auto Snipe covers none of Maestro's Ethereum Block-0 bundle and tip, backup transaction, Block-0-only mode, skip-high-tax mode, min-token mode or pre-approve. That was true before and is now sourced.

## Largest documented gaps (by area)

These are features the pages describe that our docs do not list as implemented. They are candidates for later work, not a promise.

- **Telegram surface:** Token Report buttons, positions screen and commands, trade monitor menu, `/orders`, `/monitor`, `/summary`, `/autosnipe`, `/quick`, `/import`, `/wallets`, captcha onboarding, chain enable/disable. The Telegram app is a command-handler stub.
- **Order settings:** entry-price triggers recomputed after each buy, percent-relative triggers, multi-wallet limit orders, duration up to 168 hours, per-order edit and delete, Active Orders panel.
- **Per-signal settings:** buy amount, auto-buy checks with global inheritance, Track Only versus Active, Degen Mode, per-signal sell presets, Reset to Global.
- **Protections:** Degen Mode (warn without blocking), liquidity-to-supply under 1% block, blacklist-risk block, siphon-token confirmation, auto-adjust of the buy to the contract's max buy.
- **Slippage and gas:** Smart Slippage, the above-100% exact-out mechanism, Max Gas Limit, Gas Price versus Gas Delta by chain, Solana base fee plus tip, TON reserve.
- **Wallets:** naming, rearranging, a Manual flag, a Default wallet, send with percent amounts, cross-chain import, delete.
- **Venues:** our matrix covers a subset of the DEX and launchpad lists per chain. Sonic, Monad, Hyper EVM and Robinhood have no rows.
- **Commerce:** campaign Claim flow (once per user), `/competition`, referral menu with Fee Wallets and manual withdrawal, per-chain fee minimums, premium extras (Pro bot, Launch Simulator gating, trending list, Hits).
- **Scraper:** the Maestro-style channel toggles, per-chain auto-buy amounts, 5,000-chat limit, Unverified handling, 30-second edit cutoff, log retention, keychain storage. Live Telegram remains blocked on the separate scraper session.

## What did not change

Nothing here was verified against a live Maestro bot. These are statements of Maestro's public documentation as of the read date; the docs can change, and some pages contradict each other. No code was changed by this reading.
