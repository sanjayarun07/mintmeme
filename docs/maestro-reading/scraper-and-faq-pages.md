<!-- Paraphrased from docs.maestrobots.com on 2026-11-15 by a reading agent; spot-checked by hand for the conflicts listed in docs/MAESTRO_DOCS_READ_2026-11-15.md. Not Maestro's text. -->
# Maestro docs facts, batch C (scraper pages plus selected sniper pages)

Source: local copies of docs.maestrobots.com pages. All items paraphrased; numbers and names copied from the pages. "not stated" = absent from the page.

## scraper__index.md
- Maestro Scraper is a cross-platform desktop app that scrapes the user's Telegram channels and groups in real time, detects crypto contract addresses and forwards them to Maestro trading bots.
- Scans every incoming message for ETH, SOL, TON and TRON addresses.
- Forwards detected addresses to the Maestro bot automatically; skips duplicates; logs all activity.
- Scrapes new messages, edits and pinned posts as they happen.
- Per-channel filtering choices: admin posts, user messages, bot messages, pinned messages.
- Duplicate detection: skips addresses already seen in the same chat.
- Forward targets: @maestro or @maestropro.
- Telegram session is encrypted using the OS keychain.
- Scraping statistics and activity logs survive app restarts.

## scraper__system-requirements.md
- OS: Windows (x64), macOS (x64 and Apple Silicon), Linux (x64, arm64).
- Needs an active Telegram account.
- Needs an API ID and API Hash from my.telegram.org/apps.
- RAM, disk, network requirements: not stated.

## scraper__installation.md
- Latest release named: v1.4.0 (GitHub MaestroBots/MaestroScraper).
- Files: maestro-scraper-1.4.0-x64.exe (Windows); -x64.dmg (macOS Intel); -arm64.dmg (macOS Apple Silicon); -amd64.deb (Linux x64); -arm64.deb (Linux arm64).
- macOS: app is not signed with an Apple Developer certificate; a blocked warning appears. Open the .dmg, drag to Applications, click Open Anyway (or System Settings, Privacy & Security, Open Anyway). Needed once.
- Windows: SmartScreen warning; click More info, then Run anyway, then follow installer prompts.
- Linux command: `sudo dpkg -i maestro-scraper-*.deb`.
- Auto-update: not stated.

## scraper__telegram-credentials.md
- App asks for an API ID and API Hash at first launch.
- Use only my.telegram.org; never share login code, API ID or API Hash.
- If using Chrome, disable AdBlocker and VPN extensions first.
- Log in at my.telegram.org with the phone number of the Telegram account connected to the Maestro Sniper Bot; scraping will not work with any other account.
- Access code arrives in the Telegram app from the official Telegram account.
- Choose API development tools and fill form: App title "Maestro Scraper", Short name "Scraper", URL https://my.telegram.org/, Platform Desktop.
- Click Create application to see API ID and API Hash; enter them in the app.
- Next step is the Logging In page.

## scraper__logging-in.md
- Login has up to 4 steps.
- Step 1: enter API ID (a number) and API Hash (32-character string). Telegram Server Region defaults to Auto; options are Auto, MIA1, AMS1, MIA2, AMS2, SIN. Check "Remember credentials" to save API credentials. Click Continue.
- Region only shows when no saved session exists (first sign-in or after clearing login); does not move the account. Hovering the Connected footer shows datacenter and ping (example AMS2: 123 ms); clicking copies it.
- Unchecking "Remember credentials" later clears all saved credentials and the Telegram session; re-login required.
- No secure keychain (some minimal Linux, or macOS with Keychain denied): prompt "Secure keychain is not available" with Accept & enable (machine-tied fallback) or No thanks.
- Step 2: phone number with country code (example +1 234 567 8900), click Send Code. Telegram chooses delivery; usually to another signed-in Telegram app rather than SMS.
- Step 3: code is 5-6 digits (rarely a word or short phrase by SMS, typed as received). Click Verify. Resend button names the next method (for example Resend via SMS), only appears when another method exists, may show a countdown.
- If screen says no code will arrive here: sign in once on the official Telegram app (and set up login email if asked), then retry.
- Step 4 (only if 2FA is on): enter cloud password, click Sign In.
- After login the user lands on the Channels page. Session is saved; no re-login unless logout or "Remember credentials" unchecked.

