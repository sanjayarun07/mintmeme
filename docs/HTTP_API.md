# HTTP API: integration guide

This is the guide for **third parties integrating the trading API**: apps, bots, wallets and back ends that place trades for their users. It covers authentication, the conventions every call follows, linking a user's wallet, trading, orders, events and webhooks, errors and limits, and a reference of every route.

- Machine-readable spec: `GET /v1/openapi.json` on any server (OpenAPI 3.0.3, no key needed).
- TypeScript client: `MemeClient` in `packages/sdk` mirrors every route here ([SDK_AND_API.md](SDK_AND_API.md)).
- The response examples below were captured from a running server (the practice server), not written by hand.

---

## 1. Environments

The same API runs in practice mode or on real chains. Your operator tells you which a URL serves; `GET /v1/chains` (no key) lists them.

| Mode | What trades | Amounts in requests | Wallets |
|---|---|---|---|
| `practice` | A simulated chain with fake funds | Raw base units (strings of digits) | Two practice wallets per user: `w1`, `w2`; token `0xMEME` |
| `solana-mainnet` | **Real funds** on Solana: Jupiter routes, pump.fun, tokenized stocks | **Plain units** (`"sol": "0.01"`) or raw units | The user's own Privy wallet, linked once (section 5) |
| `base-mainnet` | **Real funds** on Base: Uniswap V2 and Relay | **Plain units** (`"eth": "0.001"`) or raw units | The user's own Privy Ethereum wallet, linked once |
| `bnb` (in `CHAINS`) | **Real funds** on BNB Chain: PancakeSwap V2 | **Plain units** (`"bnb": "0.01"`) or raw units | The user's Privy Ethereum wallet, linked for BNB |
| `robinhood` (in `CHAINS`) | **Real funds** on Robinhood Chain: Uniswap V2 | **Plain units** (`"eth": "0.001"`) or raw units | The user's Privy Ethereum wallet, linked for Robinhood |

### One server, several chains

A server can run several chains at once (`CHAINS=solana,base,bnb,robinhood`). Then **the path names the chain**: put `/<chain>` after `/v1`.

```bash
curl -s $BASE/v1/chains                                                     # {"default":"solana","chains":[{"id":"solana","kind":"solana","native":"SOL","amountKey":"sol","prefix":"/v1/solana/",...},...]}
curl -s -H "Authorization: Bearer $KEY" $BASE/v1/base/overview              # your Base account
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: bnb-001' \
  -d '{"token":"0x55d398326f99059ff775485246999027b3197955","bnb":"0.01","slippagePct":3}' $BASE/v1/bnb/trades/buy
```

- A path **without** a chain goes to the server's **default chain** (the first one listed). Existing integrations keep working unchanged.
- Your API key and rate limit are the same on every chain. Each chain is a separate account: its own wallet link (section 5, under `/v1/<chain>/wallet/...`),
  orders, trades, positions, settings and event stream (`/v1/<chain>/events`). An order id or trade key on one chain is not visible on another.
- App routes (`/v1/app/*`) have no chain. A chain the server does not run answers `404 chain_not_enabled`. A chain that is down for your account answers
  `503 chain_unavailable` (retry after the `retry-after` seconds); your other chains are not affected.
- Webhook events carry `"chain"` when the server runs several.

The base URL is whatever the operator gives you, for example `https://api.example.com`. All paths start with `/v1`. The server speaks plain HTTP behind a TLS load balancer; always call it over HTTPS.

Two calls need no key:
- `GET /v1/health` answers `{"ok":true}`.
- `GET /v1/openapi.json` returns the spec.

The cluster also serves a public status page at `/status` and `/status.json` (components, nodes, trades in the last hour).

---

## 2. Quick start

```bash
KEY="your-api-key"; BASE="https://api.example.com"

# 1. Who am I, and what is running?
curl -s -H "Authorization: Bearer $KEY" $BASE/v1/overview

# 2. A price, nothing sent (practice: raw units)
curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -X POST $BASE/v1/quote -d '{"side":"buy","token":"0xMEME","amount":"100000","slippageBps":300}'

# 3. A market buy. The Idempotency-Key makes a retry safe: the same key never trades twice
curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" -H "Idempotency-Key: buy-001" \
  -X POST $BASE/v1/trades/buy -d '{"walletId":"w1","token":"0xMEME","amount":"100000","slippageBps":300}'
```

The buy answers with the trade record (practice server, real output):

