<!-- Paraphrased from docs.maestrobots.com on 2026-11-15 by a reading agent; spot-checked by hand for the conflicts listed in docs/MAESTRO_DOCS_READ_2026-11-15.md. Not Maestro's text. -->
# Maestro docs facts, batch A (16 pages)

Source: local copies of docs.maestrobots.com pages. Paraphrased; "not stated" means the page gives no value.

## sniper__limit-orders__index.md
- Section lets you manually add buy and sell limit orders for any token; Maestro trades when target price or market cap is hit.
- Contrasts with preset sell limits that auto-apply after every manual or automated buy (covered elsewhere).
- Three sub-pages: Sell Limits, Buy Limits, Active Orders.
- No numbers, defaults or chain restrictions stated.

## sniper__limit-orders__sell-limits.md
- Path: paste CA -> Token Report -> "Go to Sell" -> "Sell Limit". Also reachable from the token's Trade Monitor.
- Multi Sell: dropdown of connected wallets with a positive token balance; all enabled by default; lets one order be added to several wallets at once.
- Limit Type: Take Profit, Stop Loss, Trailing Stop Loss (three types).
- Trailing Stop Loss moves its trigger as price rises and never lowers the trigger price or market cap.
- Trigger types: Price, Market Cap (MC), Entry Price (three).
- Price/MC trigger accepts an exact USD value or a percentage change relative to the current price/MC.
- Entry Price trigger accepts only a percentage change against your average entry price.
- Entry-price-based limits are updated dynamically after every buy (new average entry recomputed).
- Percentage sign rule: Take Profit must be positive; Stop Loss and Trailing Stop Loss must be negative (applies to all three trigger types).
- Balance: percent of token balance to sell at trigger; always acts on total balance at trigger time (example: 50% sells half). Default: not stated.
- Duration: hours the order stays active; maximum 168 hours (7 days). Default: not stated.
- "Add Sell Limit Order" button adds the order to the selected wallets; added orders are listed in the panel message.
- Each order gets a numbered "Config [X]" button to edit Trigger, Balance, Duration; shows the limit and its wallet; "Delete" removes it.
- Chain restrictions: not stated.

## sniper__limit-orders__buy-limits.md
- Path: paste CA -> Token Report -> "Buy Limit". Also reachable from the token's Trade Monitor.
- Multi Buy: dropdown of all connected wallets on the chain; same order can be added to several wallets.
- Trigger types: Price, Market Cap (two). Exact USD value or percentage change from current price/MC.
- Upper and lower buy limits both allowed (trigger may be above or below current value).
- Amount: buy size in the chain's native coin.
- Duration: hours active; maximum 168 hours (7 days). Default: not stated.
- "Add Buy Limit Order" adds to selected wallets; orders shown in panel message.
- Per-order "Config [X]" button edits Trigger, Amount, Duration; "Delete" removes the order.
- Chain restrictions: not stated.

## sniper__limit-orders__active-orders.md
- Entry: /start menu "Active Orders" button or the command /orders in DMs.
- First panel lists chains that have at least one active buy or sell limit order; you pick a chain.
- Chain panel shows a summary of active sell limit orders by token and wallet, with order types counted (example: Stop Loss counts per wallet).
- A "Buy Limits" selector switches to the buy limit summary for that chain.
- Clicking a token name opens that token's Buy Limit or Sell Limit panel to check, edit, add, delete orders.
- Numbers/limits on order counts: not stated on this page.

