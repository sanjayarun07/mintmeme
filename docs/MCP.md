# MCP server

`apps/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets an AI client such as Claude Desktop or Claude Code drive the
whole Meme application:

- **Trading** on every chain of the execution server (`apps/server`): `solana`, `base`, `robinhood`, `bnb` (real funds) and `practice` (fake funds).
  Every trading tool takes `chain` and calls `/v1/<chain>/...` ([HTTP_API.md](HTTP_API.md)).
- **The RFQ desk** (`apps/rfq`), read-only: JupiterZ quotes on Solana with the gate and simulation, the size ladder, the gate check, the EVM venue comparison, pool
  liquidity and prices. The MCP server never calls the desk's `/api/execute` (that needs the user's wallet in the browser) or its RPC relay.

It uses the official MCP TypeScript SDK, isolated in `apps/mcp` like the Privy bundle: the rest of the repo stays dependency-free.

## Setup

```bash
npm run mcp:install
```

Environment (read at start; put them in the client config below, or in `.env` when you start it with `npm run mcp`):

| Variable | Meaning | Default |
|---|---|---|
| `MEME_API_URL` | The execution server | `http://127.0.0.1:3501` |
| `MEME_API_KEY` | An API key for it: make one in the key dashboard (`npm run keys`, [API_KEYS.md](API_KEYS.md)), which also gives you the config below filled in. A `read` key is enough for the read-only tools | none: keyed tools refuse |
| `MEME_USER_ID` | With an app key: the end user (sent as `X-User-Id`) | none |
| `MEME_PRACTICE_URL`, `MEME_PRACTICE_API_KEY` | A separate practice server (`npm run api`). Without them `practice` goes to `/v1/practice/` on `MEME_API_URL` | none |
| `RFQ_DESK_URL` | The RFQ desk | `http://127.0.0.1:3700` |
| `MCP_ALLOW_TRADES` | `1` lets the spending tools trade on real chains. Leave it unset unless you mean it | off |
| `MCP_TIMEOUT_MS`, `MCP_DESK_TIMEOUT_MS` | Request timeouts | 30 s, 180 s (a full desk quote with the capacity search takes a while) |

### Claude Code

```bash
claude mcp add --transport stdio memedesk --env MEME_API_URL=http://127.0.0.1:3501 --env MEME_API_KEY=<your key> --env RFQ_DESK_URL=http://127.0.0.1:3700 -- node --experimental-transform-types --no-warnings /Users/arunmozhi/Meme/apps/mcp/main.ts
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memedesk": {
      "command": "node",
      "args": ["--experimental-transform-types", "--no-warnings", "/Users/arunmozhi/Meme/apps/mcp/main.ts"],
      "env": { "MEME_API_URL": "http://127.0.0.1:3501", "MEME_API_KEY": "<your key>", "RFQ_DESK_URL": "http://127.0.0.1:3700" }
    }
  }
}
```

Use `node` 22.18 or newer (the absolute path to it if the client's `PATH` has an older one). Do not launch it through `npm run mcp` from a client: npm prints a
banner on stdout, which is the protocol channel (`npm run --silent mcp` works). The server logs one line to stderr at start, never a key.

## Tools

**Execution server, read-only:** `meme_chains` (no key), `meme_overview`, `meme_positions`, `meme_quote` (raw units, nothing sent), `meme_wallet`, `meme_trades`,
`meme_trade`, `meme_history`, `meme_orders`, `meme_order`, `meme_twap_status`, `meme_bulk_status`, `meme_events` (listens to the event stream for 1 to 30 s),
`meme_stocks`, `meme_stock`, `meme_token_safety`.

**Execution server, no funds move:** `meme_wallet_link_start` (returns the message the user signs in their own wallet), `meme_cancel_order` and
`meme_cancel_twap` (need `confirm: true`: a cancelled stop loss no longer protects the position).

**Execution server, spends funds:** `meme_buy`, `meme_sell`, `meme_place_order` (limit-buy, limit-sell, take-profit, stop-loss, trailing-stop, bracket), `meme_twap`,
`meme_bulk`. On real chains `amount` is plain units of the native coin and goes out as the chain's `amountKey` (`sol`, `eth`, `bnb`); on practice it is raw units with
`walletId` `w1` or `w2`. Buys and sells send an idempotency key (`key`, or a generated one).

**RFQ desk, read-only:** `rfq_config` (the stocks it quotes per chain), `rfq_quote` (the NDJSON stages rfq, other, build, xray, sim, decision, venues, capacity;
`stages` filters them; the maker's transaction is left out), `rfq_ladder`, `rfq_gate` (a pasted transaction, or the recorded one with a `tamper`),
`rfq_evm_quote` (Relay, KyberSwap, LI.FI, OpenOcean, Bebop on base, bnb, robinhood), `rfq_liquidity`, `rfq_evm_price`, `rfq_token_price`.

## Safety

- Every spending tool says **SPENDS REAL FUNDS** in its description and needs `confirm: true` (the boolean). The client may set it only after the user approved that
  exact trade; without it the answer is `confirm_required` and nothing is sent.
- On `solana`, `base`, `robinhood` and `bnb` a spending call is also refused with `trades_disabled` unless the MCP server was started with `MCP_ALLOW_TRADES=1`.
  `practice` (fake funds) needs only `confirm`. A practice server cannot run next to real chains (`apps/server/chains.ts`), so `/v1/practice/` never reaches real funds.
- The execution server's own checks still apply to every trade: a fresh quote, a simulation, per-trade and daily caps, and signing by the user's Privy wallet
  within its policy ([HTTP_API.md](HTTP_API.md) section 6).
- Arguments are checked against each tool's schema before any request (unknown fields, types, enums, patterns, ranges); ids cannot contain `/`.
- Answers and errors never carry secrets: the values of secret-looking environment variables (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PRIVATE*`...), bearer tokens,
  `api-key=` style query values and RPC keys in URL paths are replaced with `[redacted]`. The API key goes only to the execution server, never to the desk.

## Tests

`apps/mcp/tools.test.ts` (part of `npm test`) drives every tool against a fake HTTP backend: argument checks, the chain prefix per chain, the practice server, the
confirm and flag gate, the plain-units field per chain, the desk's read-only paths and NDJSON stages, the event stream, and redaction. One test starts `main.ts`
over stdio and lists the tools; it is skipped until `npm run mcp:install` has run.