## scraper__supported-blockchains.md
- EVM: starts with 0x plus 40 hex characters.
- Solana: Base58, 32-44 characters.
- TON: starts with EQ or UQ followed by 46 characters.
- TRON: starts with T followed by 33 characters.
- Scans message text, embedded links, and links and labels on inline buttons (including Buy or Chart buttons and button text).
- Recognises Uniswap v4 pool links (64-character 0x pool IDs) from any site and forwards them like other addresses.

## scraper__channels-page.md
- After login, Telegram dialogs load automatically; scraping starts as soon as scraping is enabled on a channel (no need to open Activity page).
- Table columns: Name, Username, Type (channel, group, user, bot, self), ID, Settings dropdown.
- Chat list limit: 5,000 most recently active chats; amber banner when older chats are omitted; open the chat in Telegram then click Refresh to bring it back.
- Group toggles: Admins > Humans, Admins > Bots, Users > Humans, Users > Bots, Pinned, Self.
- Channel toggles: only Admins and Pinned.
- User chat, Bot chat, Saved Messages: a single Track toggle.
- A chat counts as scraped when at least one toggle is on. Dropdown summary prefixed "Tracking:" (Tracking: None, Tracking: All, or list, rolled up to Admins/Users when both sub-options are on).
- Settings dropdown has two tabs: Tracking and Auto Buy.
- Auto Buy tab: separate amount per chain, in native unit, with minimums: SOL 0.001; BSC (BNB) 0.001; BASE (ETH) 0.001; ETH 0.001; ROBINHOOD (ETH) 0.001; MONAD (MON) 0.1; SONIC (S) 0.01; AVAX 0.001; ARB (ETH) 0.001; HYPE 0.001; TRX 1; TON 0.05.
- Typing an amount turns auto-buy on for that chain; blank turns it off; each chain is independent.
- Forwarded address carries the amounts; the bot works out the chain and buys with that chain's amount; blank chain keeps prior bot behavior.
- Toolbar: Search (name, username, ID), Scraped Only, Clear All, Refresh.
- Sort by Name, Username, Type, ID (click again to reverse); scraped channels always on top; rows per page 10, 20, 50 or 100.

## scraper__activity-page.md
- Scraping is on by default, starts automatically when logged in with scraped channels, independent of current page.
- Start Scraping / Stop Scraping button; stopping needs confirmation. Status: green pulsing = active, gray = idle.
- Four stat cards: Messages Scanned, Addresses Found (unique), Duplicates Skipped, Forwarded to Bot. Stats persist across restarts.
- Log colors: Green Address Found; Yellow Duplicate; Blue Forwarded (lists per-chain auto-buy amounts if set); Orange Unverified; Red Error; Gray Message.
- Unverified: sender bot/human or admin/member status cannot be determined and the Tracking toggles would treat the cases differently; address is logged but NOT forwarded. If both relevant toggles are equal (both on or both off) forwarding proceeds. Channels and DMs never affected.
- Log entry fields: Timestamp, Source (clickable, opens Telegram), Message, Address (click to copy).
- Log features: Search, per-entry Copy, Copy Address, Clear Log (also resets statistics), infinite scroll 50 entries at a time.
- Pipeline: chat in scraped list, message type matches filters, text and embedded links scanned, duplicates skipped if enabled, new addresses forwarded with encrypted metadata, events logged.
- Edits made more than 30 seconds after the original post are ignored.

## scraper__settings.md
- Two sections: General and Data Management.
- Ignore Duplicates: default Enabled; per channel, so same address from other channels is still forwarded.
- Use Maestro Pro toggle: Maestro (@maestro, default) or Maestro Pro (@maestropro, "premium"); active bot shown with green "Active" badge.
- Log Retention Period options: 7, 14, 21 or 30 days; expired entries removed at app start. Default period: not stated.
- Activity log capped at 10,000 entries regardless of retention; oldest dropped when full.
- Clear Activity Logs: permanent, needs confirmation.
- Clear Address History: permanent, confirmation; previously seen addresses may be forwarded again and duplicate counter resets.
- Address history cap: 10,000 entries; at the limit the oldest 20% are removed; usage shown (example "3,500 / 10,000 addresses"); warning above 50%.