## sniper__global-settings__sell-settings.md
- Confirm Manual Sell toggle: extra confirmation on manual sell buttons; does not affect Auto Sell.
- Sell KB: customizable sell keyboard values, with reset to defaults. Default values: not stated.
- Gas Price/Delta: refers to the Buy Settings page definitions.
- Price Impact Alert: shown for manual and automated sells above the threshold; can be bypassed by forcing the trade; default 20% for sells; value is tunable.
- Slippage toggle with tolerance for sells; warns extreme slippage on some chains risks MEV frontrunning.
- Smart Slippage: available on ETH, BSC, Base, Avalanche, Arbitrum; adjusts to token taxes and price impact; not suitable for launches/snipes; overrides custom Slippage (enabling one disables the other); recommended with high Gas Price/Delta.
- Manual sells and auto-sells (limit sells) generally use the Global Sell Settings gas and slippage.
- Auto PnL Card: generates a PnL card after every sell; sub-toggles "Duration" (shows trade duration) and "Inv. & Payout" (shows invested amount and payout in native currency).
- Auto Sell on Manual Buy: when on, creates the preset Sell Limit orders after every manual buy; when off, none are added. Automated buys use Auto Sell settings in Signals, Copytrade and Auto Snipe.
- Sell Limit (Presets) menu: Limit Type (Take Profit, Stop Loss, Trailing Stop Loss), Percentage Change, Balance, Duration.
- Percentage Change sign: positive for Take Profit, negative for Stop Loss and Trailing Stop Loss; applied to the trade entry price.
- Trailing Stop Loss: Percentage Change also serves as the anchor value; trigger never decreases.
- Initial Includes Fees (setting on General Settings page): enabled is the default; entry price then includes buy amount plus gas/bribe fees; disabled uses buy amount only. Applies to TP, SL, TSL.
- Preset Balance: percent of total token balance sold (example 50%). Preset Duration: hours, maximum 168 (7 days).
- Chain restrictions: only Smart Slippage lists chains.

## sniper__global-settings__approve-settings.md
- Exclusive to EVM-compatible chains.
- Auto Approve toggle: when on, bot sends an Approve transaction immediately after a successful buy; when off, approve manually. Described as basically required for Auto Sell. Default: not stated.
- Gas Price/Delta for Approve: Gas Price on BSC, Gas Delta on other EVM chains; high values not needed, especially with Auto Approve.
- Gas Price (BSC) / Gas Delta (other EVM) are configured separately for Buys, Sells and Approves.
- Warning: token buy tax means you start at a loss equal to the tax (example 15% buy tax = -15%); a strict stop loss can trigger an immediate auto-sell.
- Custom slippage on EVM must be at least the token's buy tax or the transaction fails; applies to manual and automated buys; not to auto-snipes, where slippage can be lower than the buy tax.
- Global settings affect Signals and Copytrade but can be overridden in their dedicated settings.

## sniper__signals__index.md
- Reached from /start menu "Signals".
- Maestro DMs signal covered on the pasted-contract auto-buy page.
- Call Channels: list of Telegram call channels you can activate to auto-buy on received signals; ordered by number of Maestro users tracking them.
- Search button finds a channel by link or numerical ID.
- Selecting a channel opens settings for activation, slippage, gas price/delta, auto-buy checks, preset sell limits applied after each auto-buy from that channel.
- Scraper signal: for channels not found in the bot, use the standalone Maestro Scraper; offers the same settings as a call channel.
- External Signals: need both activation in the bot and a valid subscription with the provider.
- Settings menu behaves the same for Call Channels, External Signals and Scraper.
- Number of channels or limits: not stated.