```json
{"key":"alice.buy-001","state":"finalized","walletId":"w1","origin":"manual","tokenIn":"NATIVE","tokenOut":"0xMEME","amountIn":"100000",
 "fill":{"spent":"100000","received":"89835","platformFee":"1000","venueFee":"297","networkFee":"1000","quotedOut":"89835","shortfall":"0"},
 "venue":"uni-v2:MEME","txHash":"0x798c4818…7842",
 "history":[{"state":"created"},{"state":"validated"},{"state":"quoted","note":"uni-v2:MEME block 220"},{"state":"simulated","note":"block 220"},
            {"state":"awaiting_authorization"},{"state":"signed","note":"nonce 0"},{"state":"submitted"},{"state":"observed","note":"in mempool"},
            {"state":"confirmed","note":"block 221"},{"state":"finalized"}]}
```

On a real-funds server the same buy is written in plain units, and the user's linked wallet is used automatically:

```bash
# Solana (MODE=solana-mainnet): 0.01 SOL of a token, 3% slippage
curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" -H "Idempotency-Key: buy-002" \
  -X POST $BASE/v1/trades/buy -d '{"mint":"<token mint>","sol":"0.01","slippagePct":3}'

# Base (MODE=base-mainnet): 0.001 ETH of a token
curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" -H "Idempotency-Key: buy-003" \
  -X POST $BASE/v1/trades/buy -d '{"token":"0x…","eth":"0.001","slippagePct":3}'
```

---

## 3. Authentication

Every call except `/v1/health` and `/v1/openapi.json` sends a key:

```
Authorization: Bearer <api key>
```

Keys are 16 to 200 characters. The server stores only their SHA-256 hashes, and compares them in constant time. The operator issues them; there is no self-service key API. A missing or unknown key answers `401 unauthorized` with `WWW-Authenticate: Bearer`.

| Scope | Can do |
|---|---|
| `read` | Every `GET`, and `POST /v1/quote`. A trading call answers `403 read_only_key`. |
| `trade` | Everything for **one** account: the key's user. |
| `app` | One key for an **app with many end users**. Each request names the end user (below). |

### Sign in with Privy (sessions instead of an API key)

On a server with `PRIVY_USERS` set, a person can sign in with their Privy login instead of holding an API key. The trading app (`/app`) does this; any client can.

```
POST /v1/auth/privy          { "token": "<Privy access token>" }      no key needed
→ 200 { "session": "mts_…", "userId": "arun", "expiresAt": "2026-11-20T07:41:00.000Z" }
```

Then send the session like a key: `Authorization: Bearer mts_…`. It acts for that account with `trade` scope, on every chain (`/v1/<chain>/…`), until it expires
(`PRIVY_SESSION_HOURS`, 12 by default) or `DELETE /v1/auth/session` ends it. Paths under `/v1/auth/` take no chain prefix.

What the server checks, all required: an ES256 signature by one of Privy's published keys for this Privy app (or `PRIVY_VERIFICATION_KEY`), issuer `privy.io`,
audience `PRIVY_APP_ID`, not expired, and a `did:privy:…` subject that `PRIVY_USERS` maps to an account (`did:privy:<id>=<account>,…`). A valid Privy login that is not
mapped is refused, so other people who log in to the same Privy app cannot trade. Sessions are stored in Redis only as SHA-256 hashes; sign-in is limited to 10 tries a
minute per address and refused while Redis is unreachable.

| Error | Status | Meaning |
|---|---|---|
| `bad_token`, `bad_signature`, `wrong_app` | 401 | Not a Privy login token for this app, or not signed by Privy. |
| `expired` | 401 | The Privy login expired: get a fresh token from Privy (`getAccessToken()`). |
| `not_mapped` | 403 | Valid login, but no account for that Privy user. The message names the `did:privy:…` to add to `PRIVY_USERS`. |
| `not_configured` | 404 | This server has no `PRIVY_USERS`: use an API key. |

TypeScript: `const { client } = await MemeClient.signInWithPrivy({ baseUrl, privyToken, chain? })`, and `client.signOut()`.

### App keys: one key, many end users

With an `app` key, every account call names the end user it acts for:

```
Authorization: Bearer <app key>
X-User-Id: user-42
```