## scraper__security-privacy.md
- App runs locally; Telegram session encrypted with OS keychain: macOS Keychain, Windows DPAPI, Linux libsecret or kwallet.
- Channel preferences, address history and activity logs are stored locally unencrypted.
- No keychain: "Accept & enable" stores credentials and session with machine-tied fallback encryption (weaker; anyone with admin or root on the device could decrypt); "No thanks" leaves saving off and credentials must be re-entered each restart. Prompt appears on every launch without a keychain.
- When a keychain returns, a green notice appears next to "Remember credentials"; log out and in with it enabled to migrate to keychain.
- Stored: Telegram session, API credentials (only if Remember credentials), channel preferences, address history, activity logs, app settings.
- Not stored: Telegram password; message content (memory only).
- External sends only to the Maestro bot, Telegram API and Sentry (error tracking).
- Message sent to bot contains the detected address(es) and a link to the source message if available.

## scraper__troubleshooting.md
- "Not connected to Telegram": check internet, re-login, verify credentials, try another Telegram Server Region.
- Footer connection states: Connected, Connecting..., Error, Disconnected; silent drops are detected and auto-recovered without restart.
- Connect handshake no longer hangs forever; shows an error instead.
- No channels: click Refresh, confirm connection; older channels beyond 5,000 most recent are omitted.
- Addresses not detected: check Tracking is not None, correct toggle (Admins > Humans vs Admins > Bots), format must match supported patterns, check log.
- Addresses not forwarded: Maestro bot must be accessible; start a conversation with the bot first; check Error entries; Unverified (orange) means held back, so set Humans and Bots toggles the same way.
- Duplicates skipped is expected; reset via Clear Address History.
- Slow app: clear logs or history, lower retention.
- Login errors table: "API ID must be a valid number"; "API Hash must be 32 characters"; "Invalid phone number format" (include country code); "Invalid verification code"; "Verification code expired" (Resend code); no code arrives; extra verification step message; "You are signed in, but your account details could not be loaded" (restart app); "Incorrect password" (2FA cloud password); "Too many attempts" (wait a few minutes); "This phone number is banned" (contact Telegram support).
- macOS "Keychain access is unavailable": allow in System Settings > Privacy & Security, restart; without it login is needed on every restart.

## scraper__faq.md
- App must stay running; closing stops scraping; stats and logs preserved; scraping auto-resumes with scraped channels.
- Unlimited number of channels and groups simultaneously.
- Uses the official Telegram API; ban risk: account "should be safe" with normal use, avoid excessive operations in short periods.
- New channel: click Refresh on Channels page.
- Only one Telegram account at a time; log out to switch.
- Maestro vs Maestro Pro: Pro "offers premium features"; switch in Settings; forwarding works the same for both.
- Duplicate detection stores a record of address + chatId; same address in other chats treated separately.
- Only chats explicitly chosen are processed; private user/bot chats and Saved Messages each have a Track toggle.
- All data local; no external servers besides Telegram API and the Maestro bot.
- Keychain-less fallback described (Accept & enable / No thanks).

## sniper__campaigns.md
- Campaigns are limited-time promotions granting a bonus perk, such as a boosted Cashback tier, a free Premium period, or another one-off reward.
- Surfaced as a message in a Maestro-related Telegram channel or group, or as a bot DM if individually eligible; message includes a Claim button.
- Tapping Claim: bot confirms eligibility immediately and applies the reward (for example upgrades Cashback tier for the campaign duration, or extends Premium).
- Each campaign message can be claimed once per eligible user; a second tap replies that it was already claimed.
- Ineligible reply: "You are not eligible for this campaign". Example criteria: insufficient recent trading volume, not on the selected recipient list. Actual thresholds: not stated.
- Related: Cashback (continuous rebate on trading fees) and Rewards (one-off or time-limited pools).

## sniper__competition.md
- Command `/competition` in the DM with the bot posts the current competition announcement (rules, prize pool, entry terms).
- With none running, bot replies that there is no active competition at the moment.
- Rules, prize amounts, scoring: not stated.

## sniper__faq__fees.md
- 1% charge on every successful buy and sell, manual or automatic. Simple transfers are not taxed.
- Solana: fee extracted in the same transaction.
- Other chains: fee is accumulated, not taken per transaction; extracted only once unpaid fees exceed a chain-specific minimum. Higher minimums on chains with low unit price: 0.5 TON on TON, 1 MON on Monad, 10 TRX on Tron. Minimums for other chains: not stated.
- Extracted fees never below that minimum.
- Fees accumulate per Telegram account, not per wallet; extracted from the wallet with the highest balance on that chain.
- Unpaid fees up to June 12th, 2023 were forgiven.
- Premium fee discount: not stated.