## sniper__signals__signals-settings.md
- Activation: set a Buy Amount and press "Inactive" to make the signal Active; auto-buys need "Allow Auto Buy" enabled in Global Buy Settings; bot warns if it is not.
- No-liquidity token: bot still sends the Token Report; on an active auto-buy signal it says auto buy will not trigger because there is no liquidity yet.
- Track Only: no auto-buy, only prints the Token Report; a signal cannot be both Active and Track Only.
- Auto Buy Checks: Min/Max MC, Min/Max Liquidity, Max Buy/Sell Tax; any unmet limit stops the auto-buy; inherit Global Buy Settings initially, can be customized or disabled, signal values take priority.
- Buy Amount in BNB/ETH/AVAX/S/TRX/TON/SOL; required to activate. Default: not stated.
- Slippage: mirrors Global Buy Settings initially; customizable per signal.
- Smart Slippage: ETH, BSC, Base, Avalanche, Arbitrum; not for launches/snipes; overrides Slippage (mutually exclusive).
- Multi Buy: wallets participating in the signal's auto-buys; defaults to the Default wallet.
- Gas Price/Delta: not available on Arbitrum and TON; Gas Price for BSC; Gas Delta for Ethereum, Base, Avalanche, Sonic, TRX, Solana; mirrors Global Buy Settings initially, signal values take priority.
- Degen Mode: when on, auto-buys are not blocked on honeypot, blacklist risk or unhealthy liquidity; defaults to Global General Settings state, overridable per signal.
- Auto Sell toggle: creates preset sell limits after each automated buy from this signal.
- Sell Limit presets: default to Global Sell Settings; override per signal; "Reset to Global" button restores.
- Preset fields: Limit Type (TP/SL/TSL), Percentage Change (positive for TP, negative for SL/TSL, relative to entry price; TSL anchor), Balance (percent of total balance), Duration (max 168 hours).
- Initial Includes Fees: enabled is the default; entry price includes buy amount and gas/bribe fees.
- If Buy Amount exceeds the max transaction limit and the bot can estimate that limit, it adjusts the amount automatically.
- Signals sniping uses the same protections as the warning-messages page and blocks auto-buys on scam/problem tokens.

## sniper__pasted-contracts__index.md
- Enables manual buy and sell by pasting a contract, similar to Pancakeswap/Uniswap, and auto-buy through the Maestro DMs signal.
- Four sub-pages: Token Report Menu, Token Report Details, Auto Buying, Warning Messages.
- No numbers or restrictions stated.

## sniper__pasted-contracts__token-report-menu.md
- Token Report is opened by pasting a CA in DMs; on EVM chains a Uniswap V4 pool ID (64-char 0x identifier) also works and resolves to the token.
- Track: opens a Trade Monitor without buying; works without owning the token.
- Chain cycle button switches chains if an address exists on several.
- Approve (EVM only): sends Approve for the selected wallet (single mode) or selected wallets (Multi); can approve before buying (useful for pre-launch); Auto-Approve in Global Approve Settings does it after buys.
- Revoke (EVM only): revokes a prior approval for all connected wallets.
- Go to Sell toggles buy and sell menus.
- Multi Buy: shown only when Multi enabled; defaults to wallets enabled for "Manual" in Wallet Settings.
- Single Wallet Mode when Multi is disabled; button shows the wallet name.
- Multi Sell: dropdown of wallets with positive balance, all enabled by default.
- Buy X native (BNB, ETH, AVAX, S, TON, TRX, SOL); Buy X Tokens (not on TON).
- Ape Max (buy max TX) and Sell Max TX: ETH, BSC, Base, Avalanche, Arbitrum only.
- Sell All: sells entire holdings across all wallets for the chain; Sell X%; Sell X native; Sell X Tokens.
- Slippage and Gas Price/Delta set here apply only to manual trades from this panel, separately for buy and sell, and do not change globals; re-pasting shows the global values.
- Gas Price/Delta not available on Arbitrum, TRX, TON.
- Snipe button: exclusive to Ethereum, BSC, Base, Arbitrum, Solana (discussed in Auto Snipe section).
- Buy Limit and Sell Limit buttons open the limit order panels.
- After a buy or Track, the Trade Monitor opens automatically.

## sniper__pasted-contracts__token-report-details.md
- Referral: quick-buy referral link for the token.
- Launchpad (EVM): shows origin such as FourMeme, Virtual, Flap; green mark if recognised, else "Unknown" with warning.
- AUDIT (EVM): link to Serialized Audit; only where available; hidden for tokens from known launchpads.
- Pool: on TON and EVM the highest-USD-reserve supported pool is shown, but EVM trades use the pool with the highest output; Solana picks the pool with the highest output for the trade.
- Hits: Premium only; number of Maestro users who pasted the same contract.
- Gas line (EVM): BSC shows current minimum gas price; other EVM chains show average gas price.
- TX Fees (EVM): estimated buy (B) and sell (S) gas fees using the report's Gas Price/Delta.
- Burnt: percent of max supply burned; not on Solana and TRX.
- Clog (EVM): percent of max supply held in the token contract balance.
- Max TX (EVM): max buy, max sell, max wallet; if a buy exceeds max buy the bot adjusts it, provided a concrete max buy can be estimated.
- Price, Market Cap displayed.
- Taxes (EVM): buy, sell, transfer tax at paste time; Smart Slippage needs concrete buy and sell tax estimates.
- Liquidity: USD value of pool liquidity; under 0.1% called highly suspect.
- Updated: UTC timestamp at the bottom.
- Limit Orders summary: counts of active buy and sell orders on the token across connected wallets for the chain.
- Balance: expandable; token balance, percent of supply and native balance per wallet; wallets with tokens listed first.

