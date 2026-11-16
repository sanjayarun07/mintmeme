<!-- Paraphrased from docs.maestrobots.com on 2026-11-15 by a reading agent; spot-checked by hand for the conflicts listed in docs/MAESTRO_DOCS_READ_2026-11-15.md. Not Maestro's text. -->
# Maestro docs facts B (Sniper: Auto Snipe, getting started, wallets, FAQ)

Source: local copies of docs.maestrobots.com pages. "not stated" = the page gives no value.

## sniper__auto-snipe__index.md
- Auto Snipe is available only on Ethereum, BSC, Base and Solana.
- If the contract address is not known ahead of time, the page advises pasting the contract and using auto-buy on pasted contract instead (Section 4.3).
- ETH/BSC/Base feature 1, fully automated sniping: the bot picks the right launch transaction itself, aiming at Block-0.
- Mempool detection of the launch transaction is possible on Ethereum and BSC.
- If the launch tx is private, or the chain has no public mempool (Base), the bot detects it on the mined side and activates the snipe right away.
- Block-0 Tipping (bribing the blockbuilder with high gas) is Ethereum only.
- Feature 2, dynamic deadblock detection: it adjusts to deadblock rules even when a contract changes them inside launch functions. Deadblocks risk blacklisting or heavy temporary or permanent buy/sell tax.
- Feature 3, user-controlled tax thresholds: you pick maximum buy and sell tax. If the launch violates them, the bot notifies you and waits for taxes to drop.
- Feature 4, dynamic max buy adjustment: the buy never exceeds the contract max buy. Example: asking for 2% of supply when max buy is 1% is auto-reduced. This also applies to Block-0 snipes.
- Ethereum Block-0 bundle: all Maestro users' Block-0 buys are grouped into one bundle, and the blockbuilder picks the most valuable bundle.
- A higher ETH tip gives a better position in the bundle and a more valuable bundle (higher success chance).
- Backup snipe: a separate backup snipe is sent for every user alongside the bundle. It can be enabled or disabled, never causes a double buy, and both bundle and backup go out privately (sandwich/MEV is not a concern).
- Solana: automated sniping covers tokens launched on Raydium V4 pools only.
- Tip size guidance on this page: not stated (see config page).

## sniper__auto-snipe__auto-snipe-configuration__index.md
- Config sets defaults pre-applied to newly added snipes (examples named: gas price, slippage, Auto Sell).
- Path: /start menu, Auto Snipe, choose chain, then the Auto Snipe Menu, then the Config button.
- Detailed options are on the chain-specific sub-pages.

## sniper__auto-snipe__auto-snipe-configuration__ethereum-bsc-and-base.md
- Ethereum: Block-0 snipes join one bundle with Block-0 Tipping; an optional backup transaction covers a failed bundle.
- Ethereum Block 1+ snipes (deadblocks or private launch): sent individually, no tipping, no backup transaction.
- Ethereum: if the token launched but Auto Snipe is waiting for a tax-lowering tx, it counts as Block-0: bundled, tipped, and backup sent if enabled.
- BSC: no bundling, tipping or backup. Snipe fires as soon as safe (deadblocks, tax limits), so it may land in Block-0 or Block-1+.
- Base: no mempool, so no Block-0 sniping; no bundling, tipping or backup. It watches the launch or target tx on the mined side.
- Block-0 Tip (Ethereum only): amount of ETH tipped to the blockbuilder. Page advises values above 0.05 ETH for good entries. No tipping on Block 1+ snipes. Default: not stated.
- Slippage: applies to the auto-snipe and, on Ethereum, to the Backup Transaction. Default: not stated.
- Max Tx Only: fires only if you can afford max TX at that time; otherwise the snipe is deactivated.
- Advanced Block-0 Only (Ethereum and BSC): a Block-1+ trigger (deadblocks or private launch) does not fire the snipe.
- A mempool tax-lowering tx still counts as Block-0 under Block-0 Only; if that tx was sent privately, the snipe does not fire.
- Advanced Skip High Tax Launch: if launch buy and/or sell tax breaks your limits, the snipe is deactivated rather than waiting for a tax-lowering tx.
- Advanced Buy Tax / Sell Tax: maximum accepted taxes. Default for both is 50%.
- If taxes at launch exceed limits, the bot waits for a lowering tx and then fires. On Ethereum this is bundled with tipping (Block-0) plus a backup if enabled.
- Backup Tx (Ethereum only): only for Block-0 snipes, so it can only be enabled when Block-0 Tip is enabled. It mines only if the main bundle fails, and can still hit Block-0 if Gas Delta is high enough.
- Gas Price/Delta, ETH: gas delta for Block 1+ snipes and backup transactions. Block-0 snipes use tipping and their gas delta defaults to 0.1 gwei.
- Gas Price, BSC: used for all snipes. For Block-0 the bot keeps your gas price from exceeding the launch tx gas price (avoids frontrunning it).
- Gas Delta, Base: used for all Block 1+ snipes.
- Auto Sell: when on, creates the sell limit orders defined in Sell Limit after a snipe. When off, no sell limit orders are added even if defined.
- Sell Limit initially inherits Global Sell Settings (sell limit presets); edits in the Auto Snipe config take priority over Global Sell Settings.
- Menus for BSC and Base are similar to Ethereum with chain-specific differences.

