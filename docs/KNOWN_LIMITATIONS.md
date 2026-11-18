# Known Limitations

Scope of this repository after the 2026-11-17 cleanup: the **SDK** (`packages/core`, `evm`, `sol`, `sdk`), the **HTTP API** (`apps/api`), the **execution server** (`apps/server`)
and the **Solana test UI** (`/solana`, `apps/web`). Everything else (Telegram bot, scraper, full web terminal, markets and launch feeds, indexer, most fork harnesses and
their reports) was removed; it is preserved in git tag `v0.1.0-full-platform`, together with the longer version of this file. Where a limit below cites a check that was
run with a harness that no longer exists here, that harness and its report are in the tag.

After the 2026-11-18 review: `npm test` 465 of 466 pass (the Postgres test is skipped without `PG_TEST_URL`); `npm run verify:sol-guard` (local Solana validator, fake funds, Privy stand-in) 62 of 62, `verify:server-sol` 15 of 15 and `verify:server-base` 15 of 15 pass.

## Evidence levels
- **Practice chain** (`SimChain`, in-process simulator): everything in the SDK and API.
- **Local forks and validators** (fake funds, throwaway keys): Ethereum mainnet fork (engine, orders, bulk, TWAP, copy, snipe, Trader) and a local Solana validator with
  cloned Raydium AMM v4 / Jupiter routes and pump.fun programs. Single node: no real congestion, priority-fee market, MEV or leader schedule.
