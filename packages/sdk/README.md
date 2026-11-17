# memedesk-sdk

Standalone trading SDK for the MemeDesk execution engine. Market, limit, take-profit, stop-loss,
trailing stop, bracket (OCO), bulk, TWAP, snipe, copy and price alerts, through one `Trader` class
or through the HTTP API with `MemeClient`.

Status: **practice-ready, not production-ready.** The signer is an in-process stand-in (no HSM), so
use it with throwaway keys and test funds. Live adapters exist for Ethereum (Uniswap V2) and Solana
(Raydium AMM v4) and were verified on local forks and validators only.

Requires Node 22 or newer. No runtime dependencies.

```js
import { createSimTrader, PRACTICE_TOKEN } from 'memedesk-sdk';

const { trader } = createSimTrader();   // practice chain, wallets w1 and w2, fake funds
const t = await trader.buy({ walletId: 'w1', token: PRACTICE_TOKEN, amount: '1000' });
console.log(t.state);                   // "finalized"
console.log(trader.positions());        // amounts are bigint in the SDK
```

Price orders also take `chase` (widen slippage on each failed fill, capped), `priceUsd` (a trigger
fixed in dollars, with a quote/USD feed in `TraderConfig.usd`), and can be moved with
`editOrder(id, { priceE18 | priceUsd })` (`PATCH /v1/orders/:id`). See sections 6.1, 6.5 and 6.6 of the guide.

Subpath imports: `memedesk-sdk/client` (HTTP client only), `/core`, `/evm`, `/sol`.
Full guide: `dist/SDK_AND_API.md`.

Build from the repo: `TYPES_ROOT=<path to node_modules/@types> npm run build` (needs `tsc` 5.7+ on PATH).