## sniper__auto-snipe__auto-snipe-configuration__solana.md
- Tip: sets the Gas Delta for the snipe; higher values give quicker execution. Default: not stated.
- Slippage: slippage for the snipe. Default: not stated.
- Anti-MEV: when on, routes the snipe through private relays to guard against MEV/sandwich bots.
- Multi Buy: selects the wallets that join the snipe. Defaults to the Default wallet, and any selection of wallets can be set.
- Auto Sell: same behavior as on EVM chains (creates Sell Limit orders after a snipe; config limits override Global Sell Settings).
- No Block-0 Tip, Backup Tx, Max Tx Only or tax options appear on the Solana config page.

## sniper__auto-snipe__activating-auto-snipe__index.md
- Each added snipe has its own settings that override the config defaults for that token.
- Two ways to add a snipe. Way 1: in the Auto Snipe menu click Add Snipe, enter the token address, and you land in the Auto Snipe Settings.
- Way 2: paste the contract or chart into the bot to open the Token Report Buy Menu. A row labelled "Snipe Now" appears only for tokens that are not tradable yet.
- Snipe Now asks for the amount to snipe with, then opens the Auto Snipe Settings. A "Snipe" button on the same menu opens the settings directly.

## sniper__auto-snipe__activating-auto-snipe__ethereum-bsc-and-base.md
- Per-token settings menu is similar on ETH, BSC and Base. Backup TX and Block-0 Tip are Ethereum only.
- Advanced button reveals more settings on all three chains; Block-0 Only is irrelevant for Base.
- Simulate: Premium exclusive. It simulates a contract launch and identifies deadblocks, launch taxes, launch methods and max buy before launch. It is mainly informational because Auto Snipe handles these anyway.
- Block-0 Tip, Multi Buy, Backup TX, Gas Delta, Block-0 Only, Skip High Tax, Buy Tax and Sell Tax mirror the config but can be changed per token.
- Max Buy: the most ETH or BNB you will spend on this snipe. Default: not stated.
- Slippage Mode has three options and only one can be enabled at a time:
  - Slippage: uses the config slippage by default; enabling it prompts for a different value.
  - Min Token: minimum percent of supply (example 1%) or token amount (example 1k). If Max Buy cannot afford it, the snipe is deactivated.
  - Max TX Only: fires only if Max Buy can afford max TX; otherwise deactivated.
- Pre-Approve: sends an Approve tx for the token before sniping, so you can sell immediately after a snipe.
- With Auto Approve enabled in Approve Settings, an Approve tx is sent automatically after a successful snipe.
- Activate by clicking the red Auto Snipe button, which turns green. The bot then snipes once the token is "tradable" under your configuration.

## sniper__auto-snipe__activating-auto-snipe__solana.md
- Buy Amount: the SOL amount to snipe with. Default: not stated.
- Tip, Slippage, Anti-MEV and Multi Buy mirror the config but can be changed per token.
- Activation is the same red-to-green Auto Snipe button; the bot snipes once the token is tradable.
- No Pre-Approve, Simulate, Min Token or Max Buy on this page.