- **Solana mainnet, real funds, small amounts, through the /solana UI only**: market buy and sell via Jupiter signed in Privy; a limit sell signed in Privy; a limit buy
  and a limit sell fired unattended by the trading key; trading-key funding from the wallet; Privy automatic trading (a confirmed Jupiter buy, tx `5HyLiX…`, and a limit buy
  with a USD trigger that fired by itself, tx `2TiNZtup…`, both signed by real Privy under the app's policy with no wallet prompt). Take profit, stop loss, trailing stop, bracket, TWAP and the slippage chase have
  NOT been run on mainnet. Nothing has been run on Ethereum mainnet.
- **Execution server, real funds, small amounts:** Solana buys through the API (`MODE=solana-mainnet`, tx `3zMawg…`, and one with priority fee and Jito protection, tx `4EbzSN…`);
  a 0.01 SOL SPYx (tokenized stock) buy, tx `1FzsV6…`. Base: a 0.0002 ETH KEYCAT buy on Uniswap V2 (`MODE=base-mainnet`, tx `0x431b6a…`) and a 0.0005 ETH NVDAc
  (Coinbase stock token) buy through Relay (tx `0xce60b8…`), both signed by the user's Privy Ethereum wallet. No sell of a stock token, and no JupiterZ fill, with real funds.

## Execution
1. A price order is a trigger, not a resting order: when it fires it takes the pool price within the slippage. Triggers use the best authorised pool's spot price at tick
   time (no oracle, no second source); the executable-output check and `maxDeviationBps` limit, but do not remove, spikes inside one pool. A move shorter than one tick
   (about 1 to 2 s) is not seen.
2. Retries after a failed fill keep the original slippage unless the order opted into **chase**, which widens it by `stepBps` per attempt up to `maxBps`. Each retry is a new
   transaction. Chase is tested in unit and HTTP tests only (a failing fill cannot be forced on demand on the validator).
3. **USD triggers** are re-derived each tick from the quote-token USD price the host supplies (the /solana UI uses a Jupiter SOL to USDC quote, cached 30 s). A price older
   than 2 minutes moves nothing. The token's USD price is therefore only as good as that feed.
4. No mempool access anywhere: sniping and copy trading act after a block is mined, never first. MEV protection is opt-in (per account or per trade): private sending through Jito with a tip and the jitodontfront flag, which Jito says may reduce sandwiching but does not guarantee; it is spaced to Jito's default 1 request per second per IP, and run once on mainnet (tx `4EbzSN…`, a 7,754-lamport tip). Priority fees are estimated from recent fees on the trade's accounts (75th percentile, at most 0.0001 SOL per transaction, `packages/sol/src/priorityfee.ts`) with the compute-unit limit from a simulation; under heavy congestion that cap can still be too low to land quickly.
5. Simulation runs against current state; landing state may differ. A passing simulation is not proof of a safe token.
6. Platform fees on Solana are paid in SOL inside the trade to the configured fee wallets (operator and app; SDK_AND_API.md 4.8), on a sell computed on the guaranteed minimum output. Not on EVM. Fee wallets must already hold SOL.
7. Solana: no blockhash refresh (an expired transaction fails closed and needs a new intent), no pending-transaction cancel. EVM: cancel of a pending transaction is
   replace-by-fee (either may land); exact-amount approvals only.

## Solana
8. Venues: Raydium AMM v4, Jupiter Swap API V2 (we rebuild the transaction, allow only listed programs, refuse tips, extra signers and platform fees, simulate the exact
   bytes before signing) and pump.fun bonding curves. pump.fun curve trading and non-Raydium Jupiter routes have been run on the local validator only.
9. Copy trading sees a leader's swap on any DEX (from its balance changes) but can only mirror it on the venues above. A leader reorg flags the position; it never sells
   automatically.
10. Buys are checked by `TokenSafety` (freeze/mint authority, Token-2022 extensions, largest holders, a sell route, 1-SOL impact; SDK_AND_API.md 4.7). It does not simulate a sell, check LP locks, or know which large holders are pools other than pump.fun curves; it is not a certification. Sniping still uses the older `MintInspector`.

## Persistence and concurrency
11. With `persistDir` or a `state` backend, orders (including chase and USD-trigger settings), OCO claims, trailing peaks, reservations, TWAP and bulk state and the engine
    journal are written atomically before each action. A crash sweep over 18 checkpoint writes always produced exactly one execution. Whole-state JSON rewrite per step.
12. **Single writer per state set.** The file backend has no locking. Redis uses one lease per namespace (the server: one per user) with a fail-closed write; it is not a
    consensus lock, so a Redis failover that loses the lease key can briefly allow two writers.
13. Redis durability is the server's: without `appendonly yes` a Redis crash can lose recent checkpoints. Nodes refuse such a Redis unless told otherwise. No TLS client,
    no Sentinel or Cluster. Redis calls are synchronous (block the event loop for each call).
14. Postgres (optional, `PG_URL`) keeps a trade history and an audit log copied in the background; it is not the source of truth (Redis is), and a crashed node loses its last unwritten second of records.

## SDK and HTTP API
15. Tested on the practice chain, an Ethereum mainnet fork and a Solana validator. Snipe creation over HTTP answers 501 unless the host supplies a launch source; copy creation
    answers 501 too, except on the execution server in `MODE=solana-mainnet`, which supplies the leader source (copy trading over the API, SDK_AND_API.md 4.10; validator-tested, not on mainnet). No wallet creation, withdrawals, bridging or billing.
16. The package archive `memedesk-sdk-0.1.0.tgz` is not rebuilt automatically: run `npm run pack:sdk` after source changes.

## Execution server (`apps/server`)
17. Real accounts on Solana (`MODE=solana-mainnet`) and Base (`MODE=base-mainnet`); each user links a Privy wallet. Solana: local validator with two nodes, and small mainnet buys through the API. Base: local Base fork (15 checks) and two small mainnet buys; Uniswap V2 WETH pools and Relay (same-chain), or KyberSwap instead (`BASE_AGGREGATOR=kyberswap`: fork-tested 15 of 15, no mainnet trade through it yet), no token safety check, no fee sharing on Base. Coinbase stocks on Base: ticker lookup, the STOCKS_ENABLED switch and the 3% share-price check, checked read-only on mainnet; no real stock trade since the NVDAc buy. Orders, sells and failover through the server not yet on mainnet. One server runs one mode. See `docs/PRODUCTION_SERVER.md` for what was measured
    (failover 1 s graceful, 15 s after a crash) and its other limits (per-node rate limits, no throughput test).

## Solana test UI (`/solana`)
18. Single user, this machine only, real funds on mainnet. Sessions live in server memory: a restart signs the browser out and disconnects a wallet login or the trading key
    (orders are saved and resume when a signer is connected again). **Privy automatic trading resumes by itself** after a restart, once Privy confirms the wallet still
    carries the server signer and policy (`.state/sol-mainnet/automatic.json` holds the address and Privy wallet id, no key); if Privy is unreachable it retries every minute.
    State is files on this machine (no Postgres); the execution server keeps its state in Redis.
19. With a wallet login every order fire needs an approval in the open page. Unattended fires need **Privy automatic trading** (the user's own Privy wallet; Privy signs
    within the app's policy: Jupiter, pump.fun, System, Token, ATA and Compute Budget programs only, no SOL transfer above 0.05 SOL, no token transfers) or the **trading
    key**, a server-held throwaway wallet in `.state/sol-mainnet/trading-key.json` (0600), a hot key on disk, not custody. Both are capped at 0.05 SOL per trade and 0.25 SOL
    per day; the trading key also at 0.5 SOL held and 24 h. Privy's policy is checked per top-level instruction: what a swap program does inside (CPI) is not checked by Privy.
20. Privy sign-in depends on the origins allowed in the Privy app. Through the execution server's `/solana` link (127.0.0.1:3500) it worked on 2026-11-17 with this app's settings.
21. Holdings and history are read from the chain; USD values come from Jupiter quotes and are indicative.

## Security
22. The policy signer authorises with an in-process HMAC stand-in; it is not a security boundary. For Solana the signing key itself can be the user's Privy wallet
    (`PrivySolSigner`), where Privy enforces its own policy; the server's Privy app secret and authorization key are then the secrets to protect (`.env`, never committed).
    On Base the signing key is the user's Privy Ethereum wallet (`PrivyEvmSigner`): each signed transaction is compared field by field with the request and its signer recovered.
23. API keys are SHA-256 hashes in a file, with no rotation API. App keys (one key, many end users named in X-User-Id) and signed webhooks exist; webhooks are best effort (in-memory retries). The API and nodes speak plain HTTP; TLS belongs at the load balancer.
24. No legal, compliance or KYC analysis exists.
