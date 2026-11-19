# JupiterZ (RFQ) fills for large Solana orders

JupiterZ is Jupiter's RFQ (request for quote) router: market makers quote a fixed price off-chain, and the fill settles on-chain with the maker's tokens. This page covers how it works today, what our engine can and cannot do with it, a live price comparison, and the gated execution path built in `packages/sol/src/jupiterz.ts`.

Sources (read 2026-11-18, not recalled):
- Swap API V2 overview: https://developers.jup.ag/docs/swap/index.md
- `/order` and `/execute`: https://developers.jup.ag/docs/swap/order-and-execute.md, https://developers.jup.ag/docs/api-reference/swap/order.md, https://developers.jup.ag/docs/api-reference/swap/execute.md
- Gasless and fee payers: https://developers.jup.ag/docs/swap/advanced/gasless.md
- RFQ V1 (webhook): https://developers.jup.ag/docs/swap/routing/rfq/v1/overview.md, `quoting.md`, `settlement.md`, `webhook-api.md`
- RFQ V2 (streaming): https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming.md
- Order Engine program source and IDL: https://github.com/jup-ag/rfq-webhook-toolkit (`programs/order-engine/src/instructions/fill.rs`, `idls/order_engine.json`)
- Live API answers from `https://api.jup.ag/swap/v2/order` and `/build`, 2026-11-18 12:04–12:40 UTC (keyless, read-only, nothing signed).

## How RFQ fills work today

| Question | Answer | Source |
|---|---|---|
| Where are RFQ quotes requested? | `GET /swap/v2/order`. All routers compete (Metis, JupiterZ, Dflow, OKX). `excludeRouters=metis,dflow,okx` leaves only JupiterZ. With `taker` set, the answer carries an assembled, unsigned v0 transaction. | order-and-execute.md, api-reference/order.md |
| Can `/build` reach RFQ? | No. "JupiterZ (RFQ) is not available on the Router path." | swap/index.md |
| Who executes? | Jupiter. The user signs and posts to `POST /swap/v2/execute` with the `requestId`. Jupiter passes the transaction to the maker, who checks it (last look), co-signs, and lands it. | order-and-execute.md, rfq/v1/overview.md |
| Can we change the transaction? | No. "Transactions routed through JupiterZ cannot be modified after they are returned." No added fee transfer, compute budget, or Jito tip. | swap/index.md |
| Quote expiry | `expireAt` (unix seconds) is in the response and in the fill instruction. A V1 quote lives 55 s. Jupiter forwards it to the maker only while 20 s remain, so the user has about 35 s to sign. The program refuses the fill once `expire_at` is earlier than the cluster clock. | rfq/v1/quoting.md, fill.rs |
| Minimum size | Not documented. Observed: TSLAx RFQ quoted from 13 SOL (~$970) up. One 10 SOL request with a taker set got "Failed to get quotes". At 2,688 SOL (~$200k) the maker's output capped at about the $100k amount (48% less than Metis). | live API |
| How is a fill reported? | The `/execute` response: `status` Success/Failed, `signature`, `code` (0 = success; -1 missing cached order, -2/-3 invalid transaction, -2000 failed to land, -2001 unknown, -2002 invalid payload, -2003 quote expired, -2004 swap rejected), `totalInputAmount`, `totalOutputAmount`. The chain's own record is the transaction with that signature. | api-reference/execute.md |
| Fees | Jupiter's fee is already netted out of the maker's `output_amount`: 10 bps on these quotes (`feeBps`), plus a 5-byte trailer after the fill arguments that the program does not read. The maker pays the network and priority fees. The user pays rent only for an output token account the transaction creates. | rfq/v1/quoting.md, gasless.md, live API |

### Program IDs and signers in an RFQ transaction

The decoded live transaction (TSLAx, 1,343.8 SOL in, taker = a public exchange wallet, read-only):

| # | Program | What it does |
|---|---|---|
| 0 | `ComputeBudget111111111111111111111111111111` | price 7,231 µlamports/CU (paid by the maker) |
| 1 | `ComputeBudget111111111111111111111111111111` | limit 200,000 CU |
| 2 | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | create-idempotent the taker's TSLAx account (Token-2022). Funded by the taker. |
| 3 | `61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH` (Order Engine) | `fill(input_amount, output_amount, expire_at)` |