- **The `X-User-Id` value:** 1 to 64 characters from letters, digits, `.`, `-` and `_`. Without it the call answers `400 missing_user`.
- **Separate accounts:** each end user is a separate account (`<app>:<user>` on the server), with its own wallet, orders, settings and rate limit. One end user can never see another's data.
- **Creation:** end users are created on their first call, up to the operator's `MAX_USERS_PER_APP` (`403 app_user_limit` beyond it).
- **App routes:** `/v1/app/*` routes act for the app itself and take no `X-User-Id`. They cover the app's webhook, its fee, its end-user list, and the records of all its users. A user key there answers `403 not_an_app_key`.

---

## 4. Conventions

### JSON and numbers
- **Format:** requests and responses are JSON (`content-type: application/json`). A request body may be at most 256 KB (`413 too_large`).
- **Raw units:** amounts and prices in **raw base units** are **strings of digits**, never JSON numbers, because they can exceed 2^53. Lamports on Solana, wei on Base, a token's smallest unit. Example: `"amount": "1000000000"` is 1 SOL. Decimals, exponents and negatives are refused with a `fix` that shows what to send.
- **Prices:** `priceE18` is quote units per raw token unit × 10^18.
- **Plain units (real-funds servers only):** you may send human units instead. Raw fields, when present, win.

| Plain field | Meaning | Raw equivalent |
|---|---|---|
| `mint` (Solana) or `token` | The token. On Solana a stock ticker such as `"TSLAx"` also works (section 9). | `token` |
| `sol` / `eth` | Native coin to spend, e.g. `"0.01"` | `amount` in lamports / wei |
| `tokens` | Tokens to sell, e.g. `"1500.5"` (the server reads the token's decimals) | `amount` |
| `pct` | Percent of the holding to sell, e.g. `50` | `pctBps` (5000) |
| `price` | Native coin per token | `priceE18` |
| `priceUsd`, `tpUsd`, `slUsd` | USD per token for triggers | `priceUsd`, `takeProfitUsd`, `stopLossUsd` |
| `slippagePct`, `trailPct` | Percent | `slippageBps`, `trailBps` |

`walletId` defaults to the linked wallet on a real-funds server, so most calls can leave it out.

### Ids and idempotency
- **Trade keys:** a trade's key comes from the `Idempotency-Key` header (or `key` in the body). Send the same key again and you get the **same trade back, never a second trade**, even if the first request timed out and you could not tell whether it went through. Use one key per intended trade, for example your order id.
- **Prefixed ids:** keys and ids are prefixed with your account in responses (`buy-001` becomes `alice.buy-001`, and an order `id` of `dip-1` becomes `alice.dip-1`). **Use the id exactly as returned** in later calls such as `GET /v1/trades/:key` or `DELETE /v1/orders/:id`. An id that is not yours answers `404 not_found`.
- **Generated ids:** orders, bulk and TWAP jobs take an optional `id`; without one, the server generates one and returns it.

### Trade states

A trade moves through `created → validated → quoted → simulated → awaiting_authorization → signed → submitted → observed → confirmed → finalized`. It can end instead as:
- `failed`: refused, or reverted. `failure` says why, and nothing was sent unless `history` shows `submitted`.
- `expired`: the deadline passed before it landed.
- `unresolved`: it's being reconciled, for example after a lost acknowledgement.

The **fill** (`spent`, `received`, fees) is measured from the chain's receipt, not from the quote.

A trade that is still moving answers with its current state. Poll `GET /v1/trades/:key`, or push it one step with `POST /v1/trades/:key/advance` (safe to repeat), or listen on `/v1/events` (section 10). On real chains a buy usually reaches `finalized` within a minute.

### Which node answers
A cluster has several nodes. Any node accepts any request and forwards it to the node that runs the account; the answer carries `x-memedesk-node`. During a failover you may briefly get a `503` (`owner_unreachable`, `routing_loop`, `no_capacity`, `draining` or `not_owner`). These are safe to retry after a second.

---

## 5. Linking a user's wallet (real-funds servers)

On `solana-mainnet`, `base-mainnet` and every real chain of a multi-chain server the server never holds the user's key. On a multi-chain server each chain is linked on its own, under its prefix: `/v1/base/wallet/link/start`, `/v1/bnb/wallet/link/start` and so on (one Privy Ethereum wallet can be linked on every EVM chain; each is checked against that chain's policy). The user keeps their own Privy wallet and grants the server permission to sign trades **inside a policy** (allowed programs or contracts, a cap per trade). Until a wallet is linked, reads work and every trade answers `409 wallet_not_active` with the reason.

Steps, done once per user:

1. **In your front end, with the Privy SDK,** add the server's signer to the user's wallet with the operator's policy. The operator gives you `signerId` and `policyId`. Use the Solana policy for Solana, and the Base policy for Base.
   ```js
   const { addSigners } = useSigners();                       // @privy-io/react-auth
   await addSigners({ address: wallet.address, signers: [{ signerId, policyIds: [policyId] }] });
   ```
2. **Ask for a one-time message.** It expires after 5 minutes.
   ```bash
   curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
     -X POST $BASE/v1/wallet/link/start -d '{"address":"<wallet address>"}'
   # {"message":"memedesk: link this wallet to account …\n\nAddress: …\nNonce: …\nIssued: …\n\nSigning this moves no funds."}
   ```
3. **Have the wallet sign that exact message, and send the signature.**
   - **Solana:** an ed25519 signature, **base64**, from Privy's `signMessage`.
   - **Base:** a `personal_sign` signature, **0x hex** (65 bytes).
   ```bash
   curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
     -X POST $BASE/v1/wallet/link/finish -d '{"address":"<wallet address>","signature":"<signature>"}'
   # {"linked":true,"address":"…","active":true,"why":null}
   ```
   The server checks the signature, which proves the user controls the wallet. It then asks Privy whether the signer and policy are on the wallet, and only then saves the link.

`GET /v1/wallet` shows the link and whether the server may trade it now. `DELETE /v1/wallet` unlinks it. If the user removes the signer in Privy, signing stops at once: Privy refuses, nothing is sent, and the next trade fails with the reason.

| Error | Meaning |
|---|---|
| `401 bad_signature` | The signature does not match this address and message |
| `409 not_delegated` | The wallet does not carry the server's signer with the right policy yet (the message says which part is missing) |
| `410 link_expired` | No link in progress for this address, or it expired: call `/link/start` again |
| `503 privy_unavailable` | Privy could not be reached: retry shortly |

---

## 6. Trading

### Quote (nothing is sent)
`POST /v1/quote` with `side`, `token` and `amount` (and `slippageBps`) returns the best venue's output, the guaranteed minimum, price impact and fees:
```json
{"venue":"uni-v2:MEME","amountOut":"496736","minOut":"491768","priceImpactBps":4982,"platformFee":"10000","venueFee":"2970","liquidity":"1000000","alternatives":[]}
```

### Market buy and sell
- **Buy:** `POST /v1/trades/buy`. Practice: `walletId`, `token`, `amount` (the quote budget). Real funds: `mint`/`token` and `sol`/`eth`.
- **Sell:** `POST /v1/trades/sell`, with `amount` or `tokens`, or `pctBps`/`pct` of the holding. A practice example: `{"walletId":"w1","token":"0xMEME","pctBps":5000}`.
- **Optional on both:** `slippageBps`/`slippagePct` (up to 50%), `minOut` (a floor of your own), `deadlineS`, `maxFeeBps` (refuse a trade whose fees exceed this; default 2%), `mevProtection` (Solana: send this trade privately through Jito), `allowRiskyToken` (skip the token safety check for this one buy).

Every trade runs the same safety path: a fresh quote, a simulation, the account's per-trade and daily caps, then signing by the user's Privy wallet within its policy. If any step refuses, nothing is sent, and `failure` explains why.

### Standing orders
They watch the price and trade by themselves, without your app online:

| Route | Fires when |
|---|---|
| `POST /v1/orders/limit-buy` | The price falls to the trigger or lower |
| `POST /v1/orders/limit-sell` | The price rises to the trigger or higher |
| `POST /v1/orders/take-profit` | The price reaches a profit target |
| `POST /v1/orders/stop-loss` | The price falls to the trigger |
| `POST /v1/orders/trailing-stop` | The price falls `trailBps` from its peak since the order was placed |
| `POST /v1/orders/bracket` | Take profit and/or stop loss and/or trailing stop on one position; when one fires the others are cancelled |

- **Trigger:** `priceE18` (raw) or `priceUsd` (or `price` in native units on real-funds servers), or `marketCap`.
- **Optional:** `ttlS` (the order expires), `slippageBps`, `chase` (raise the slippage step by step up to a limit if a fill fails), `id`.
- **Answer:** the order, with `status: "active"`.
- **Managing them:**
  - `GET /v1/orders?status=active`;
  - `GET /v1/orders/:id`, which includes why it has not fired yet;
  - `PATCH /v1/orders/:id` with a new `priceE18` or `priceUsd`;
  - `DELETE /v1/orders/:id`, which cancels it and releases its reserved balance.

