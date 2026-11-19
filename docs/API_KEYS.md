# API keys and the key dashboard

One API key works in both places:

- **The HTTP API** (`apps/server`): apps, bots and back ends send it as `Authorization: Bearer <key>` ([HTTP_API.md](HTTP_API.md)).
- **The MCP server** (`apps/mcp`): Claude Desktop or Claude Code gets it as `MEME_API_KEY` ([MCP.md](MCP.md)).

The server stores only the SHA-256 hash of each key, in `API_KEYS_FILE`: one `sha256hex:userId[:read|trade|app]` line per key. The key itself is shown once, when it
is made, and is never written anywhere.

## The dashboard

```bash
API_KEYS_FILE=/path/to/the/servers/keys.txt MEME_API_URL=http://127.0.0.1:3501 npm run keys
```

Then open http://127.0.0.1:3710. It:

- **makes a key** for a user id with a scope and an optional label, and shows it once. The key comes with ready-to-paste snippets for the HTTP API (`curl`),
  Claude Code (`claude mcp add ...`), Claude Desktop (`claude_desktop_config.json`) and `.env`, already filled in with the server URL, the key and this checkout's
  `apps/mcp/main.ts`;
- **lists the keys** in the file: label, user, scope, created, and the first characters of the hash. That includes keys made with `npm run server:key`, which have
  no label;
- **revokes a key**, after a confirmation;
- **shows whether the server is up** and which chains it runs (`GET /v1/chains`, no key needed).

| Scope | HTTP API | MCP |
|---|---|---|
| `read` | GET routes: prices, positions, orders, history | The read-only tools and the RFQ desk tools |
| `trade` | Everything for that user, including trades with real funds | All tools. Spending tools still need `confirm: true`, and `MCP_ALLOW_TRADES=1` on real chains |
| `app` | One key for an app's many end users, each named per call in `X-User-Id` | Set `MEME_USER_ID` to the end user |

Keys of the same user id share one account (wallet links, orders, positions) on every chain.

**No restart needed.** The execution server (`npm run server`) and the practice API (`npm run api` with `API_KEYS_FILE`) re-read the file within about 2 seconds:

- **A new key** works on the next request.
- **A revoked key** gets `401` from then on. Its open event streams are closed.
- **A malformed file** is not applied: the keys in use stay, and the server logs why.
- **A file with every key removed** is applied, so nobody can get in. A server will not *start* on an empty file.

**Several nodes.** Each node reads its own `API_KEYS_FILE`. Point every node at the same file (shared storage), or copy the file to each node after a change;
each node picks it up within 2 seconds.

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `API_KEYS_FILE` | The keys file of the server the keys are for (created on the first key if missing) | required |
| `MEME_API_URL` | That server's URL, for the status line and the snippets | `http://127.0.0.1:3501` |
| `RFQ_DESK_URL` | The desk URL in the MCP snippets | `http://127.0.0.1:3700` |
| `KEYS_PORT` | The dashboard's port | `3710` |
| `KEYS_ADMIN_TOKEN` | When set, the dashboard asks for this token once per browser tab before showing or changing keys | none |

Labels and creation times are kept next to the file in `<API_KEYS_FILE>.meta.json`. The servers ignore that file.

## Safety

- **Local only.** The dashboard listens on 127.0.0.1 only. It answers only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` on its port, which
  blocks DNS rebinding.
- **Same origin only.**
  - Cross-origin and cross-site requests are refused (`Origin`, `Sec-Fetch-Site`).
  - Creating a key needs a JSON body, so a form on another site cannot submit one.
  - The page sets a strict Content-Security-Policy and cannot be framed.
- **Secrets are never kept.**
  - A new key's secret appears only in the answer to the request that made it, and in the page until you press "I saved it".
  - The browser never stores it, and the dashboard never logs it.
  - Labels and user ids are inserted into the page as text, never as HTML.
- **Safe writes.** The keys file is written with mode 0600 to a temporary file and renamed into place, so a server never reads half a write. Changes run one
  at a time. Comments and other lines in the file are kept.
- **Command line instead.** `npm run server:key -- <user> [trade|read|app]` still prints a hash line to add by hand.