## sniper__faq__security.md
- No need to connect an external wallet; wallets can be generated in the bot.
- Private keys are AES encrypted.
- User should enable Telegram two-factor authentication.
- Private key and mnemonic shown on wallet creation; recommended to record by pen and paper, then delete the DM message; never copy to clipboard.
- Lost key/mnemonic with deleted message: no way to retrieve. While the wallet is still connected, assets can still be transferred out via the bot; do not disconnect first.
- Unexpected native-coin transfers to Fee Addresses are the 1% fee; minimum is chain-specific (see Fees page).

## sniper__faq__call-channels.md
- Auto Buy must be enabled in both Wallet Buy Settings and Channel Settings (with a Buy Amount set).
- Auto Sell must be enabled in both Wallet Sell Settings and Channel Settings; this sets the default for the Trade Monitor spawned after an auto-buy.
- Calls are missed if: Track is not enabled (needed even if Auto Buy is on); the call has no contract address (raw, manipulated or chart link all detected); or the contract was edited in late (not reported, to protect from late buys). "Late" threshold: not stated.
- Same token is never reported twice from a single channel; may be auto-bought again if multiple followed channels call it; disable Dupe Buy to avoid.
- Find channels: `/start` > Signals > Call Channels > chain; ordered by number of Maestro users tracking; Search by username or ID.
- New channels limited to top-tier channels; report to 24/7 support; other channels via the Maestro Telegram Scraper.
- No stated limit on followed channels; too many simultaneous calls may cause Telegram rate-limiting, normally lifted in a few hours.
- Notify-only: Track without enabling Auto Buy.

## sniper__faq__auto-buy-warnings.md
- Wallet auto buy is disabled: enable in Wallet Buy Settings (`/start` > Wallets > chain > Config > Buy); needed for call-channel and copytrade auto-buys; no effect on Auto Snipe.
- Channel auto buy is disabled: enable in Call Channel Settings (or `Me` channel settings for pasted contracts).
- Buy/Sell tax could not be estimated: token without trading enabled or liquidity; blocks auto-buy.
- Blacklist risk: bot blocks auto-buy if buying would get you blacklisted.
- Honeypot detected: blocks auto-buy.
- Liquidity / Total Supply < 1%: pool holds under 1% of supply (unsupported pool or unhealthy liquidity); blocks auto-buy.
- Degen Mode: still notifies of these risks but no longer blocks auto-buy.

## sniper__faq__trade-monitor.md
- Active trades get live P/L tracking, Auto Sell and Buy Dip; disabled trades do not.
- Trades become disabled after 36 hours (96 hours for Premium).
- Recovery option 1: Add to Monitor button on the buy message (keeps initials). Option 2: paste CA and press Track (Initial and Worth reset to current worth).
- Press Refresh before expiry; Refresh also activates a disabled trade.
- Disabling or deleting a trade does not sell; Auto Sell and Buy Dip just stop applying.
- Reset: Initial becomes current Worth (same as Track), can merge repeated buys, and restarts the timer for another 36 hours (96 Premium).
- `/monitor` in the DM shows trade monitors.
- Track works for tokens bought outside the bot.
- Capacity: 10 active trades (30 for Premium); the bot auto-replaces disabled trades when at the limit; Delete frees space.
- `/cleartrades` removes every active and disabled monitor; positions and limit orders unaffected.
- Merging two buys works only if both came from the same wallet (Delete one, Reset the other).
- Monitor's Auto Sell and Trailing Sell defaults come from the linked channel (call channel, `Me` channel, copytrade wallet or snipe) AND must be enabled in Wallet Sell Settings; can be toggled manually; green checkmark indicates active.