```json
{"id":"alice.dip-1","walletId":"w1","token":"0xMEME","kind":"limit_buy","amount":"500000","triggerPriceE18":"1","slippageBps":300,"status":"active","expiresAt":1700604809,"attempts":0}
```

### Bulk, TWAP, alerts, pause
- **Bulk:** `POST /v1/bulk/buy` and `/v1/bulk/sell` trade one token from up to 10 wallets: exact legs, an equal split, or a percentage of each balance. It isn't atomic; `GET /v1/bulk/:id` says which legs landed.
- **TWAP:** `POST /v1/twap` buys or sells `total` in 2 to 100 equal `slices`, `intervalS` apart, with an optional `limitPriceE18`. Check it with `GET /v1/twap/:id`, and stop it with `DELETE /v1/twap/:id`.
- **Alerts:** `POST /v1/alerts` with `token`, `direction` (`above` or `below`) and `threshold` delivers an `alert` event when the price crosses.
- **Pause:** `POST /v1/entries/pause` stops all new buys (manual, orders, bulk, TWAP, copy). Sells and stop losses keep working. `POST /v1/entries/resume` undoes it.

### Positions and history
- `GET /v1/positions`: balance, cost basis and realized P&L per token (an unknown cost basis stays `null`, never guessed).
- `GET /v1/history`, `GET /v1/trades?limit=&origin=&walletId=`: what was traded.

---

## 7. Settings and token safety (Solana)

`GET /v1/settings` and `PATCH /v1/settings`:

| Field | Meaning | Default |
|---|---|---|
| `mevProtection` | Send trades privately through Jito (sandwich protection) with a tip | `false` |
| `maxTipSol` | The most one Jito tip may cost (at most 0.001) | `"0.0001"` |
| `tokenSafety` | `block` refuses buys of tokens that fail the safety check; `warn` only reports; `off` | `block` |

`GET /v1/tokens/:mint/safety` returns the report:
- freeze and mint authority;
- Token-2022 extensions that can stop a sell or take tokens;
- holder concentration;
- whether a sell route exists;
- the price impact of a 1-SOL buy;
- a verdict.

A blocked buy answers `409 unsafe_token` with the reasons. Sells are never blocked.

---

## 8. Base, BNB Chain and Robinhood Chain specifics

- **BNB Chain** (`/v1/bnb/...`): PancakeSwap V2 pools against WBNB (0.25% pool fee), amounts in `bnb`; caps by default 0.02 BNB per buy, 0.1 BNB per day. Quotes report the venue as `uniswap-v2` (PancakeSwap V2 is a Uniswap V2 fork).
- **Robinhood Chain** (`/v1/robinhood/...`): Uniswap V2 pools against WETH, amounts in `eth`; caps by default 0.01 ETH per buy, 0.05 ETH per day.
- On both, a token without a V2 pool against the wrapped native coin answers `no_route` (no Relay or KyberSwap there yet). The rest of this section is Base.

- **Venues:** Uniswap V2 pools against WETH, and **Relay** for tokens with no V2 pool or a thin one, such as Coinbase's tokenized stocks (NVDAc and others) and most Base memecoins. Every Relay transaction is decoded, checked and simulated before the user's wallet signs it.
- **Caps:** by default at most 0.01 ETH per buy and 0.05 ETH per day (operator setting).
- **Not on Base yet:** no token safety check, no fee sharing and no MEV setting. Base has no public mempool.
- **A token with no route** answers `no_route`.

---

## 9. Tokenized stocks (Solana)

- **The list:** `GET /v1/stocks` lists the registered stock tokens (xStocks, Ondo, Backpack), tradable first. Query `q=TSLA`, `issuer=`, `all=true`, `limit`, `offset`. It says `buyEnabled`.
- **One stock:** `GET /v1/stocks/:symbol` shows the shares per token (the multiplier), the issuer pause, the share price, what the best route pays per share now, and your holding in shares.
- **Trading by ticker:** `{"mint":"TSLAx","sol":"0.05"}` works on trades and orders.
- **Per-share prices:** `"perShare": true` makes `priceUsd`, `tpUsd`, `slUsd` and `price` per **share**. On sells, `shares` is the amount to sell in shares. Buys are sized in `sol` (`shares` on a buy is refused).
- **Price check:** every stock trade is checked against the real share price before signing. `409 bad_price` means the route was more than 3% worse; `503 no_reference_price` means the share price was unavailable. `allowRiskyToken: true` skips the check for one trade.
- **Off by default:** buying is refused with `403 stocks_disabled` unless the operator enables it. Selling what a wallet holds always works.
- **Restrictions:** no issuer offers these tokens to US persons or other restricted jurisdictions. Your app must check eligibility before letting a user buy.