## sniper__getting-started.md
- Start the bot on Telegram and solve a Captcha. After a failed attempt you get three more tries.
- After those, the bot goes idle for one minute. You can then retrigger verification by sending /start in DMs.
- After verification, /start in DMs opens the main menu.
- Main menu buttons: Chains, Wallets, Global Settings, Signals, Copytrade, Auto Snipe, Active Orders, Positions, Bridge, Premium, Referral, Cashback, Language, and "BUY & SELL NOW!" (paste a contract to open the trade panel).
- Bridge is described as cross-chain swaps powered by Relay.
- Chains menu: also reachable with the /chains command. You can enable or disable chains, and each chain has a Wallets button.
- Disabling a chain removes it from the options shown for each bot function.
- Twelve supported chains: Solana, BNB Smart Chain (BSC), Base, Ethereum, Monad, Sonic, Avalanche, Arbitrum, Hyper EVM, Robinhood, Tron (TRX), TON.
- All chains except TON and Solana are called EVM-compatible chains in the docs (so Tron counts as such per this wording).
- Supported DEXs and launchpads per chain (exact):
  - BSC: PCS V2, PCS V3, PCS Infinity CL, FourMeme/SpringBoard
  - Ethereum: Uniswap V2, Uniswap V3
  - Arbitrum: Uniswap V3, SushiSwap V2, OreoSwap, Camelot
  - Base: Uniswap V2, Uniswap V3, SushiSwap V2, Aerodrome V2, Virtuals, PancakeSwap Infinity CL
  - Avalanche: Trader Joe V1, Trader Joe V2.1
  - Sonic: NDYOR V2, SonicSwap V2, SBoom V2, SushiSwap V2, MetropolisSwap V2, ShadowSwap V2/V3, SwapX V2/V3, Wagmi V3
  - Monad: Uniswap V2, Uniswap V3, PancakeSwap V2, PancakeSwap V3, Monday V3, Noxa V2, NadDotFun, FlapLaunch, DYORSwap, DYORPump, CapricornCL, Printr
  - Hyper EVM: HyperSwap V2/V3, KittenSwap V2/V3, LiquidLaunch, Project X V3
  - Robinhood: Uniswap V2, Uniswap V3, Uniswap V4, Virtuals, FlapLaunch, Livo V2, Trench, DYORPump, DYORSWAP, Bags, RobinFun, HoodFun, ApeStore, NoxaFun, LeaveHood
  - Solana: Raydium, Orca, Meteora, FluxBeam, Pump.Fun, Moonshot
  - TRX: SunSwap V2, SunPump
  - TON: DeDust V2, STON.fi
- Minimums, bridge chain list: not stated on this page.

## sniper__wallet-setup.md
- Wallets are needed for Signals, Copytrade, Auto Snipe and manual trading.
- Path: /start, Wallets, choose an enabled chain, then import or generate. The same screen is reached from the Wallets button in /chains.
- The page recommends generating a new wallet rather than importing your main wallet.
- You are asked to name the wallet. If you generate one, importing the private key into a wallet such as TW or Metamask is recommended but not required, since the bot can send native and tokens out.
- To save credentials, the page says to use pen and paper and never the clipboard.
- Fund wallets with native only (SOL, BNB, ETH, S, AVAX, TRX or TON).
- Wallet cap: up to 8 wallets per chain, or 10 for Premium users.
- Rearrange Wallets: sets the order wallets appear in throughout the bot, including the manual buy/sell wallet selectors.
- Manual (per wallet toggle): marks the wallet as a participant in manual buys and multi-buys. The first wallet is auto-enabled, and at least one Manual wallet must always exist.
- Default Wallet (per chain): exactly one is required. It is the default for automated buys from Signals, Copytrade and Auto Snipe, and per-feature settings can choose which wallets take part.
- Wallet Config, Send native (page titles it Send BNB; the same applies to SOL, ETH, S, AVAX and TON): destination is one of your wallets or an external address. Amount is raw or a percentage (50% sends half, 50 sends 50 units).
- Wallet Config, Send Tokens: paste the token contract, choose the destination, and enter a raw or percentage amount.
- My Wallet Tracker: links to the free Maestro Wallet Bot.
- Rename: renames the wallet.
- Import Cross-Chain: on all EVM-compatible chains. Targets listed: BSC, Base, Ethereum, Monad, Sonic, Avalanche, Arbitrum, Hyper EVM, Robinhood. You name the wallet on the destination chain.

## sniper__faq__supported-chains-and-dexs.md
- Twelve chains: Solana, BNB Smart Chain (BSC), Base, Ethereum, Monad, Sonic, Avalanche, Arbitrum, Hyper EVM, Robinhood, Tron (TRX), TON.
- The DEX and launchpad table is identical to the one in sniper__getting-started.md (the per-chain lists above).
- Minimums: not stated.