## sniper__pasted-contracts__auto-buy-on-pasted-contract.md
- Maestro DMs signal auto-buys pasted contract addresses; set up via /start -> Signals -> Maestro DMs.
- Requires Buy Amount and pressing "Inactive" to activate; requires "Allow Auto Buy" in Global Buy Settings; bot warns if off.
- Auto Buy Checks: Min/Max MC, Min/Max Liquidity, Max Buy/Sell Tax; inherit global buy settings; Maestro DMs values take priority.
- Slippage, Smart Slippage, Gas Delta/Price, Degen Mode mirror global settings initially and affect only pasted-contract auto-buys.
- Multi Buy defaults to the Default wallet; customizable.
- Auto Sell toggle with Sell Limit presets inheriting global presets; Maestro DMs values take priority.
- On paste, bot checks market cap, liquidity, tax conditions then auto-buys with the Buy Amount and signal slippage/gas.
- Buy Amount over max tx limit is auto-adjusted if the limit can be estimated.
- To stop auto-buying pasted contracts, set the signal to Inactive; shortcut /quick shows quick settings for enabled chains; chain suffix variants such as /quick_eth and /quick_sol.
- Default Buy Amount and check values: not stated.

## sniper__pasted-contracts__warning-messages.md
- Warnings appear at the end of a Token Report and block automated buys unless Degen Mode is enabled in signals settings.
- "Buy-Sell tax could not be estimated": trading may not be enabled yet or the contract is problematic.
- Honeypot: detected via internal simulation; no auto-buy.
- Blacklist risk: detected via internal simulation; no auto-buy.
- Liquidity / Total Supply under 1%: pool deemed unhealthy.
- High Tax: informational, blocks nothing; "unusually high" threshold not stated.
- Siphon tokens (EVM only): contract with a hidden backdoor letting an unapproved address move tokens.
- Buying a suspected siphon shows a confirmation with "Yes, buy at my own risk" or "No, cancel buy"; a gate, not a hard block.
- Protections are not fool-proof; manual buy remains possible where auto-buy refuses.

## sniper__premium-subscription.md
- Price: $200 a month; pay through the bot via /premium.
- Access to Maestro Pro Bot (faster than base).
- Launch Simulator: finds launch taxes, deadblocks, max wallet before launch.
- Trending list of pre-launch and launched tokens from the past 6 hours; via /trending in the Pro Bot.
- Trade Monitor concurrent trades: 30 premium vs 10 base.
- Trade Monitor duration: 96 hours premium vs 36 hours base.
- Wallets per chain: 10 premium vs 8 base.
- Copytrade wallets per chain: 12 premium vs 5 base.
- Concurrent auto-snipes per chain: 10 premium vs 5 base.
- Limit orders: up to 120 premium vs 60 base.
- Hits indicator (users who pasted the same contract).
- First-class support; Maestro Yacht Club private group.
- Chain restrictions: not stated.