## sniper__faq__copytrade.md
- Copytrade auto buys/sells a token when the tracked wallet buys/sells it.
- Tracked wallets: up to 5 per chain (base), up to 12 per chain (Premium).
- Auto Buy requires enabling Auto Buy and a Buy Amount in Copytrade Wallet Settings; Buy Amount is the maximum. Example: Buy Amount 0.5 BNB, tracked wallet buys 0.1 BNB, bot buys 0.1 BNB; tracked buys over 0.5 BNB, bot buys 0.5 BNB.
- Copy Sell: bot notifies on tracked wallet sells, checks you hold the token, and if Copy Sell is enabled sells the same percentage (example 50%); needs no active Trade Monitor and is separate from Auto Sell.
- Frontrunning possible on chains where applicable.
- Works with multi-wallets.
- Notify-only: add the wallet, turn on Copytrade for the chain, disable Auto Buy.
- Pump.Fun transactions on Solana can be copytraded.
- A wallet that snipes a launch can be copytraded (details on a different page).

## sniper__monetization.md
- 1% fee on every successful buy and sell via the bot, manual or automatic; simple transfers not taxed.
- Solana: fee taken in the same transaction.
- Other chains: fee accrues and is extracted once unpaid fees exceed a chain-specific minimum; 0.5 TON, 1 MON, 10 TRX stated for TON, Monad, Tron; extracted amounts never below the minimum.
- Accumulates per Telegram account, not per wallet; taken from the highest-balance wallet on that chain.
- Unpaid fees up to June 12th, 2023 forgiven.
- Fee addresses identical to the Fees FAQ page (Solana, one shared EVM address, Tron, TON).

## sniper__referral-program.md
- Up to 25% commission on fees of users who trade via your link; contact @MaestroMarketer for a custom deal if bringing many users with good volume.
- Sticky Referral: 25% lifetime commission on fees of users who start the bot for the first time using the link (first-time users only).
- Quick-Buy Referral: token-specific link that opens the token report. If the referred user is new, it acts as Sticky (25% on all trades). If an existing referred user, the 25% is split in half with the original referrer.
- `/referral` opens the Referral Menu; click the icon with your username for Referral Configuration Menu showing your Sticky link.
- Quick-Buy link: "Generate Referral Link" and enter the token CA, or paste the CA in the DM and the link appears at the end of the token report.
- Menu fields: Referred Users (first-time starters only), Active Referred Users (active in past two weeks; not necessarily traded), Referral Percentage (default 25%, may be raised in promotions), per-chain Total Referred Txs, Total Volume, Total Earned (paid plus unpaid), Unpaid Earnings.
- Withdrawal: connect a Fee Wallet per chain via Fee Wallets, then Send Unpaid Earnings and pick the chain.
- Earnings are NOT sent automatically; manual withdrawal required.
- Maestro covers transaction fees only when amount and block gas fees are within limits shown in the menu; otherwise the user pays. Limits and minimum payout: not stated.

## sniper__index.md
- Manual with 19 sections: Getting Started, Wallet Setup, Global Settings, Pasted Contracts, Trade Monitor, Positions, Limit Orders, Signals, Copytrade, Auto Snipe, Funds Management, Bridge, Referral Program, Cashback, Rewards, Campaigns, Competition, Monetization, Premium Subscription.
- Getting Started lists chains, DEXs and launchpads.
- Wallet Setup: import wallet or generate in the bot.
- Trade Monitor: real-time portfolio status, automated sell and buy limit orders, manual buy/sell from multiple wallets at once.
- Signals: auto-buy tokens called by chosen signals.
- Copytrade: copy buys and sells of tracked wallets; frontrun where applicable.
- Auto Snipe: auto-snipe token launches.
- Funds Management: disperse from one wallet to many or collect from many into one.
- Bridge: swap, send or bridge on same or different chains via the fast deBridge-powered route or the privacy-focused Houdini-powered route (the index names these two, not Relay).
- Referral Program: up to 25% commission. Cashback: continuous rebate of part of fees paid. Rewards: one-off or time-limited pools. Campaigns: limited-time perks. Competition: current trading competition. Monetization: fee collection. Premium: extra features for hardcore users and day-traders.

---

## Gaps vs our docs

Line numbers refer to /Users/arunmozhi/Meme/docs/FEATURE_PARITY.md (FP), CAPABILITY_MATRIX.md (CM), MAESTRO_COPY_AND_FUNDS.md (MC). "Not mentioned" = no row in those three docs.