- **Signers:** two, both writable. Slot 0 is the **maker**, who is the fee payer (`signatureFeePayer` = `maker` in the response). Slot 1 is the **taker** (the user). Both slots arrive zeroed. There are no lookup tables.
- **Fill accounts** (IDL `fill`): taker, maker, taker input token account (optional), maker input token account (optional), taker output token account (optional), maker output token account (optional), input mint, input token program, output mint, output token program, System. The program id itself in an optional slot means "none".
- **What the fill moves** (`fill.rs`). Exactly `input_amount` goes from the taker to the maker: a System transfer CPI from the taker's own SOL when the taker has no input token account, otherwise a Token transfer. Exactly `output_amount` goes from the maker to the taker's output account, or to the taker's SOL. A Token-2022 mint with a transfer fee is refused. Taking SOL out to native requires one extra account: the maker's temporary wSOL PDA, seeds `["temporary-wsol-token-account", maker]`.
- **RFQ V2 (streaming)** quotes are different. They come back through Metis and settle inside Jupiter v6 via the `rfq_v2` program `fd3nMFYTQjX1yr5ER8u7tPdHJB7qt8RpDpNtLQX2Br5`. The taker is at slot 0 and the maker co-signs at slot 1. They still need the maker's signature, so they also go only through `/order` + `/execute`.

### Can our engine send it?

No. The maker's signature is added only during `/execute`, after the maker's last look, and the transaction cannot be changed. So the engine can build nothing itself; it can only **check** Jupiter's transaction and have Privy sign the user's slot. After that, `/execute` is the one way to land it. The transaction id (signature 0) is the maker's signature, unknown until `/execute` answers. The engine therefore tracks the trade by the user's own signature (slot 1) and maps it to the landed transaction.

### Privy policy

The server signs with `signTransaction`. Privy checks each top-level instruction against the `allowed-programs` rule.
- The RFQ transaction's top-level programs are ComputeBudget, Associated Token (both allowed today) and the **Order Engine `61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH`, which is not allowed today**.
- `sol-cap` (top-level System `Transfer` above 0.05 SOL) and `no-token-transfers` (top-level Token `Transfer`/`TransferChecked`) never fire. The SOL and tokens move inside the Order Engine's CPI, as they do inside Jupiter v6 today. So the per-trade cap on RFQ trades is the engine's own `caps`, not Privy's rule. That is the same as for Jupiter swaps today.
- **Made on 2026-11-18, at the user's request:** `61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH` is now in `allowed-programs` in the `memedesk-solana-trading` policy (`scripts/privy-policy.ts --add-program`: PATCH of that one rule, read back with 9 programs; the other two rules unchanged). A policy without it makes Privy refuse every RFQ signature: nothing reaches `/execute`, and the engine falls back to the normal `/build` route for that trade, with `SolanaChain.rfqNote` saying why.
- **What this allows.** The server's signer may now sign Order Engine fills for wallets that carry this policy. The engine gates each one (exact input, output at least the minimum, to the user's own account, two signers) before asking Privy. Privy's `sol-cap` does not limit SOL moved inside the program, the same as inside Jupiter v6, so the per-trade SOL cap stays the engine's own `caps`.
- **Not verified:** that Privy's `signTransaction` signs a transaction whose fee payer is another key. `PrivySolSigner` now takes the wallet's own slot from Privy's answer and checks it against the wallet key, so a wrong slot is refused rather than sent.

## Price comparison: `/build` vs RFQ, $100k buys (read-only)

$100k = 1,343.80 SOL (USDC→SOL `/order` quote at 12:04 UTC: 100,000 USDC → 1,343.80 SOL). Outputs are raw token units (8 decimals). `/order` outputs are after Jupiter's 10 bps fee; `/build` charges none. Time: 2026-11-18 12:04 UTC, US pre-market.

| Stock | `/build` (our path) | `/order` best (router) | `/order` JupiterZ only | RFQ vs `/build` |
|---|---|---|---|---|
| AAPLx | 27,855,958,455 | 27,938,077,481 (OKX) | 24,866,923,191 | **−10.7%** |
| TSLAx | 25,844,747,886 | 26,075,069,114 (Metis) | 26,017,888,599 | +0.67% |
| NVDAx | 61,857,846,191 | 62,227,536,793 (Metis) | 62,089,228,758 | +0.37% |