## sniper__faq__wallet-settings.md
- One wallet can be used on all EVM-compatible chains (BSC, Base, Ethereum, Monad, Sonic, Avalanche, Arbitrum, Hyper EVM, Robinhood), via private key or mnemonic, the Import Cross-Chain button, or the /import command.
- /import takes 4 arguments: origin chain, origin wallet name, destination chain, destination wallet name. Example: /import BSC main ETH Wallet1. It can also recover funds sent to the wrong EVM chain.
- Gas Price applies on BSC (higher price means faster and costlier). Other EVM chains and Solana use Gas Delta.
- Gas Delta on EIP-1559 chains (Base, Ethereum, Monad, Sonic, Avalanche, Hyper EVM, Robinhood): max priority gwei on a Type-2 tx, added on top of the current gas average. Example: 10 base plus 3 delta gives 10+3 gwei.
- Arbitrum: Gas Price/Delta is irrelevant because the chain is first-come-first-served.
- Solana: minimum fixed fee 0.000005 SOL, plus an optional boost via Gas Delta. A Gas Delta of 0.01 SOL gives 0.010005 SOL total.
- TON: the bot always sends 0.2 TON as a reserve for fees, and the remainder is credited back. Tron fee cannot be preset.
- Max Gas Limit: available on every EVM-compatible chain; the bot sets it optimally unless you want to block gas-hungry contracts. Default: not stated.
- Smart Slippage: on ETH, BSC, Base, Avalanche and Arbitrum. It overrides custom slippage using token taxes and price impact. Good for quick swaps and call-channel sniping, not for stealth launches or auto-snipes (disable it there). Pair with a high Gas Price/Delta.
- Slippage above 100% only matters when buying an exact token amount (auto-snipes with token amounts, Ape Max, Buy X Token). With slippage X00%, the bot sends (X+1) times the detected native amount. Example: 100 tokens cost 0.1 ETH at 200% slippage sends 0.3 ETH, and the excess is refunded.
- With exact native amounts, slippage above 100% equals 100%.
- You do not have to adjust all settings; defaults or disabled are fine.
- /wallets opens the wallets panel for all enabled chains; /wallets_bsc and /wallets_sol open single-chain panels (same pattern for every chain).
- Withdraw: /start, Wallets, chain, wallet config; amounts raw or percentage.
- Transfer shortcut: paste the receiving address to get a Wallet Summary panel for transfers from any connected wallet.
- Disconnect: /start, Wallets, chain, Delete. Back up keys first or move funds out.
- /orders summarizes active sell and limit buy orders; /summary summarizes active Trade Monitors; /autosnipe summarizes active auto-snipes.

## sniper__faq__multi-wallet.md
- Wallet cap on this page: 4 per chain for base users (1 Main plus 3 extra), 6 for Premium. This differs from sniper__wallet-setup.md, which says 8 and 10.
- Multi-wallet works for Auto Snipe (refer to the Multi-Wallet section).
- The Nuke Sell button on the trade monitor sells a token from all wallets at once.
- Multi-wallets follow the gas and slippage settings of the Main wallet, for uniformity.

## sniper__faq__manual-transactions.md
- Manual buy: paste the contract, use the buy menu; slippage, Gas Price/Delta and wallet are adjustable in the panel.
- Manual sell: paste the contract, use the Buy/Sell toggle to open the sell menu. This works even for tokens bought outside the bot.
- Tokens bought in the bot can be sold outside it, and the reverse.
- Auto-buy on pasted contracts is possible by configuring the Me channel.
- Manual trades use the wallet's gas settings, overridable per trade in the token buy menu or trade monitor menu.
- For speed, raise the gas price/delta.
- If a buy exceeds the contract max buy, the bot auto-adjusts it. The exception named is 0-block-delay Liquidity and Method sniping through Auto Snipe on Arbitrum.
- Exact token amounts are bought with the Buy X Tokens button.
- Failures point to the Transaction Error Messages page.