---

## 10. Copy trading (Solana)

`POST /v1/copies` follows leader wallets, in plain units. The linked wallet is the follower.

```json
{"leader":"<leader address>","fixedSol":"0.01","maxPerTradeSol":"0.02","dailySol":"0.1","exitMode":"full-on-exit","slippagePct":5}
```

- **Sizing:** exactly one of `fixedSol` (the same SOL each copied buy) or `percent` (of what the leader spent).
- **Optional:** `leaders` (up to 10), `allow` / `block` (mints or stock tickers), `sides` (`both` or `buy`), `exitMode` (`full-on-exit`, `proportional`, `full-on-any-sell`, `ignore`), `cooldownS`, `maxPositions`, `minConfirmations`, `maxDeviationPct`, `maxAgeSlots`, `trackOnly` (record what would be bought, send nothing), `id`.
- **Unknown fields** are refused.
- **History:** it never copies past trades, or a leader buy that's already stale when seen.
- **Same checks as manual trades:** copied buys pass the same token safety and stock checks as manual buys, within the account's caps.
- **Durable:** configs survive restarts and failovers, and nothing is copied twice.
- **Managing them:** `GET /v1/copies` shows each config with `running`, `lastError`, `inflight`, its last decisions (what was bought, sold or skipped, and why) and `skippedByChecks`. `DELETE /v1/copies/:id` stops it; tokens already bought stay in the wallet.

---

## 11. Events and webhooks

### Server-sent events
`GET /v1/events` (with your key, or an app key plus `X-User-Id`) is a `text/event-stream` of the account's events:
- **Event types:** `trade`, `order`, `bulk`, `twap`, `snipe`, `alert` and `error`.
- **Format:** each event is one `data: {...}` line. A comment heartbeat arrives every 15 s.
- **Reconnecting:** if the account moves to another node, the stream ends; reconnect and you reach the new owner.

### Webhooks (app keys)
An app sets one HTTPS URL, and gets every event of every one of its end users:

```bash
curl -s -H "Authorization: Bearer $APP_KEY" -H "content-type: application/json" \
  -X PUT $BASE/v1/app/webhook -d '{"url":"https://your-app.example.com/hooks/trading"}'
# returns the signing secret ONCE (or pass your own "secret", 16 to 200 characters)
```

Each delivery is a `POST` with:
```
x-memedesk-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
x-memedesk-event-id:  <uuid, the same on every retry>
```
```json
{"id":"<uuid>","type":"trade","appId":"<your app>","userId":"user-42","at":"2026-11-18T12:00:00.000Z","data":{ "...": "the event" }}
```

Verify every delivery before trusting it. Check the HMAC over the **raw** body, reject a timestamp more than 5 minutes old, and deduplicate on `x-memedesk-event-id`:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header, toleranceS = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? ''); if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceS) return false;
  const want = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], 'hex'));
}
```
(`verifyWebhook` in the SDK does the same.)

**Delivery:**
- **Retries:** answer `2xx` quickly. A non-2xx answer or a timeout is retried after 2 s, 10 s and 60 s.
- **Not durable:** events still waiting when a node stops are dropped. Treat webhooks as a fast signal, and read the state through the API to reconcile.
- **Testing:** `POST /v1/app/webhook/test` sends a signed `ping` now and reports whether it was accepted.
- **Allowed URLs:** only `https` URLs to public hosts are accepted.

---

## 12. Apps: fees, users, records

- **Fees:** `PUT /v1/app/fees {"wallet":"<Solana address>","bps":40}` charges your fee on your users' Solana trades. It's paid in SOL inside each trade, up to the operator's cap (`APP_FEE_MAX_BPS`, default 100). The wallet must already hold SOL. `GET` and `DELETE` work too.
- **Users:** `GET /v1/app/users` lists your end users that have called the API (up to 1,000).
- **Records** (servers with a database): one row per trade with its fill, and every call that changed something, with secrets and signatures removed. Query `limit` (up to 500) and `before` to page back.
  - **Per account:** `GET /v1/records/trades` and `/v1/records/audit`.
  - **Your whole app:** `GET /v1/app/records/trades` and `/v1/app/records/audit`.

---

## 13. Errors

Every error has the same shape and a `fix` that says what to send instead:

```json
{"error":{"code":"bad_amount","message":"amount must be a whole number of raw base units, sent as a string of digits (got \"1.5\")",
          "fix":"Send \"amount\": \"1000000000000000000\" (1e18 raw units = 1 token with 18 decimals). Use parseUnits(\"1.5\", 18) in the SDK."}}