## sniper__positions.md
- A position is created per buying wallet for each token bought through Maestro; updated on each Maestro buy or sell with that wallet.
- Access: /start -> Positions, or /positions, /pos; per-chain /pos_bsc (same pattern for other chains).
- Wallet selector row switches the wallet whose positions are shown.
- Fields: Token Name, Initial (spent), Payout, Tokens (percent of total supply), Worth, Profit/Loss, PI (price impact of your sell), Price | MC.
- Payout formula: Initial * (1 + P/L w/tax) * (1 + Price Impact); includes taxes and price impact.
- Worth: current holdings value in native coin, ignoring sell taxes and price impact.
- P/L: percent change between Initial and Payout; clicking it generates a PnL Card.
- PnL Card options: add/remove trade duration and invested amount; still image or video, toggle "Switch to Video" / "Switch to Image"; default via "PnL As Video" setting; one video renders at a time; carries "Trade on Maestro!" caption opening the bot on that token.
- Initial only updates from Maestro buys; outside trades make it mismatch, shown as "Initial Outdated" alert (also in Trade Monitor).
- Clicking the alert asks to confirm a reset; Yes sets Initial and Worth both to current worth in native coin.
- Per position buttons: Reset P/L (same reset with confirmation), Track (opens Trade Monitor), Remove (asks whether for this wallet only or all connected wallets).
- Overlay: Track All (adds positions for the selected wallet, most recent first, up to Trade Monitor capacity: 10 base, 30 premium).
- Add Position: creates a position for the selected wallet only from its current balance; useful for outside buys or transfers.
- Refresh: refreshes values; needed after adding or resetting.

## sniper__trade-monitor__trade-monitor-menu.md
- Arrows cycle between Trade Monitors; Refresh forces update and resets the timer to 36 hours (96 for premium).
- Copy CA copies contract address.
- Go to Buy toggles buy/sell menus.
- Multi Buy (shown when Multi on; defaults to wallets flagged "Manual") and Single Wallet Mode (when Multi off).
- Multi Sell: wallets with positive balance, all enabled by default.
- Buy X native (BNB, ETH, AVAX, S, TON, TRX, SOL); Buy X Tokens (not on TON); Ape Max (ETH, BSC, Base, Avalanche, Arbitrum).
- Sell Initials: sells tokens equal to the monitor's Initial amount for selected wallets.
- Sell All (all wallets on chain), Sell X%, Sell X native, Sell Max TX (ETH, BSC, Base, Avalanche, Arbitrum), Sell X Tokens.
- Slippage and Gas Price/Delta set here apply only to manual trades from this monitor, separately for buy and sell; do not change globals; Gas Price/Delta not on Arbitrum, TRX, TON.
- Delete removes the monitor; positions and limit orders are unaffected; re-track from the Token Report.
- Buy Limit and Sell Limit buttons open the limit order panels.
- Capacity numbers are not on this page (see premium and positions pages).

## Gaps vs our docs
Basis: only FEATURE_PARITY.md and CAPABILITY_MATRIX.md. "Not mentioned" means neither doc lists it as implemented; a few items are partial and noted.

### limit-orders (index, sell, buy, active)
- Entry-price trigger with dynamic recompute after each buy: not mentioned (docs list TP/SL/trailing/OCO and market-cap triggers only).
- Multi-wallet (Multi Sell / Multi Buy) limit orders added to many wallets in one action: not mentioned.
- Per-order Config edit (trigger, balance/amount, duration) and Delete UI: not mentioned.
- Percent-relative triggers (percent change from current price/MC) and upper/lower buy limits: not mentioned (limit buy exists, trigger forms not detailed).
- Duration with 168-hour maximum: not mentioned.
- Balance percent of total balance at trigger: not mentioned.
- Active Orders panel and /orders command, per-chain summary: not mentioned.
- Limit order count caps 60/120: the docs say the count is placeholder and enforced only in the web practice terminal, not as Maestro's behavior.

### sell-settings
- Confirm Manual Sell, customizable Sell KB: not mentioned.
- Price Impact Alert (20% default for sells) with force-through: not mentioned (parity doc lists the buy-side 20% as documented, not implemented).
- Slippage / Smart Slippage settings and auto-slippage by tax/impact: not mentioned (docs only say slippage is never silently widened).
- Auto PnL Card with Duration and Inv. & Payout toggles: not mentioned.
- Auto Sell on Manual Buy toggle and global preset Sell Limit (percentage change from entry price, Initial Includes Fees): not mentioned.
- Gas Price/Delta settings for sells: not mentioned.