### Contradictions (our statement vs these pages)
- FP line 51 (scraper): "cross-channel dedup (shared `SignalFilter`)". Pages (scraper__settings, scraper__faq, scraper__activity-page, scraper__troubleshooting): dedup is per chat (address + chatId); same address from another channel is still forwarded.
- FP line 51: "Dedup state is in memory". Pages: duplicate history is persisted, capped at 10,000 entries (oldest 20% dropped), with Clear Address History.
- FP line 51: session store "AES-256-GCM, scrypt-derived key... passphrase min 8 chars". Pages: Maestro encrypts with OS keychain (Keychain, DPAPI, libsecret/kwallet) with a machine-tied fallback; no passphrase is described. Different design, not a parity item.
- FP line 51: per-channel filters are "allow/deny keywords, min/max age, sender allowlist". Pages: filters are sender categories only (Admins/Users x Humans/Bots, Pinned, Self, Track for DMs); no keyword or allowlist filters are stated. Age handling differs: pages only ignore edits more than 30 s after the original post.
- FP line 51: scraper outputs "preview" candidates, `auto` only via callback with an `Intent`. Pages: the scraper forwards addresses to @maestro or @maestropro (with per-chain auto-buy amounts), and the bot decides and buys; there is no preview mode stated.
- FP line 18 and CM line 93 (12 vs 13 chains, "UNRESOLVED"): scraper__channels-page (auto-buy table) and sniper__faq__fees (fee addresses) list exactly 12 chains: SOL, BSC, BASE, ETH, ROBINHOOD, MONAD, SONIC, AVAX, ARB, HYPE, TRX, TON. Hyper EVM present; Elysium and Arc absent from both pages. This supports the 12-chain docs list.
- FP line 39 / line 12: fee model "per-chain, per-tier bps" and "sweep once per id above a per-chain minimum". Pages state a single flat 1% (no tier variation stated) and accrual per Telegram account, taken from the highest-balance wallet. Whether our sweep key matches "per Telegram account" is unclear from the docs. Documented minimums (0.5 TON, 1 MON, 10 TRX) are not mentioned anywhere in our docs.
- FP line 59 (campaigns): "adds the single largest active boost inside a time window (optionally token-scoped), not stacked". Pages: a campaign is a Telegram message with a Claim button, claimed once per user, gated by eligibility (recent volume or recipient list), and can also grant free Premium; not automatic by time window and no token scope is stated. FP line 59 already labels it "our own model".
- FP line 60 (competition): our model has volume window, min trade size, per-token caps and prize payout. Pages state only that `/competition` posts the announcement or replies that none is active; no rules are stated. Our rules are not parity items.
- FP line 56 (referrals): "claim-once". Pages: unpaid earnings are withdrawn repeatedly, manually, per chain via Send Unpaid Earnings to a Fee Wallet; Maestro covers network fees only within limits. If "claim-once" means once per accrual that is fine; if once total it contradicts.
- MC line 15 (Copy Sell): ours sells the same percentage of attributed inventory, not the whole wallet holding, flagged by us as differing. Page confirms Maestro sells the same percentage from the user's wallet; the deviation is acknowledged.
- FP line 8 and line 74 say scraper pages "none is linked from the index" and "NOT read". They exist (this batch: 12 pages) and sniper__index does not link them, but call-channels FAQ links to /scraper.

