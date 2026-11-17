# Known Limitations

Scope of this repository after the 2026-11-17 cleanup: the **SDK** (`packages/core`, `evm`, `sol`, `sdk`), the **HTTP API** (`apps/api`), the **execution server** (`apps/server`)
and the **Solana test UI** (`/solana`, `apps/web`). Everything else (Telegram bot, scraper, full web terminal, markets and launch feeds, indexer, most fork harnesses and
their reports) was removed; it is preserved in git tag `v0.1.0-full-platform`, together with the longer version of this file. Where a limit below cites a check that was
run with a harness that no longer exists here, that harness and its report are in the tag.

Tests at the time of the cleanup: `npm test` 370 of 370 pass; `npm run verify:sol-guard` (local Solana validator, fake funds) 55 of 55 pass.

## Evidence levels
- **Practice chain** (`SimChain`, in-process simulator): everything in the SDK and API.
- **Local forks and validators** (fake funds, throwaway keys): Ethereum mainnet fork (engine, orders, bulk, TWAP, copy, snipe, Trader) and a local Solana validator with
  cloned Raydium AMM v4 / Jupiter routes and pump.fun programs. Single node: no real congestion, priority-fee market, MEV or leader schedule.
- **Solana mainnet, real funds, small amounts, through the /solana UI only**: market buy and sell via Jupiter signed in Privy; a limit sell signed in Privy; a limit buy
  and a limit sell fired unattended by the trading key; trading-key funding from the wallet. Take profit, stop loss, trailing stop, bracket, TWAP and the slippage chase have
  NOT been run on mainnet. Nothing has been run on Ethereum mainnet.

## Execution
1. A price order is a trigger, not a resting order: when it fires it takes the pool price within the slippage. Triggers use the best authorised pool's spot price at tick
   time (no oracle, no second source); the executable-output check and `maxDeviationBps` limit, but do not remove, spikes inside one pool. A move shorter than one tick
   (about 1 to 2 s) is not seen.
2. Retries after a failed fill keep the original slippage unless the order opted into **chase**, which widens it by `stepBps` per attempt up to `maxBps`. Each retry is a new
   transaction. Chase is tested in unit and HTTP tests only (a failing fill cannot be forced on demand on the validator).
3. **USD triggers** are re-derived each tick from the quote-token USD price the host supplies (the /solana UI uses a Jupiter SOL to USDC quote, cached 30 s). A price older
   than 2 minutes moves nothing. The token's USD price is therefore only as good as that feed.
4. No mempool access anywhere: sniping and copy trading act after a block is mined, never first. No MEV protection, private relays, Jito tips or priority-fee estimation.
5. Simulation runs against current state; landing state may differ. A passing simulation is not proof of a safe token.
6. Platform fees are not collected on real chains (refused at build time rather than ledgered as collected).
7. Solana: no blockhash refresh (an expired transaction fails closed and needs a new intent), no pending-transaction cancel. EVM: cancel of a pending transaction is
   replace-by-fee (either may land); exact-amount approvals only.

## Solana
8. Venues: Raydium AMM v4, Jupiter Swap API V2 (we rebuild the transaction, allow only listed programs, refuse tips, extra signers and platform fees, simulate the exact
   bytes before signing) and pump.fun bonding curves. pump.fun curve trading and non-Raydium Jupiter routes have been run on the local validator only.
9. Copy trading sees a leader's swap on any DEX (from its balance changes) but can only mirror it on the venues above. A leader reorg flags the position; it never sells
   automatically.
10. `MintInspector` checks mint authority, freeze authority and Token-2022 only: no sell simulation, holder concentration or LP lock checks.

## Persistence and concurrency
11. With `persistDir` or a `state` backend, orders (including chase and USD-trigger settings), OCO claims, trailing peaks, reservations, TWAP and bulk state and the engine
    journal are written atomically before each action. A crash sweep over 18 checkpoint writes always produced exactly one execution. Whole-state JSON rewrite per step.
12. **Single writer per state set.** The file backend has no locking. Redis uses one lease per namespace (the server: one per user) with a fail-closed write; it is not a
    consensus lock, so a Redis failover that loses the lease key can briefly allow two writers.
13. Redis durability is the server's: without `appendonly yes` a Redis crash can lose recent checkpoints. Nodes refuse such a Redis unless told otherwise. No TLS client,
    no Sentinel or Cluster. Redis calls are synchronous (block the event loop for each call).
14. No Postgres backend.

## SDK and HTTP API
15. Tested on the practice chain, an Ethereum mainnet fork and a Solana validator. Snipe and copy creation over HTTP answer 501 unless the host supplies a launch or leader
    source. No wallet creation, withdrawals, bridging or billing.
16. The package archive `memedesk-sdk-0.1.0.tgz` is not rebuilt automatically: run `npm run pack:sdk` after source changes.

## Execution server (`apps/server`)
17. Practice accounts only: no real-chain account factory, because there is no production key custody. See `docs/PRODUCTION_SERVER.md` for what was measured
    (failover 1 s graceful, 15 s after a crash) and its other limits (per-node rate limits, no throughput test).

## Solana test UI (`/solana`)
18. Single user, this machine only, real funds on mainnet. Sessions live in server memory: a restart signs the user out and disconnects the trading key (orders are saved
    and resume when a signer is connected again).
19. With a wallet login every order fire needs an approval in the open page; unattended fires need the **trading key**, a server-held throwaway wallet in
    `.state/sol-mainnet/trading-key.json` (0600), capped at 0.05 SOL per trade, 0.25 SOL per day and 0.5 SOL held, expiring after 24 h. It is a hot key on disk, not custody.
20. Privy sign-in depends on the origins allowed in the Privy app; served through the execution server's `/solana` link on another port it may be refused (not tested).
21. Holdings and history are read from the chain; USD values come from Jupiter quotes and are indicative.

## Security
22. The policy signer authorises with an in-process HMAC stand-in; it is not a security boundary. Real deployments need an HSM, KMS or MPC signer behind the same interface.
23. API keys are SHA-256 hashes in a file, with no rotation API. The API and nodes speak plain HTTP; TLS belongs at the load balancer.
24. No legal, compliance or KYC analysis exists.