## sniper__faq__transaction-error-messages.md
- Insufficient Output Amount (EVM only): slippage too low. Raise slippage or gas price/delta; Smart Slippage needs high gas.
- Excessive/Insufficient Input Amount (EVM only): an exact-token buy failed because volatility exceeded slippage. Example: 1 token at 1 BNB with 100% slippage allows up to 2 BNB.
- Same error can occur in copytrade when the tracked wallet makes an exact-token Block-0 buy. The bot sends the lesser of your copytrade Buy Amount and the tracked wallet's native amount, so too low a Buy Amount fails.
- On sells, it can mean the contract forces a 0-token sale (often a scam).
- Insufficient funds for gas * price + value (EVM only): not enough native for value plus gas. Recheck gas settings against the balance.
- Transfer Failed / Transfer From Failed (EVM only), possible causes: trading not enabled, max wallet exceeded, max gas price on the contract, transaction cooldown, max sell below your amount, already sold (press Reset on the Trade Monitor), blacklisted or honeypot.
- Underpriced Transaction (EVM only): another tx from the same wallet is pending. The bot supports one tx per wallet at a time on EVM chains; Solana and TON are exempt.
- Transaction requires more gas than the max (EVM only): the tx would exceed your Max Gas Limit, so the bot blocks it.
- Too_Little_Received (EVM only): the buy or sell would return 0 tokens or native.
- Insufficient lamports (Solana only): not enough for value, fees/tip and the bot taxes taken per transaction.
- Too Little (Much) SOL received (required) (Solana only): slippage too low; raise slippage or gas delta.
- HIGH PRICE IMPACT ALERT: shown for manual and automated buys and sells when estimated impact passes the Price Impact Alert value. It can be bypassed by forcing the trade.
- Price Impact Alert defaults: 25% for buys, 50% for sells; both are tunable.

---

## Gaps vs our docs
Doc lines refer to FEATURE_PARITY.md (FP) and CAPABILITY_MATRIX.md (CM). "Not mentioned" means neither doc says it is implemented.

### sniper__auto-snipe__index.md
- Not mentioned as implemented: Ethereum Block-0 bundling with other users' buys and Block-0 Tipping; private backup snipe (FP line 80 says no bundles, no private relay); mined-side launch detection for Base; dynamic deadblock detection from launch functions; the notification when taxes violate limits.
- FP line 40 says there is no mempool monitoring "by design", but this page says Maestro detects launch txs in the mempool on ETH/BSC. Not a contradiction of Maestro facts, but a documented capability we lack.
- FP line 80 says "no Solana sniping", while CM line 75 reports a Solana snipe fork-tested on a local validator (conflict between the two docs, not with the page). Raydium V4 matches CM line 75.
- Contradiction check: FP lines 2 and 91, and CM line 91, state ETH/BSC/Base/Solana only, which matches.

### sniper__auto-snipe__auto-snipe-configuration__index.md
- Not mentioned: default snipe configuration menu per chain (Config button). FP line 8 and line 74 list auto-snipe config as not read; this page and the three chain pages are now read.

### sniper__auto-snipe__auto-snipe-configuration__ethereum-bsc-and-base.md
- Not mentioned as implemented: Block-0 Tip, Backup Tx, Block-0 Only, Skip High Tax Launch, Max Tx Only, per-chain Gas Price/Delta semantics, Auto Sell inheriting Global Sell Settings with config priority.
- FP line 40 does list tax and max-tx pre-checks and bounded attempts, but nothing on the 50%/50% default tax limits or the 0.05 ETH tip guidance. FP line 80 says the page values were "not on the page read"; they are now available.
- FP line 40 says `Sniper.decide` has "fixed slippage"; the page has per-token Slippage Mode (Slippage / Min Token / Max TX Only) and Smart Slippage guidance.

### sniper__auto-snipe__auto-snipe-configuration__solana.md
- Not mentioned: Anti-MEV private-relay routing for snipes (FP line 84 says no MEV routing, no Jito); Tip as Gas Delta; Multi Buy defaulting to the Default wallet; Auto Sell. CM line 76 mentions bulk buy up to 10 wallets for Solana, but not in the snipe context.

### sniper__auto-snipe__activating-auto-snipe__index.md
- Not mentioned: Add Snipe flow; "Snipe Now" row on the Token Report Buy Menu for non-tradable tokens; per-token override of config.

### sniper__auto-snipe__activating-auto-snipe__ethereum-bsc-and-base.md
- Not mentioned: Pre-Approve for snipes (CM line 55 has automatic exact-amount approval on fork, not pre-approve before a snipe); Min Token mode; Max Buy per snipe (FP line 40 has `maxSpend`, partially equivalent); Premium gating of Simulate. FP line 55 states no feature gating of Launch Simulator exists.
- FP line 41 gives snipes per chain 5 free / 10 premium; this page does not state a snipe cap (not a contradiction).

### sniper__auto-snipe__activating-auto-snipe__solana.md
- Not mentioned: per-token Buy Amount, Tip, Slippage, Anti-MEV and Multi Buy overrides on Solana snipes.