### Per page: documented features not mentioned as implemented
- scraper__index: Maestro Pro as forward target; persistent stats; inline-button scanning (FP line 51 and 46 mention regex extraction only); desktop app (FP line 51 states "No UI").
- scraper__system-requirements: nothing implemented-side applicable (OS list, API ID/Hash). FP line 51 mentions API id/hash only as external.
- scraper__installation: installers for 5 targets (v1.4.0); not mentioned.
- scraper__telegram-credentials: credential-gathering flow; not mentioned beyond FP line 51.
- scraper__logging-in: 4-step login (API creds, phone, code, 2FA), Remember credentials, Telegram Server Region (Auto, MIA1, AMS1, MIA2, AMS2, SIN), resend methods, keychain-unavailable prompt; none mentioned (FP line 51 "BLOCKED", no MTProto client).
- scraper__supported-blockchains: Uniswap v4 64-character pool IDs and button/link scanning are not mentioned; FP line 46 lists only EVM/TON/Tron/Solana regex. Address-length rules not mentioned.
- scraper__channels-page: Channels table, Type column, 5,000-chat limit, Tracking/Auto Buy tabs, per-chain auto-buy amounts and minimums (SOL 0.001 ... TRX 1, TON 0.05, MONAD 0.1, SONIC 0.01), Scraped Only, Clear All, Refresh, sort/pagination (10/20/50/100). FP line 51 mentions "per-chain trade presets" only; none of the Maestro toggles (Admins/Users x Humans/Bots, Pinned, Self) are mentioned.
- scraper__activity-page: start/stop with confirmation, four stat cards, six color-coded log types, Unverified handling for unknown sender type, activity log search/copy/clear, 50-entry paging, 30-second edit cutoff. FP line 51 mentions only "redacted secret-free log".
- scraper__settings: Ignore Duplicates toggle (default on), Use Maestro Pro, log retention (7/14/21/30 days), 10,000 log cap, Clear Activity Logs, Clear Address History, 10,000 address cap with 20% eviction. Not mentioned.
- scraper__security-privacy: OS keychain tiers, Sentry as an external recipient, stored/not-stored lists, message payload sent to bot (address plus source-message link). Not mentioned.
- scraper__troubleshooting: connection-state footer and auto-recovery, login error catalogue, macOS Keychain denial. Not mentioned.
- scraper__faq: single account at a time, must-stay-running, resume on reopen. Not mentioned.
- sniper__campaigns: Claim button flow, one claim per user per campaign, eligibility reply, free Premium reward type. Not mentioned (FP line 59 only has window-based cashback boost).
- sniper__competition: `/competition` command and "no active competition" reply. Not mentioned (FP line 60 lists only our own competition model; `/competition` absent).
- sniper__faq__fees: fee addresses (Solana, shared EVM, Tron, TON), chain minimums (0.5 TON, 1 MON, 10 TRX), highest-balance-wallet extraction, June 12 2023 forgiveness, "transfers are not taxed". FP line 27 and 39 cover only the general 1% and accrual idea.
- sniper__faq__security: no external wallet required, AES-encrypted keys, 2FA advice, key-recovery rules, transfer-out-while-connected rule. FP line 64 says "Withdrawals / security: Not read" and the signer is a stand-in.
- sniper__faq__call-channels: Track vs Auto Buy channel settings, wallet-level and channel-level Auto Buy and Auto Sell, per-channel never-report-twice rule, late-edit exclusion, call-channel directory sorted by tracker count and Search, Dupe Buy. FP line 46 and 85 mention signals extraction and Duplicate Buy only; channel directory and late-edit rule not mentioned (FP line 46 does mention "age check").
- sniper__faq__auto-buy-warnings: six warnings (wallet auto buy off, channel auto buy off, tax not estimable, blacklist risk, honeypot, Liquidity / Total Supply < 1%) and the 1% liquidity rule. FP line 61 mentions honeypot block; the 1% liquidity ratio and blacklist-risk block are not mentioned. MC line 21 says Degen Mode is not offered; page describes it as warn-without-block.
- sniper__faq__trade-monitor: 36 h / 96 h expiry (FP line 84 mentions), Reset, Refresh, Add to Monitor, `/monitor`, `/cleartrades`, Track for outside buys, auto-replacement of disabled trades, same-wallet merge rule, channel-linked Auto Sell/Trailing Sell defaults. FP line 84 says views and limits not matched; commands not mentioned.
- sniper__faq__copytrade: Buy Amount as max cap (MC line 9 `maxBuy` matches), Copy Sell independence from Trade Monitor, Pump.Fun copytrade on Solana (CM line 75 says "no Pump.fun" for our Solana copy), copy of launch-sniping wallets, multi-wallet support (not mentioned; FP line 47 says no wallet management), notify-only setup (MC line 11 `trackOnly` roughly covers).
- sniper__monetization: same as fees; fee-address table and per-chain minimums not mentioned.
- sniper__referral-program: `/referral` menu, Fee Wallets per chain, Send Unpaid Earnings, Referred/Active Referred Users counters, per-chain stats, custom deals via @MaestroMarketer, Maestro-paid network fee conditions, Referral Percentage default 25% with promotions. FP line 56 covers split and sticky logic; menu, Fee Wallet and stats are not mentioned.
- sniper__index: sections Cashback, Rewards, Campaigns, Competition, Premium, Bridge (deBridge and Houdini named here; FP line 82 notes the bridge page also lists Relay). Index names Houdini route as privacy-focused; ours is adapter-stubbed (FP line 50).
