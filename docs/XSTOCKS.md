# Tokenized stocks: what exists, where it trades, what this engine can trade

Checked 2026-11-18. Addresses come from each issuer's own list or API, and the important ones were read on chain. Liquidity figures are DexScreener `liquidity.usd` on the day, or our own on-chain reserve reads where noted. Liquidity changes daily, so re-check before relying on any figure.

**Short answer**

| Chain | Issuers live | Tradable with this engine today | Why |
|---|---|---|---|
| **Solana** | xStocks (Backed), Ondo Global Markets, Backpack Securities, PreStocks (pre-IPO; no official source) | **Yes**: 113 of 3,106 verified issuer mints trade within 3% of the share price (registry run 2026-11-18) | Jupiter routes them. Added in this change: Token-2022 accounts in the Jupiter path, plus an issuer-pinned TokenSafety allowance |
| **BNB Chain** | bStocks (Binance-affiliated), Ondo, xStocks | **No** | Liquidity is on PancakeSwap **V3**. The best V2 pools are TSLAB/WBNB at about $52k and QQQB/WBNB at about $59k (QQQB's address is not from an official list). xStocks and Ondo V2 pools are dust (we read a few dollars of reserves on chain) |
| **Base** | Coinbase Tokenized Stocks (base.org/stocks); xStocks is **not** deployed on Base | **Yes, through Relay** (new): all 10 base.org tokens passed a read-only simulated buy | There is no Uniswap V2 pool. Liquidity is on Aerodrome Slipstream (concentrated liquidity) and Uniswap V3/V4, which Relay reaches; every Relay transaction is gated and simulated before signing (see "Base through Relay") |
| **Robinhood Chain** (4663) | Robinhood stock tokens (203), Ondo (15, bridged) | **No** | The largest Uniswap V2 pool is SPY/USDG at about $4.9k. Liquidity is on Uniswap **V3/V4** (up to about $2.4M) and the Metric prop AMM |

The EVM side of this engine (`packages/evm`: `EvmRpcChain`, `V2Venue`) only prices and builds Uniswap V2-style swaps. No EVM chain has a V2 pool with real liquidity for a stock token, so per the brief **no EVM stock token is wired**. See "What it would take" below.

---

## Solana

### Issuers

| Issuer | Decimals | Token-2022 extensions | Issuer keys (pinned) | Official address source |
|---|---|---|---|---|
| **xStocks** (Backed) | 8 | metadataPointer, tokenMetadata, **permanentDelegate**, defaultAccountState=initialized, scaledUiAmountConfig, **pausableConfig**, confidentialTransferMint, transferHook (no program) | freeze + pause `JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs`, delegate `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` | `https://api.xstocks.fi/api/v2/public/assets` (`deployments[]`) |
| **Ondo Global Markets** | 9 | same, **no permanent delegate** | freeze `51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK`, pause `9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD` | address CSV linked from https://docs.ondo.finance/addresses.md |
| **Backpack Securities** | 6 | same as xStocks | one key holds freeze, pause and delegate: `2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a` | `https://api.backpack.exchange/api/v1/assets` (`.US` assets with a Solana mint) |
| PreStocks (pre-IPO exposure, e.g. ANTHROPIC, OPENAI) | 9 | permanentDelegate, pausable, freeze, **transferFeeConfig 100 bps** | — | **None found** (DexScreener only). Not registered |

What all three registered issuers share:
- **No allowlist.** `defaultAccountState` is `initialized`, so any wallet can receive and sell.
- **Issuer controls.** The issuer can freeze an account, pause all transfers, and (xStocks and Backpack) move or burn tokens through the permanent delegate.
- **Transfer hook.** The extension is present with no program set. A hook could be enabled later, and TokenSafety then blocks.

**Corporate actions.** These use `scaledUiAmountConfig`. Raw balances never change, and one token equals `multiplier` shares; for example AAPLx is 1.00327 and SPYx 1.00573 after dividends. The new multiplier takes effect at 00:30 UTC the day after the ex-date (https://docs.xstocks.fi/docs/dividends-and-stock-splits). The engine trades raw units, which is correct. A per-**share** price needs the multiplier, and this is not built yet.

**Eligibility.** No issuer offers these tokens to US persons. Other exclusions:
- xStocks: also the UK (except professional clients) and sanctioned persons.
- Ondo: non-US only.
- Backpack: holder rules are not documented.

On chain nothing enforces this, so it is the **operator's** job (KYC/geo). The engine does not know who a user is.

### Tokens and status (read-only mainnet simulation, 0.05 SOL buy, `packages/live/src/xstocksread.ts`)

"Tradable here now" means all of the following:
- the mint matches the issuer list and our pinned keys;
- TokenSafety returns `warn`, not `block`;
- Jupiter has a buy route and a sell route;
- the full build path (Jupiter `/build` → our compile → gate → simulation and balance check) succeeds against mainnet state.

The simulation uses a large public wallet as fee payer. Nothing is signed or sent.

| Issuer | Tickers | Tradable now |
|---|---|---|
| xStocks | TSLAx, AAPLx, NVDAx, SPYx, QQQx, MSTRx, COINx, GOOGLx, METAx, CRCLx, HOODx | **yes**, all 11 |
| Backpack | TSLA, NVDA, SPY, QQQ, MSTR, SPCX, AAPL, GOOGL, META, HOOD | **yes** |
| Backpack | COIN, CRCL | **no**: Jupiter has no route (no pools) |
| Ondo | TSLAon, NVDAon, SPYon, QQQon, AAPLon, MSTRon, COINon, GOOGLon, METAon, CRCLon | **yes, technically, but see the price warning** |
| Ondo | HOODon | **no**: Jupiter has no route |

This table is the original hand check of 34 mints. The full set now comes from the generated registry (see "The Solana registry" below). Mints are in `packages/sol/src/stocklist.generated.ts`, and the issuer keys are in `packages/sol/src/xstocks.ts`. The latest run's report is in `docs/live-verification/*-xstocks-sol.md`.

**Price warning (Ondo on Solana).** Ondo has almost no AMM liquidity on Solana; Jupiter routes it partly through the Manifest order book. For the same 0.05 SOL, the routes returned:
- TSLAon: about **3×** fewer shares than TSLAx or Backpack TSLA;
- CRCLon: about 2.4× fewer;
- NVDAon: about 1.5× fewer;
- AAPLon: about 8% fewer.

Jupiter still reported about 0 bps price impact, so the 1-SOL impact check does not catch it. **The server now refuses such fills** (see "Stock features on the server" below). The 2026-11-18 run compared each route's price per share against the share price, for a 0.05 SOL buy:
- **Refused:** 8 of 10 routable Ondo tokens: TSLAon +210%, NVDAon +52%, QQQon +73%, AAPLon +8.6%, MSTRon +290%, COINon +290%, METAon +230%, CRCLon +136%.
- **Passed:** SPYon (+0.5%), GOOGLon (−0.3%), all 11 xStocks and all 10 routable Backpack tokens (each within ±0.5%).

"Accessible through Jupiter" is not the same as "a fair price on Jupiter".

Liquidity seen (DexScreener, all 11 xStocks):
- Raydium CLMM: about $22.5M across 85 pools.
- Orca Whirlpool: about $1.7M.
- Meteora DLMM: about $0.6M.
- Backpack tokens: $0.2M–$2.6M per ticker (Whirlpool, Raydium CLMM, DLMM).

### What changed in the code

- **`packages/sol/src/jupiterswap.ts`** (the gate). An associated token account may now use the Token-2022 program, but only for a mint the chain confirms is owned by Token-2022. Before, every Token-2022 account was refused, which made every tokenized stock untradable. The account must still be created by and for our wallet, at the address derived with that program. A Token-2022 account for an unconfirmed mint is still refused. Routes can pass through other Token-2022 tokens (HOODx did, through Backpack HOOD), and these are allowed under the same rule.
- **`packages/sol/src/solchain.ts`** (`buildJupiter`):
  - The token program of each mint is read on chain and cached. The input and output account addresses are derived with that program.
  - "Our other token accounts that the route writes" now also recognises Token-2022 accounts, which carry extension data past byte 165.
  - Rent for every token account the swap creates is priced at its **simulated size**. An xStock account is larger than 165 bytes, and without this the SOL-spend check refused buys.
- **`packages/sol/src/tx.ts`**: `PROGRAMS.token2022`, and `ataAddress(owner, mint, tokenProgram?)`.
- **`packages/sol/src/tokensafety.ts`**. An `issuedAssets` option, defaulting to `STOCKS_SOLANA`. For a registered mint whose freeze authority, pause authority and permanent delegate (or its absence, for Ondo) **exactly equal the pinned keys**, these controls are reported as `issuer_freeze`, `issuer_pause` and `issuer_delegate` **warnings**. The check is not weakened in any other way:
  - an unregistered lookalike is still blocked;
  - changed keys, or a delegate appearing, give `issuer_keys_changed:block`;
  - `paused: true` gives `paused:block`;
  - a transfer hook with a program, no sell route and transfer fees are checked as before.

  `facts.issuedAsset` names the issuer when the allowance applies. Pass `issuedAssets: []` to turn it off.
- **`packages/sol/src/xstocks.ts`**: the issuers' pinned keys, and the registry, loaded from the generated `stocklist.generated.ts`, with `stockByMint` and `stockBySymbol`. A symbol that several issuers share resolves to the tradable, most liquid one.
- **`packages/live/src/xstocksread.ts`**: the read-only mainnet check above. It uses `GuardedRpc`, which refuses every state-changing method.
- **Tests:**
  - `packages/sol/test/jupiterswap.test.ts`: gate cases for Token-2022, and a chain-level Token-2022 buy with sized rent.
  - `packages/sol/test/tokensafety.test.ts`: the allowance, and every way it must still block.

The memecoin feature set (buy and sell, limit, take-profit, stop-loss, trailing and bracket orders, TWAP, bulk trades, alerts, copy trading, positions, fee sharing, Jito) works through the same `prepare(mint)` → Jupiter venue path. It applies to these mints unchanged. Only the buy build and simulation was verified end to end here. Launch sniping and pump.fun do not apply to stocks.

---

## BNB Chain (56)

| Issuer | Tokens | Decimals / standard | Restrictions | DEX liquidity |
|---|---|---|---|---|
| **bStocks** (BTech, Binance-affiliated) | NVDAB `0x02fca66c…7436`, TSLAB `0x5b1910ea…92f`, CRCLB `0x80f3d493…ffc0`, MUB `0xcdf2f3e0…2699`, SNDKB `0x3ee4df61…50fb` (from Trust Wallet's announcement; Binance publishes no address list). QQQB, SPYB, SPCXB, MSTRB and BNCB share the same beacon but are **not on any official list** | 18, BEP-20 with Scaled UI (BEP-677), beacon proxy | not for US/UK/EU persons (app layer); a simulated transfer to a fresh address succeeded, so transfers are permissionless | PancakeSwap **V3** vs USDT: NVDAB $2.26M, TSLAB $1.31M, CRCLB $0.59M. **V2**: TSLAB/WBNB `0x162d6434…6491` about $52k; QQQB/WBNB about $59k |
| **Ondo** | TSLAon `0x2494b603…9d93` and 10 more (official CSV) | 18 ERC-20 proxy | KYC on mint/redeem only, non-US, blocklist | under $5k on DEXes; the real route is Ondo's GMTokenManager mint/redeem |
| **xStocks** | same address as on every EVM chain, e.g. TSLAx `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0` | **18** on EVM | as on Solana | dust: we read every PancakeSwap V2 pair on chain, and the largest holds about $5 of USDT |

**Tradable here now: no.** The only V2 pools with real money are TSLAB and QQQB against WBNB, at about $50k each. The same tokens have $0.8M–$1.3M on V3, so a V2-only fill would be much worse than the market. Wiring them would offer users a poor price, so they are deliberately not wired. The repo also has no BNB trader preset.

## Base (8453)

**base.org/stocks is Coinbase Tokenized Stocks** (Reg S, outside the US only).

| Ticker | Address | Best venue |
|---|---|---|
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` | Aerodrome Slipstream (CL) vs USDC, $1.82M |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` | Aerodrome CL, $1.83M |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` | Aerodrome CL, $1.56M |
| SNDKc | `0xb200000000000000000000397293Cb8cda9a10c5` | Aerodrome CL, $1.58M |
| SPCXc | `0xb2000000000000000000007b9fcbd005511aCBd5` | Aerodrome CL, $1.0M |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` | Aerodrome CL, $756k |
| MSTRc | `0xb2000000000000000000004884b426556b92883d` | Aerodrome CL, $584k (USDC), $395k (cbBTC) |
| TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` | Aerodrome CL, $438k |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` | Aerodrome CL, $389k |
| MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` | Aerodrome CL, $363k |

The tokens are **B20 precompiles**, a Base-native token standard: `eth_getCode` returns `0xef`. They behave like ERC-20 with 8 decimals.
- B20 tokens point at a PolicyRegistry precompile, which can hold allowlist or blocklist policies. The issuer also has freeze, seize and pause.
- A simulated transfer to a fresh address succeeded, so there is **no receiver allowlist today**.
- Base has no Coinbase token for QQQ, SPY, COIN, CRCL or HOOD.
- A "CRCLc" at `0x5e6C…4D72` is not Coinbase's.
- xStocks and Ondo are not on Base.
- Dinari dShares are reported on Base but are KYC-gated, and no addresses were found.

**Tradable here now: yes, through Relay** (2026-11-18). There is no V2 pool, so `createBaseTrader` gives such a token Relay venues instead (next section). All 10 base.org tokens passed a read-only simulated 0.002 ETH buy through the real chain code (`npm run verify:base-relay`, report `docs/live-verification/2026-11-18T12-31-56-037Z-base-relay.md`).

### Base through Relay (`packages/evm/src/relay.ts`, `aggregator.ts`, `EvmRpcChain` `relay` option)

What a same-chain Relay swap is, decoded from live quotes:
- **Buy with ETH:** one call to Relay's router `multicall(calls[], refundTo, nftRecipient, metadata)`, sending the input as ETH value.
- **Sell a token:** `approve(approval proxy, exact amount)`, then the approval proxy's `transferAndMulticall(tokens[], amounts[], calls[], …)`, which pulls exactly that amount.
- **Inside either:**
  1. Relay's fee: `cleanupNative` to its solver, about 0.000003 ETH per 0.002 ETH, scaling with size.
  2. One inner swap that pays the router and carries the on-chain minimum, equal to Relay's quoted `minimumAmount`.
  3. `cleanupErc20s` or `cleanupNative`, forwarding the output to the user.

The gate (`gateRelay`) refuses anything else:
- **Contracts:** only the pinned contracts, from Relay's `GET /chains` for Base, v3.2: router `0x0729e2a4716d9f7dd17858d5d504426d228697f7` and approval proxy `0x5567954cd026cebfe486062cb75848e0f1c12e58`.
- **Amounts:** an exact approve, and exactly the input.
- **Recipients:** refunds only to the wallet, every forward to the wallet, and fees only to Relay's solver, capped (default 1% of the ETH side, at least 0.0001 ETH).
- **The inner swap:** exactly one, of our pair, through a reviewed contract whose on-chain minimum we decode and require to be at least ours (minus the fee, when it comes out of the output):
  - **KyberSwap:** `swap`, `minReturnAmount`.
  - **0x:** AllowanceHolder `exec` into a Settler, `minAmountOut`. The Settler must be the current `ownerOf(2)` in 0x's on-chain Deployer registry, checked before signing.
  - **IceCreamSwap's `AggregatorGuard`:** verified source on Sourcify. It measures the recipient's balance change and reverts below `minAmountOut`.
  - **Unreviewed contracts are refused** (fail closed): an unverified `0x2f68…acff7`, and a spender `0xd374…445c` seen on one sell.

  In 21 sampled quotes, about 1 in 10 hit an unreviewed contract. The read-only check asks again when that happens.
- **Then the simulation:** `eth_simulateV1` with transfer tracing, run against Base's own node, checks the wallet's real balance changes: at least the minimum received, at most the input spent, and no other token leaving the wallet. It includes the approve when the allowance is still short.

An anvil fork cannot run Coinbase's tokens (they are B20 precompiles; `symbol()` fails with `OpcodeNotFound`), so these checks run read-only against a real Base node.

How it plugs in:
- **Base trader:** `createBaseTrader` adds Relay venues for a token with no V2 WETH pool, or with a thin one (under 1 WETH, `THIN_V2_WETH`; many tokens keep a dust V2 pair, e.g. ZORA with about 0.003 WETH). The router then takes the better quote. Tokens with a real V2 pool are unchanged, which keeps Relay API use low. Pass `relay: false` to turn it off.
- **Stock features (2026-11-18):** ticker lookup (`NVDAc` or `NVDA`), the `STOCKS_ENABLED` switch for buys, and the 3% share-price check, as on Solana (SDK_AND_API.md, Base section).
- **Server:** `MODE=base-mainnet` passes `RELAY_API_KEY` when it is set, and `BASE_RELAY=off` turns Relay off. `BASE_AGGREGATOR=kyberswap` uses KyberSwap instead (`packages/evm/src/kyber.ts`, its own gate on the router call); for a 0.5 ETH TSLAc buy on 2026-11-18 KyberSwap quoted 16 bps more than Relay (RFQ Desk, Base tab).
- **Outages:** if Relay is rate limited (HTTP 429), returns a 5xx error or can't be reached, or the node fails a simulation for a transient reason, the trade waits and is retried. A real refusal still fails it: no route, an unreviewed contract, a minimum too low, or a node without `eth_simulateV1`.
- **Fork check:** `npm run verify:server-base` passed 15 of 15 (report `docs/live-verification/2026-11-18T12-49-37-045Z-server-base.md`). Two checks are new:
  - **B14:** a 0.002 ETH ZORA buy goes through Relay's router, from the real server code with the Privy stand-in applying the README's Relay rules (`relay-buys`, `relay-sells`, `approve-relay`).
  - **B15:** the full sell goes through Relay's approval proxy, with an exact approve.

  Relay quotes live mainnet state while the fork is frozen, so a route can revert on the fork. The check then asks again, up to three times.
- **Receipts:** a Relay sell's ETH arrives as an internal transfer, which leaves no log. So the receipt reads the wallet's balance change across that block. That is exact when it was the wallet's only transaction in the block; otherwise the receipt is not booked yet and is retried.

Before real use:
- **Privy policy:** the Base policy must allow Relay's router and approval proxy, and `approve` to the proxy (README → Base policy rules: `relay-buys`, `relay-sells`, `approve-relay`). The live `memedesk-base` policy has these rules since 2026-11-18, added by the main session with the user's OK; without them Privy refuses Relay trades, which is safe.
- **API key:** pass a Relay API key (`relay: { apiKey }`). Relay's docs require one for `/quote/v2` since 2 October 2026. Keyless calls still answered on 2026-11-18 but hit HTTP 429 under load.
- **Not built:** fee sharing (refused on Relay routes), cross-chain Relay requests (deposits), and the Solana stock features (share price check, per-share amounts, registry) for Base stocks.

## Robinhood Chain (4663)

| | |
|---|---|
| RPC / explorer | `https://rpc.mainnet.chain.robinhood.com`, `robinhoodchain.blockscout.com` (https://docs.robinhood.com/chain/connecting/) |
| Tokens | 203 Robinhood stock tokens, ERC-20 with 18 decimals, issued by Robinhood Assets (Jersey) Ltd; list at `https://api.robinhood.com/rhj/assets` |
| Examples | TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`, AAPL `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`, NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, SPY `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` |
| Restrictions | not for US persons, Canada, the UK or Switzerland. Docs: "can be transferred and held in any wallet"; no on-chain allowlist is documented, and a simulated transfer to a fresh address succeeded. Corporate actions use `uiMultiplier()` (ERC-8056) |
| Ondo | 15 bridged tokens (official CSV), e.g. TSLAon `0xb197f36c…4309`; only about $45–51k V4 pools against the matching Robinhood token |
| Venues | Uniswap V3: NVDA/USDG $1.9M, CRCL/USDG $2.2M, TSLA/USDG $448k. Uniswap V4: SPY/USDG $2.4M, MSTR/USDG $1.4M. Metric prop AMM. Uniswap V2 (factory `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`) max about $4.9k |

**Tradable here now: no.** V2 holds dust; the liquidity is on V3/V4. The `.env` RPC for this chain is the testnet, and nothing here was tested on mainnet.

---

## Aggregators (EVM)

| Aggregator | Chains | Stock quote today | Executes through |
|---|---|---|---|
| Jupiter | Solana | yes (all registered tokens above) | raw instructions, already gated by us |
| LI.FI (`li.quest`, keyless) | BNB, Base, Robinhood, Solana | yes on all three EVM chains | LiFiDiamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` (Base/BNB), `0xB477751B76CF82d00a686A1232f5fCD772414Af3` (Robinhood) |
| KyberSwap (keyless, `x-client-id`) | Base, BNB, Robinhood | yes on all three (via Metric on Robinhood) | router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` |
| Relay | BNB, Base, Robinhood | Base/BNB yes; Robinhood TSLA "UNSUPPORTED_CURRENCY" | `0x5567954cd026cebfe486062cb75848e0f1c12e58` (Base) |
| OpenOcean | Base, BNB, Robinhood | quotes returned; router address not checked | — |
| 1inch, 0x | need API keys, not tested; 1inch documents Robinhood Chain support | | |
| Rialto | Robinhood only | no public API found | |

## Other EVM chains (not done)

The Relay venue is built for Base. BNB Chain would use the same code with Relay's BNB contracts, but there is no BNB trader preset. Robinhood Chain is not reachable this way: Relay refuses its stock tokens ("Unsupported currency"). That chain would need another router, such as KyberSwap or LI.FI, which both quoted Robinhood TSLA, behind the same kind of gate.

## Stock features on the server (Solana, `apps/server/solaccount.ts`, `packages/sol/src/stocks.ts`)

| Feature | How |
|---|---|
| **Operator switch** | Buying a registered stock is refused with `stocks_disabled` (403) unless the server runs with `STOCKS_ENABLED=1` (or `solanaAccounts({ stocks: { enabled: true } })`). It is **off by default**: turn it on only behind your own eligibility (KYC/geo) checks. Selling what a wallet holds always works |
| **Ticker lookup** | `token: "TSLAx"` (or `stock: "TSLAon"`, `token: "TSLA"` for Backpack) is replaced by the mint. `GET /v1/stocks` lists the registry with the underlying ticker and issuer |
| **Per-share amounts and prices** | `perShare: true` with `shares` (becomes raw `amount`), and `priceUsd` / `tpUsd` / `slUsd` / `price` per share (multiplied by the multiplier into per-token prices). Exact decimal arithmetic; token amounts round down. The multiplier in force is read from the mint, including a scheduled `newMultiplier` once its time passes |
| **Fill-price check** | Before a buy (trade, limit buy, bulk, TWAP) or a sell with an amount, the best route's price per share is compared with the underlying share price from Jupiter's Price API (`stockData.price`). More than 3% worse gives `bad_price` (409). No share price available gives `no_reference_price` (503): it fails closed. `allowRiskyToken: true` skips it |
| **Issuer pause** | A paused registered stock has no venue, so its orders **wait** (skipped, not failed) and resume when the pause ends. The pause read is cached for 15 s. The Jupiter build refuses a paused Token-2022 mint with the reason. TokenSafety blocks buys (`paused`) |
| **Stock view** | `GET /v1/stocks/:symbol`: multiplier and any scheduled one, pause, share price, what a 1-SOL buy pays per share now and whether that passes, and the user's holding in tokens and **shares** |

Tests: `packages/sol/test/stocks.test.ts`, and `apps/server/stocks.test.ts` (offline: the RPC and Jupiter are stand-ins). The mainnet read-only run (`packages/live/src/xstocksread.ts`) now also reports the fill-price check per token.

**Not covered yet:**
- The fill-price check runs when a request is made, not when a resting order later executes. A limit order's own price bounds that fill; a stop-loss or take-profit firing into a broken route is not re-checked.
- Positions and history still report tokens and per-token prices, not shares.
- No market-hours warning.

Stock-specific gaps that remain on every chain:
- **EVM chains:** all of the Solana features above have yet to be built, starting with a venue (Robinhood stock tokens carry `uiMultiplier()` instead of a Token-2022 multiplier).
- **Solana:**
  - re-check the fill price when an automated order executes;
  - positions in shares;
  - a market-hours warning;
  - a per-app (rather than per-server) eligibility switch.
- **Registry:** re-run `npm run stocks:registry` regularly. Liquidity moves, and new tickers appear.

## The Solana registry (generated)

`npm run stocks:registry` (`packages/live/src/stockregistry.ts`, read-only) builds `packages/sol/src/stocklist.generated.ts`:

1. **Sources.** It reads each issuer's own list:
   - the xStocks issuer API (paged);
   - Ondo's address CSV;
   - Backpack's exchange API, which also lists crypto.
2. **On-chain check.** It reads every mint. A mint is kept only if it is a Token-2022 mint whose freeze authority, pause authority and permanent delegate (none, for Ondo) equal that issuer's pinned keys, with no transfer hook set. The symbol comes from the mint's own metadata, and for xStocks and Ondo it must match the issuer list.
3. **Market check.** It reads the Jupiter Price API for liquidity and the underlying share price (`stockData.price`). Every mint with a share price and at least $10k of liquidity gets a 0.05 SOL buy quote. It is marked `tradable` when that route pays at most 3% more than the share price (the server's own check).

Run of 2026-11-18:

| | xStocks | Ondo | Backpack | Total |
|---|---:|---:|---:|---:|
| Solana mints on the issuer's list | 1,516 | 484 | 1,233 (crypto included) | 3,233 |
| Verified on chain with the issuer's keys | 1,516 | 415 | 1,175 | **3,106** |
| **Tradable now** (liquid and within 3% of the share price) | 27 | 2 | 84 | **113** (100 distinct underlyings) |

What was left out:
- **Ondo: 69 mints** whose keys differ from the pinned set. These may be a second key set; they are not trusted until checked.
- **Backpack: 54** non-Token-2022 entries (crypto), 3 with other keys, and 1 invalid address (its "So1" native-SOL entry).

Most Ondo tokens have under $10k of Jupiter liquidity on Solana (TSLAon: $1), which is why so few are tradable.

**Live check of the tradable set.** `npm run verify:stocks` (read-only, report `docs/live-verification/2026-11-18T11-56-12-787Z-xstocks-sol.md`) ran all 113 tradable stocks right after the registry run. All 113 have a mint matching its issuer, safety `warn` (not `block`), a successful 0.05 SOL buy simulation through our gate, a sell route, and a fill price within 3% of the share price.

How the registry is used:
- **TokenSafety allowance:** applies to all 3,106 verified mints. It concerns issuer controls only, and holds only while the keys still match.
- **`GET /v1/stocks`:** lists the tradable set by default (`all=true` for everything; also `q=`, `issuer=`, `limit`, `offset`).
- **Trades:** every trade is still re-checked live against the share price. `tradable` is only a listing hint from the last run.

## Cross-check against an external market survey (XStocks.xlsx, 2026-11-18)

The user supplied a survey: GeckoTerminal pools and Jupiter quotes for 1,123 screened US tickers and 9,448 contract candidates.
- **Solana: the registry covers every liquid market in it.** All 57 of the survey's Solana markets with at least $100k of pool TVL are in our registry, and 56 of them are marked tradable. The exception is Backpack INTC: $165k in pools per GeckoTerminal, but only $1.7k per Jupiter's liquidity figure, so our $10k floor left it out. Our 113 tradable stocks also include 56 that the survey did not screen (for example SPYx, QQQx, Backpack SPY and QQQ).
- **Large orders.** In the survey's $100,000 USDC Jupiter quotes (`/swap/v2/order`), 38 of 56 Solana stocks were filled by **JupiterZ (RFQ market makers)**, within 0.5% of the $100 price.

  Our execution path, `/swap/v2/build` raw instructions, does not reach RFQ. Our gate also refuses any signer other than the user's wallet, and an RFQ fill is co-signed by the market maker. A $100k-sized `/build` for AAPLx (read-only) routed through ZeroFi, Kipseli and Raydium CLMM instead. It returned about 2% fewer shares than the survey's RFQ quote, but the input token and time differ, so that is indicative only.

  For large stock orders, RFQ support would need its own gate design: the market maker's signature is expected, while the user's balances and the output are still checked.
- **Base.** The survey finds **20** Coinbase stock tokens on Base (base.org listed 10 when we checked). About $15.4M of pool TVL, of which:
  - Aerodrome Slipstream (concentrated liquidity): $12.4M;
  - Uniswap V4: $1.8M;
  - Uniswap V3: $0.3M;
  - small amounts on Bankr and o1 Launchpad.

  The largest pools are NVDAc $2.3M, AMZNc $1.9M, GOOGLc $1.9M, MSTRc $1.1M and METAc $0.9M, all Aerodrome. There is still no V2 pool of any size, which confirms that Base needs a concentrated-liquidity or aggregator venue.
- **Ethereum (not one of our chains):** Ondo has $10.3M, mostly TSLAon on a V3 pool ($8.2M).

## How many exist (counts, 2026-11-18)

| Issuer | Assets listed by the issuer | On our four chains | In our Solana registry (verified / tradable) |
|---|---|---|---|
| xStocks (Backed) | 1,516 (issuer API) | Solana and BNB: all 1,516; Base: none | 1,516 / 27 |
| Ondo Global Markets | 484 (official CSV) | Solana and BNB: 484; Robinhood Chain: 15 | 415 / 2 |
| Robinhood | 203 (`api.robinhood.com/rhj/assets`) | Robinhood Chain: 203 | — (EVM) |
| Backpack Securities | 1,175 Solana mints carry Backpack's issuer keys on chain. Glassnode (94) and tokenstock.info count far fewer, likely only listed or marketed products | Solana | 1,175 / 84 |
| Securitize, Superstate | 49 and 3 on Solana (tokenstock.info, a third-party registry, 2026-11-17); allowlist/KYC-gated, not researched | Solana | — |
| Coinbase | 10 on base.org/stocks (Glassnode lists 377 "Tokenized Equities" products; not reconciled) | Base | — (EVM) |
| bStocks | 5 on an official list (Glassnode: 105) | BNB | — (EVM) |

The Glassnode tokenization registry (https://tokenization.glassnode.com/issuers) also lists issuers we have **not researched**: Reality (Bitget) with 3,154 products, Dinari with 151, Anchored (aStocks) with 66, Securitize Stocks with 15 and WisdomTree with 15. Their chains, addresses and transfer rules are unknown here.

## Not confirmed from an official source
- The addresses for bStocks QQQB, SPYB, SPCXB, MSTRB and BNCB.
- PreStocks mints.
- Dinari, Superstate and Securitize on these chains.
- How Coinbase enforces eligibility beyond its Reg S statement.
- Admin powers on the EVM xStocks contracts.
- Holder eligibility for Backpack tokens.