### sniper__getting-started.md
- Captcha verification, retry and cooldown flow: not mentioned.
- Main menu items (Active Orders, Positions, Language, BUY & SELL NOW, Premium, Referral, Cashback): only some are covered, in other rows (FP lines 55, 56, 83).
- /chains enable/disable per chain: not mentioned (CM line 93 says Hyper EVM and Robinhood have no rows).
- Chain list: FP line 18 and line 23 record 12 chains, matching this page. Homepage 13-chain claim is not on this page.
- DEX lists: CM lines 63-69, 86-88 cover only a subset. Not mentioned at all: PCS Infinity CL, SpringBoard, OreoSwap, SushiSwap V2, Aerodrome V2 detail, Virtuals, PancakeSwap Infinity CL, Trader Joe V1/V2.1 versions, every Sonic venue, every Monad, Hyper EVM and Robinhood venue, Uniswap V4, FluxBeam, Moonshot, SunPump versions. CM lines 68-69 mark Sonic and Monad "not assessed", and CM line 93 says Hyper EVM and Robinhood have no rows.
- CM line 65 lists Base as "Uniswap V3, Aerodrome" (omits Uniswap V2, SushiSwap V2, Virtuals, PancakeSwap Infinity CL). CM line 66 lists Arbitrum as "Uniswap V3, Camelot" (omits SushiSwap V2, OreoSwap). CM line 64 lists BNB as "PancakeSwap, FourMeme" (omits PCS Infinity CL; FourMeme/SpringBoard naming differs). Incomplete, not contradictory.
- FP line 82 says the Getting Started bridge chain list and minimums were not read; this page states the bridge is powered by Relay and gives no chain list or minimums.
- Tron: CM line 88 and FP line 63 treat it as its own chain family. The page classes it as EVM-compatible by exclusion (all but TON and Solana); our docs do not note this.

### sniper__wallet-setup.md
- Contradiction: FP lines 28 and 47 say wallets per chain 8 free / 10 premium, which matches this page. The multi-wallet FAQ page says 4 / 6, so the Maestro docs themselves conflict and FP does not record that.
- Not mentioned as implemented: generate/import wallets with names, Rearrange Wallets, Manual toggle, Default Wallet, Send native/tokens with percent amounts, Rename, Import Cross-Chain. FP line 47 says "No wallet management or creation".
- Wallet tracker link to Maestro Wallet Bot: FP lines 26 and 78 mention Wallet Bot as BSC/ETH/ARB only, which this page does not state.

### sniper__faq__supported-chains-and-dexs.md
- Same chain and DEX gaps as getting-started. FP line 18 matches the 12 chains.

### sniper__faq__wallet-settings.md
- Not mentioned as implemented: Smart Slippage (FP line 84 lists copytrade Smart Slippage as documented but not matched), slippage above 100% exact-out mechanism (FP line 38 says slippage is never silently widened, which is in tension with the bot sending (X+1) times native), Max Gas Limit, Gas Delta/Gas Price semantics, Solana base fee plus tip, TON 0.2 reserve, /import, /wallets, /orders, /summary, /autosnipe, paste-address transfer, wallet delete.
- Price Impact Alert: not on this page; see error-messages page.

### sniper__faq__multi-wallet.md
- Not mentioned: multi-wallet following the Main wallet's gas and slippage; Nuke Sell from all wallets. CM line 76 has bulk buy only (up to 10 wallets, buys only), and FP line 47 has independent per-wallet nonces.
- Wallet cap conflicts as noted under wallet-setup (4/6 here vs FP 8/10).

### sniper__faq__manual-transactions.md
- Not mentioned: Buy X Tokens, Ape Max (only referenced), Me channel auto-buy on pasted contracts, auto-adjust to contract max buy for manual buys, selling tokens bought outside the bot.
- Contradiction: CM line 66 and line 91 say Auto Snipe is not documented for Arbitrum, but this page mentions Auto Snipe Liquidity/Method sniping on Arbitrum (a likely stale reference in Maestro docs; the Auto Snipe index lists no Arbitrum).

### sniper__faq__transaction-error-messages.md
- Not mentioned: mapping of each EVM/Solana error to a cause; one-tx-per-wallet rule (FP line 21 covers nonce handling but not the Maestro rule); copytrade exact-input error.
- Contradiction: FP line 84 states Price Impact Alert default is 20% on buys (from buy settings per that row). This page says 25% for buys and 50% for sells. Quote: "Price Impact Alert default 20% on buys" (FP line 84). The two Maestro pages disagree; we should flag it.
- Not mentioned: sell Price Impact Alert default 50%.