### approve-settings
- Auto Approve after buy toggle: not mentioned (an automatic exact-amount approval child tx exists on the fork port, but no setting).
- Approve gas price/delta separate from buy/sell: not mentioned.
- Slippage-versus-buy-tax requirement on EVM: not mentioned.

### signals index
- Call Channels list, ordering by user count, Search by link or ID: not mentioned.
- External Signals with provider subscription: not mentioned.
- Scraper as signal with its own settings: partial (apps/scraper has filters and presets; settings parity and live Telegram not done).

### signals-settings
- Active/Inactive plus Track Only mutual exclusion: not mentioned (scraper has preview/auto modes only).
- Auto Buy Checks (Min/Max MC, Min/Max Liquidity, Max Buy/Sell Tax) with global inheritance and per-signal override: not mentioned (snipe pre-checks exist, but no signal-level inheritance).
- Per-signal Buy Amount, Slippage, Smart Slippage, Multi Buy wallets, Gas Price/Delta, Degen Mode: not mentioned.
- Per-signal Auto Sell and sell limit presets with Reset to Global: not mentioned.
- No-liquidity notice message: not mentioned.
- Auto-adjust buy amount to max tx limit: not mentioned.

### pasted-contracts index
- Manual buy/sell by pasting a contract address in Telegram: not mentioned as implemented (Telegram app is a command handler stub; practice web terminal only).

### token-report-menu
- Uniswap V4 pool ID resolution: not mentioned.
- Track to open Trade Monitor, chain cycling, Approve and Revoke buttons: not mentioned (approval planning exists in packages/evm; no Revoke).
- Multi Buy / Single Wallet Mode, Multi Sell, Sell All, Sell X%, Sell X native, Ape Max / Sell Max TX, Buy X Tokens: not mentioned.
- Per-panel slippage and gas overrides: not mentioned.
- Snipe button (ETH, BSC, Base, Arbitrum, Solana): not mentioned.

### token-report-details
- Referral link, Launchpad detection, Serialized Audit link: not mentioned.
- Pool selection by highest output: not mentioned.
- Hits: docs state no Hits feature.
- Gas, TX Fees, Burnt, Clog, Max TX, Taxes, Liquidity fields, Updated stamp: partial (risk report measures tax and honeypot; the other fields are not mentioned).
- Limit Orders summary and per-wallet Balance block: not mentioned.

### auto-buy-on-pasted-contract
- Maestro DMs signal auto-buy on paste: not mentioned.
- /quick, /quick_eth, /quick_sol shortcuts: not mentioned.

### warning-messages
- Honeypot block: implemented (risk report, honeypot block); partial.
- Blacklist risk, Liquidity / Total Supply under 1%, High Tax, tax-not-estimable messages: not mentioned.
- Siphon token confirmation gate: not mentioned.
- Degen Mode (warn but do not block) override: the 2026-11-14 section lists Degen Mode as partially covered by copytrade work; no Degen Mode for signals.

### premium-subscription
- $200/month and the 10/30, 8/10, 5/12, 5/10, 60/120 limits and 36/96 hours: recorded as documented facts, but implemented tiers use placeholder values and are not enforced outside the web terminal.
- Pro Bot, Launch Simulator gating, /trending in Pro Bot, 6-hour trending window, Hits, Yacht Club, first-class support, /premium payment menu: not implemented (docs say no payment rail, no feature gating; 6-hour window not mentioned).

### positions
- Positions menu, /positions, /pos, /pos_<chain> commands: not mentioned (portfolio logic exists, no UI/commands).
- Payout formula, PI, Worth, per-wallet selector: not mentioned (portfolio has P&L, no payout/price-impact projection).
- Initial Outdated alert and reset: mentioned in the docs only as a documented trade-monitor item, not matched.
- Reset P/L, Remove, Track All, Add Position, Refresh: not mentioned.
- PnL Card (image/video, Trade on Maestro caption): not mentioned.

### trade-monitor-menu
- Trade Monitor views and limits: docs say not matched.
- Buttons (arrows, Refresh with 36/96 hour timer, Copy CA, Go to Buy, Sell Initials, Delete, per-monitor slippage/gas): not mentioned.
