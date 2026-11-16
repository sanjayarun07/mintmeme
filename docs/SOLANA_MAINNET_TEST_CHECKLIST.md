# Solana mainnet test: what is needed, and who does what

**Rule for this project:** the assistant never runs a funded mainnet trade. Everything the assistant does on mainnet is read-only (quotes, `simulateTransaction`). You run any trade that spends real SOL.

## What you provide

1. **A new wallet used only for this test.** Not your main wallet. Fund it with about 0.2 to 0.3 SOL (enough for a few 0.01 SOL buys, fees, rent for token accounts, and any tip).
2. **Its private key, placed in `.env` by you.** Never paste it into chat. The assistant will not ask for it and will not read it.
3. **An RPC.** `ALCHEMY_API_KEY` and `HELIUS_API_KEY` already exist in `.env`. A free tier can rate-limit; say if you hit that.
4. **Optional, only for speed tests:** a Jito tip budget (for example 10,000 lamports per trade and a hard cap) and a Jupiter API key if the public endpoint throttles you.
5. **Per-trade limits you choose:** maximum SOL per trade (suggest 0.01), maximum slippage (suggest 5%), and a daily cap. These are enforced in code before anything is signed.
6. **The token you want to test.** Start with a liquid one (for example BONK) before any low-liquidity memecoin.

## What the assistant will do first (read-only, no funds)

- Search the token, read mint facts (authorities, decimals, Token-2022 flags), list routes, quote 0.01 SOL, and `simulateTransaction` as your wallet's **public** address.
- Show you each result in the terminal's **Solana lookup** page.

## What is not built yet (so a funded trade is not ready)

- (Built since this list was first written: a guarded path with per-trade and daily caps, a slippage cap, a two-step confirm and a kill switch, checked on a local validator only. See "Wallet login" below. No mainnet trade has been made with it.)
- Jito submission has only been tested against a stand-in block engine, not mainnet.

## Honest limits to expect

- Real fills differ from quotes: price impact, competing bots, and fees. Third-party search data can be spoofed, so confirm the mint address yourself.
- Mainnet results from one wallet are anecdotes, not a benchmark.

## Wallet login (updated)

- The terminal signs you in with a **Wallet Standard** wallet (Phantom, Solflare, Backpack, or any wallet that registers itself). Your private key stays in the wallet. The server only sees a signature over a one-time login message and, later, a signature for each trade you confirm.
- Each trade shows up in your wallet for approval. A transaction the wallet changes will not match what the server built, and the server rejects it. Some wallets add their own protections to transactions, which can cause this: that is a known limit and has not been tested here with a real wallet.
- **Privy:** Privy's browser SDK is React-only, so it is built as a separate bundle in `apps/privy/` (run `npm run build:privy` once; the 5 MB bundle and `node_modules` are git-ignored). Set `PRIVY_APP_ID` in `.env`; the page then shows "Log in with Privy". After login, Privy's Solana wallets appear in the same wallet list as Phantom and every trade is still approved in the wallet. In the Privy dashboard, allow the origin `http://localhost:3000` (Privy needs the port) and enable the login methods used here (email, wallet). The terminal's port is `PORT`, default 3000.
  - Checked: the bundle builds, the page loads it, shows the login button, and Privy's API answers for this App ID from `localhost:3000`.
  - Not checked: an actual Privy login, embedded-wallet creation, or signing a transaction through a Privy wallet. Privy's docs name a hook `useSolanaStandardWallets`; the installed version (3.51.4) exports it as `useStandardWallets`, and the docs disagree with each other on the embedded-wallet config key, so expect to adjust after the first real login.
  - The Privy bundle pulls in about 800 npm packages (wallet SDKs). It is isolated from the core, which has no dependencies.
- **Verified:** the server side (login, session, signing requests, refusal of bad or changed signatures, declines) on a local validator with fake SOL (`npm run verify:sol-guard`), and the page's wallet discovery and sign-in in the browser with a mock wallet. **Not verified:** a real wallet extension, and any mainnet trade.