A second TSLAx sweep (12:40 UTC) compared JupiterZ only with the best non-RFQ router at each size: RFQ was 0.14–0.21% behind from 13 to 1,344 SOL, and 48% behind at 2,688 SOL (the maker's size cap).

Re-run in the RFQ Desk (below) about 13:15 UTC, TSLAx:
- $100k buy: RFQ +48.6 bps against `/build`, but Metis in `/order` was +72.6 bps. The engine, which compares RFQ with `/build` only, would have taken RFQ; the best route was still Metis.
- Ladder, buy: −18.7, −17.3, −18.8, −25.5 bps at $1k, $10k, $50k, $100k against the best other route, and −58% at $250k.
- Ladder, sell: −26.9 and −39.1 bps at $1k and $10k, −59.8 bps at $50k, −4.9% at $100k and −62% at $250k.

What this says:
- **RFQ did not win any of the three today, at this hour.** Metis or OKX in `/order` beat it. The survey's "38 of 56 filled by JupiterZ" is likely market-hours behaviour; this check was pre-market. It needs repeating during US market hours before relying on RFQ.
- **Most of the ~2% gap is not RFQ.** The biggest lever is `/order`'s Metis route, which `/build` does not match. `/order`'s Metis beat our `/build` by 0.6–0.9% today, with different venues in the route (HumidiFi, Hadron, Riptide in `/order`; ZeroFi, Whirlpool, Raydium CLMM in `/build`). That is a separate follow-up: see what `/build` leaves out.
- **RFQ quotes can be far off.** AAPLx was −10.7%, and TSLAx at $200k −48%. Our gate refuses either one, because the fill's output must reach the engine's minimum and beat `/build` by the margin.

## What is built

`packages/sol/src/jupiterz.ts` plus small changes in `solchain.ts` and `privysigner.ts`. **Off by default:** `SolChainConfig.jupiterz` must be set.

**When RFQ is chosen (all must hold).** The trade is a Jupiter-venue swap. SOL is on one side, and that side (the SOL in, or the minimum SOL out) is at least `jupiterz.minLamports`. It has no platform fee: the RFQ transaction cannot carry our fee transfers. A JupiterZ-only `/order` for this exact taker and amount returns `router: "jupiterz"`. The RFQ output is at least `/build`'s quoted output × (1 + `marginBps`/10,000). It reaches the engine's `minOut`. The optional `checkFill` hook (the stock share-price check) accepts it. Otherwise the normal `/build` path runs, unchanged.

**The gate (`gateRfq`).** It runs on the exact message bytes before anything is signed:
- Transaction shape: a v0 message, exactly two required signers, slot 0 = the quote's `maker` and fee payer, slot 1 = our wallet, both signature slots zero. No lookup tables, since none were seen; supporting them would need the chain-read tables as `/build` does.
- Instructions: only ComputeBudget limit/price (capped; the maker pays), at most one Associated-Token create(-idempotent) funded by and for our wallet for the output mint, and exactly one Order Engine `fill`. Anything else is refused. That includes System or Token instructions, a second fill, and an unknown program.
- The fill itself:
  - the discriminator, and data of 32 bytes or 32 + 5;
  - taker = our wallet and maker = the quote's maker, both signing;
  - `input_amount` = our input exactly, and `output_amount` ≥ the engine's minOut;
  - `expire_at` in the future and at most 120 s away;
  - mints and token programs match the trade (token programs as the chain reports them);
  - the taker's input account is ours (or "none" for SOL), and the taker's output account is our associated account (or "none" for SOL);
  - the maker's accounts are not ours, and any extra account is only the maker's temporary-wSOL PDA.
- Our wallet signs nothing else: the only instruction naming it as a signer is the fill. The ATA create names it as funder, and the Associated Token program checks that.
- Simulation: the unsigned transaction is simulated (`sigVerify: false`). Our wallet must spend at most the input plus new-account rent, and receive at least minOut.

**Execution and tracking.** The signed raw is stored as `jupz1:<requestId>:<expireAt>:<base64>` and its hash is the **user's signature**.
- `submit` posts it to `/execute`. Retries resend the identical bytes. The message never changes, so it can land at most once: ed25519 signatures are deterministic, and Solana drops a repeated message.
- A `/execute` failure is final only once chain time has passed `expireAt` (plus a margin) and the transaction is not on chain. Until then it counts as "ack lost": the engine looks again, never builds a new order for the same record.
- `lookup` / `receipt` / `confirmations` map the user's signature to the landed signature. They use `/execute`'s answer when we have it. After a restart, they scan the wallet's recent signatures for a transaction whose signature list contains ours.
- Receipts take the wallet's balances from the wallet's own slot, not slot 0. The network fee counts only when the wallet paid it.

**Tests.** `packages/sol/test/jupiterz.test.ts` (11 tests) uses the recorded live transaction (`packages/sol/test/jupiterzfixture.json`) and tampered copies of it. It covers the gate; order parsing; the engine path (choose, sign slot 1, `/execute` once, receipt from slot 1); the fallbacks; the share-price refusal; failure before and after expiry; recovery after a restart; and Privy signing slot 1 with and without the proposed policy rule. `apps/rfq` (below) re-quotes live and simulates the gated transaction read-only against mainnet.

## USDC as the quote asset (added 2026-11-18)

Market makers quote stocks closest against **USDC**. A stock is priced in dollars, so USDC→stock is one price for the maker; SOL→stock also prices SOL. Live TSLAx quotes, JupiterZ against the best other router:

| Pair | $1k | $10k | $100k |
|---|---|---|---|
| USDC → TSLAx | −9.1 bps | −7.8 to −8.4 bps | −0.1 bps |
| SOL → TSLAx | −18.7 bps | −17.3 bps | −25.5 bps |
| TSLAx → USDC (~$10k) | – | −5.8 to −8.9 bps | – |
| USDT → TSLAx | no quote | no quote | – |

What changed:
- **Engine.** `SolChainConfig.jupiterz.minQuote` lists other quote assets and the smallest raw amount on that side, for example `{ [USDC]: 10_000_000_000n }` for $10k. RFQ is now considered when SOL or a listed asset is on one side.
- **Simulation.** It no longer assumes SOL is the other side. On a USDC→stock fill the wallet may spend at most the USDC input, and SOL only for new-account rent.
- **Platform fee.** A USDC trade with a platform fee skips RFQ, because our fee is paid in SOL. Jupiter's referral fee would be the way to charge one.
- **Gate.** Unchanged; it already handled token input and output.
- **Engine venues.** The engine still needs a Jupiter venue for the USDC pair (`jupiter.pairs`), as for any pair.
- **Tests.** Gate tests for USDC-in and stock→USDC fills, and an engine test of USDC→TSLAx covering: RFQ used, the threshold, USDC not listed, SOL taken beyond rent, and a platform fee.

Live check in the RFQ Desk, $100k USDC→TSLAx (read-only): RFQ +44 bps against `/build`. The gate accepted the transaction. The simulation paid exactly 100,000 USDC and received exactly the maker's 259.52 TSLAx, spending 0.00156 SOL for the new TSLAx account's rent. The share-price check passed, and the engine decision was to use JupiterZ. That run's best other route, Metis inside `/order`, was still about 25 bps better.

Found on the way: the default quote wallet's USDC account is **frozen by the issuer** (Token error 17). The desk now skips frozen token accounts when it picks a quote wallet, and names the error when a simulation hits one.

## RFQ Desk (`npm run rfq`)

A standalone app (`apps/rfq/server.ts`, `apps/rfq/index.html`; http://127.0.0.1:3700) on top of the same code the engine uses. The desk never signs. It is read-only until you connect a wallet; then it forwards a quote your wallet signed to Jupiter, under RFQ_DESK_MAX_USD (default $1,500). A quote is offered for signing only when the gate accepts it, the simulation passes and the fill passes the share-price check (the same check the engine applies through `checkFill`); otherwise the desk says which one failed. It shows:
- **Quote.** A firm JupiterZ ticket that counts down to its expiry, the best other route, and our `/build` route. Each comes with the per-share price against the real share price (the `checkFillPrice` figures). The engine's decision is listed with every reason, exactly as `tryRfq` takes it.
- **Maker + our route (built 2026-11-19).** This row appears when the maker's quote is behind our route. A maker that runs out of inventory keeps quoting its last shares for any larger input, so its per-share price jumps past that size. On 2026-11-19 an SPCXx maker gave about 353 shares for both $100k and $250k, and was at market only up to about $40–50k.
  - **How:** the desk does a binary search (6 probes, price-only) for the largest size where the maker pays at least Jupiter's best other router. It then prices the rest through our own `/build` route and shows the total against "Our route".
  - **The note under the row** gives the maker's at-market size and the size where its inventory runs out, and says whether the maker's part clears the engine's margin.
  - **The engine does not split orders.** The row shows what a split would pay; the engine itself never splits an order.
  - **Results move from minute to minute.** Two runs a minute apart at $100k: split +83 bps and −1.7 bps against our route. Our full-size route had moved in between.
- **Transaction.** The maker's transaction decoded: the signature slots, each instruction with its accounts named, the gate's verdict and its checks. A read-only mainnet simulation shows what the quote wallet would spend and receive. If the quote wallet lacks the SOL, the desk says so.
- **Size ladder.** Buy or sell at $1k, $10k, $50k, $100k and $250k: JupiterZ against the best other route, quoted price-only (no wallet needed).
- **Gate lab.** The recorded mainnet transaction, as recorded or tampered with (amount +1, output redirected, extra SOL transfer, third signer), or any pasted `/order` transaction, run through the gate.

The node is the first of `SOL_RPC_URL`, Helius, Alchemy and the public RPC that answers. Early on 2026-11-18 the Helius key in `.env` answered HTTP 401, so the desk used Alchemy; after the key was replaced the same day, the desk used Helius. `JUPITER_API_KEY` is optional; without it, calls are paced to Jupiter's keyless limit.

**Trading from a connected wallet (desk).** "Connect wallet" offers two kinds of wallet:
- **Privy.** Email, social or wallet login, including the user's Privy embedded wallet. The desk uses the bundle built for the Solana test UI (`npm run build:privy`, then `apps/web/privy.bundle.js`) and the public `PRIVY_APP_ID`.
- **Any Solana wallet in the browser.** These are found through the Wallet Standard (MetaMask with Solana turned on, Phantom, Solflare, Backpack), with the older injected API as a fallback.

All of them sign through one function. Privy's approval screen reads balances through a read-only relay at `/api/sol/rpc`, using the same method allowlist as `apps/web`.

Privy only renders its login on origins listed in the Privy app. On 2026-11-18 its frame policy allowed `localhost:3000` and `127.0.0.1:3500`, so the desk on port 3700 needs `http://localhost:3700` and `http://127.0.0.1:3700` added under Domains and clients. The other option is running the desk with `PORT=3000`. The quote is then built for that wallet, so the gate and simulation run on its real balances.
- **Trade panel.** It shows the exact deal and the quote's countdown. If the engine would pass on the quote, it says why. "Sign in <wallet> and execute" hands Jupiter's transaction to the wallet, which signs slot 1.
- **Server checks.** `POST /api/execute` forwards to Jupiter's `/execute` only if all of these hold:
  - the signed message is byte-for-byte the one the server gated and simulated for that wallet;
  - the wallet's signature verifies, and the maker slot is empty;
  - the quote is live, and the trade is under `RFQ_DESK_MAX_USD` (default $1,500).

  Each checked order goes to Jupiter at most once.
- **Library.** The page loads `@solana/web3.js@1.98.0` from unpkg with a subresource-integrity hash, only to hand the transaction to the wallet.
- **Verified, without signing:**
  - against the live server, refusals for an unknown request, an unsigned transaction, a signature by another key, one changed byte, and a filled maker slot;
  - in the browser, the whole connect → quote → sign → refuse flow with a stand-in wallet.
- **Not verified:** a real wallet signing and a real fill. You run that.

**1inch / Tokka on Solana (checked 2026-11-18, for the benchmark suggested in a market note).** 1inch's docs list Solana (chain id 501) for intent-based and cross-chain swaps only, not classic swap. Every API needs a key, issued after KYC/KYB. No plain "mint in, amount, amount out" quote endpoint for Solana is documented on the pages read, and Tokka Labs is not named. The 1inch blog's Ondo volume figures ($2.5B cumulative; NVIDIA $354M, Tesla $332M, Google $249M) are not attributed to Solana; the only chain it names is BNB Chain (about $2.0B). A 1inch column needs a 1inch key and their Solana intent quote spec. Sources: https://business.1inch.com/portal/documentation/apis/swap/swap, https://business.1inch.com/portal/documentation/overview/supported-chains, https://1inch.com/blog/post/ondo-rwas-on-1inch.

## What is verified and what is not

Verified:
- The docs and live API facts above.
- The decoded live RFQ transaction.
- The gate against the recorded fixture and its tampered variants (unit tests and the desk's gate lab).
- The gate accepting a fresh live RFQ transaction (desk, about 13:15 UTC).
- `npm test`.

Not verified:
- Privy signing at slot 1 under the real policy.
- A real `/execute`. No real-money trade was made.
- RFQ winning during US market hours.
- `/execute`'s behaviour on a repeated `requestId`. The design does not depend on it.
- Behaviour when a quote uses lookup tables (refused today).

### What would be needed to go live
1. ~~Add the Order Engine program to the Privy policy.~~ Done 2026-11-18 (`scripts/privy-policy.ts --add-program`; README → JupiterZ).
2. Raise the engine's per-trade caps. RFQ only quotes from about $1k up, and the default cap is 0.05 SOL.
3. Collect platform fees on RFQ trades. Jupiter's referral params (`referralAccount`/`referralFee`) keep JupiterZ eligible; today RFQ is skipped when a fee applies.
4. Make one small mainnet RFQ trade, which you approve.
5. Re-run the comparison during US market hours to choose `minLamports` and `marginBps`. The wiring itself is done: `jupiterz`, with `checkFill` running the share-price check, goes through `createSolanaTrader` and `apps/server/solaccount.ts`, behind `JUPITERZ=on` (docs/PRODUCTION_SERVER.md).