```

Switch on `code`, not on `message` (messages can change). Common codes:

| Status | Code | Meaning / what to do |
|---|---|---|
| 400 | `bad_request`, `bad_amount`, `bad_number`, `bad_token`, `bad_address` | The body is wrong: `fix` says how. Do not retry unchanged. |
| 400 | `missing_user` | App key without `X-User-Id` |
| 401 | `unauthorized` | Missing or unknown key |
| 401 | `bad_signature` | Wallet linking: wrong signature |
| 403 | `read_only_key`, `not_an_app_key`, `app_user_limit`, `no_account` | The key cannot do this |
| 403 | `stocks_disabled` | Stock buying is off on this server |
| 404 | `not_found` | No such route, or the id is not yours (use ids exactly as returned) |
| 405 | `method_not_allowed` | Wrong method for this path |
| 409 | `wallet_not_active`, `not_delegated` | Link the wallet, or fix the Privy signer and policy (the message says which) |
| 409 | `unsafe_token`, `bad_price` | Refused by the token safety or stock price check |
| 409 | `above_cap`, `too_many` | A copy config above the account's cap, or more than 10 configs |
| 410 | `link_expired` | Start wallet linking again |
| 413 | `too_large` | Body over 256 KB |
| 429 | `rate_limited` | Slow down. Honor `Retry-After` (seconds). |
| 501 | `not_configured` | This server does not offer that feature |
| 503 | `privy_unavailable`, `no_route`, `no_reference_price`, `not_owner`, `owner_unreachable`, `no_capacity`, `draining`, `routing_loop` | Temporary: retry after a second or two (with the same `Idempotency-Key` for trades) |
| 500 | `internal` | Retry; if it persists, report the time and route to the operator |

A trade that the engine **refuses or that fails** is not an HTTP error. You get `200` with the trade record, `state: "failed"` and `failure` explaining why. For example: above the per-trade cap, simulation reverted, or Privy refused under the policy.

---

## 14. Limits

- **Rate limit:** per key (or per end user with an app key), **per node**. Defaults are 20 requests per second with bursts to 40; the operator may change them. Over the limit: `429 rate_limited` with `Retry-After: 1`.
- **Body size:** 256 KB.
- **Per-account trading caps** (set by the operator, enforced at signing):
  - Solana: by default 0.05 SOL per buy and 0.25 SOL per day;
  - Base: 0.01 ETH per buy and 0.05 ETH per day.

  The user's Privy policy is a second, independent cap.
- **Lists:** `limit` caps vary by route (records up to 500, app users up to 1,000).

---

## 15. Route reference

Scopes: **R** = `read` or higher; **T** = `trade`; **A** = app key. Modes: all modes unless noted (**S** = `solana-mainnet`, **B** = `base-mainnet`). On a multi-chain server every route except `/v1/app/*`, `/v1/health` and `/v1/chains` also exists as `/v1/<chain>/...` (section 1).

| Method | Path | Scope | What it does |
|---|---|---|---|
| GET | `/v1/health` | none | `{"ok":true}` |
| GET | `/v1/openapi.json` | none | The OpenAPI spec (`/v1/<chain>/openapi.json`: that chain's routes) |
| GET | `/v1/chains` | none | The chains this server runs and the default. Each: `id`, `label`, `kind` (practice, solana, evm), `native` (SOL, ETH, BNB), `amountKey` (the plain-units field for that coin in a trade: `sol`, `eth`, `bnb`), `chainId` (EVM), `prefix`, `default` |
| POST | `/v1/auth/privy` | none | Sign in with a Privy access token; returns a session for the mapped account (servers with `PRIVY_USERS`) |
| DELETE | `/v1/auth/session` | session | End the session sent as the bearer |
| GET | `/v1/overview` | R | Account state: chain, block, active orders, running jobs |
| POST | `/v1/quote` | R | Best price for a market trade; nothing is sent |
| POST | `/v1/trades/buy` | T | Market buy (send `Idempotency-Key`) |
| POST | `/v1/trades/sell` | T | Market sell an amount or a percentage |
| GET | `/v1/trades` | R | Your trades, newest first (`limit`, `origin`, `walletId`) |
| GET | `/v1/trades/:key` | R | One trade: state, fill, tx hash, failure, history |
| POST | `/v1/trades/:key/advance` | T | Push a waiting trade one step; safe to repeat |
| POST | `/v1/wallets/:id/cancel-stuck` | T | Replace a stuck nonce with a no-op (EVM) |
| POST | `/v1/orders/limit-buy`, `limit-sell`, `take-profit`, `stop-loss`, `trailing-stop`, `bracket` | T | Standing orders (section 6) |
| GET | `/v1/orders`, `/v1/orders/:id` | R | List orders; one order with why it has not fired |
| PATCH | `/v1/orders/:id` | T | Move an active order's trigger |
| DELETE | `/v1/orders/:id` | T | Cancel an order |
| POST | `/v1/bulk/buy`, `/v1/bulk/sell` | T | Up to 10 wallets at once |
| GET | `/v1/bulk/:id` | R | Per-wallet status |
| POST | `/v1/twap` | T | Equal slices over time |
| GET / DELETE | `/v1/twap/:id` | R / T | Status / stop |
| POST | `/v1/alerts` | T | Price alert (delivered as an event) |
| DELETE | `/v1/alerts/:id` | T | Cancel an alert |
| GET | `/v1/positions`, `/v1/history` | R | Positions with P&L; confirmed history |
| POST | `/v1/entries/pause`, `/v1/entries/resume` | T | Pause / resume new buys |
| GET / POST | `/v1/snipes` | R / T | Launch snipers (only where the operator supplies a launch source) |
| GET / POST | `/v1/copies` | R / T | Copy trading (S; section 10) |
| DELETE | `/v1/copies/:id` | T | Stop a copy config |
| GET | `/v1/events` | R | Server-sent events |
| GET / DELETE | `/v1/wallet` | R / T | The linked wallet / unlink (S, B) |
| POST | `/v1/wallet/link/start`, `/v1/wallet/link/finish` | T | Link the user's Privy wallet (S, B; section 5) |
| GET / PATCH | `/v1/settings` | R / T | MEV protection, tip cap, token safety (S) |
| GET | `/v1/tokens/:mint/safety` | R | Token safety report (S) |
| GET | `/v1/stocks`, `/v1/stocks/:symbol` | R | Tokenized stocks (S; section 9) |
| GET | `/v1/records/trades`, `/v1/records/audit` | R | Stored history and audit log (servers with a database) |
| GET / PUT / DELETE | `/v1/app/fees` | A | The app's fee on its users' trades |
| GET / PUT / DELETE | `/v1/app/webhook`; POST `/v1/app/webhook/test` | A | The app's webhook |
| GET | `/v1/app/users` | A | The app's end users |
| GET | `/v1/app/records/trades`, `/v1/app/records/audit` | A | Records of all the app's end users |

The per-field details of each body are in `GET /v1/openapi.json` (each route's `description`) and in [SDK_AND_API.md](SDK_AND_API.md) section 7.

---

## 16. Using the TypeScript client instead

```ts
import { MemeClient, verifyWebhook } from 'memedesk-sdk';
const c = new MemeClient({ baseUrl: BASE, apiKey: KEY });            // app key: new MemeClient({ ... }).forUser('user-42')
const bnb = c.forChain('bnb');                                        // multi-chain server: every call under /v1/bnb/ (or pass chain: 'bnb' above)
const { client } = await MemeClient.signInWithPrivy({ baseUrl: BASE, privyToken });   // a person's Privy login instead of a key; client.signOut() ends it
const t = await c.swap({ side: 'buy', mint: '<mint>', sol: '0.01', slippagePct: 3, key: 'buy-002' });
await c.placeOrder({ type: 'take-profit', mint: '<mint>', pct: 100, priceUsd: '0.0002' });
const ok = await verifyWebhook(secret, rawBody, req.headers['x-memedesk-signature']);
```

Every method maps to one route above. Errors throw an `SdkError` with `code`, `message` and `fix`.

---

## 17. What to know before going live

- **Real funds:** the real-funds modes trade the user's real money. They have run on mainnet with small, user-approved amounts only (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)). Start small, and keep the caps low.
- **The user keeps control:** removing the server's signer in Privy stops all signing at once.
- **Your app's own checks:** your app is responsible for its users' eligibility, especially for tokenized stocks, and for showing what a trade will do before the user asks for it.
- **Status:** watch `/status.json` for degraded components, such as the RPC, Privy or Jito.
