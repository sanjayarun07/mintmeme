# Desktop Telegram scraper (optional)

Reads channels the **user** is already a member of, extracts contract addresses (`packages/core/src/signals.ts`), and produces trade *previews*. Optionally, in explicit auto mode, hands an `Intent`-shaped candidate to an injected callback.

## What exists
- `transport.ts` – `TelegramTransport` interface + `FakeTransport` (tests only).
- `session-store.ts` – AES-256-GCM, scrypt-derived key, `revoke()` / `delete()`.
- `scraper.ts` – per-channel filters (allow/deny keywords, min/max age, sender allowlist), global age limit, injected chain validator, cross-channel dedup, per-chain trade presets, preview (default) / auto modes.

## Limits (honest)
- **Live use is BLOCKED**: no real MTProto client is included (needs an external dependency such as gramjs/TDLib, and the user's own API id/hash from my.telegram.org). Only the fake transport is tested. Nothing here has touched Telegram.
- The store keeps ciphertext in memory; persisting `export()` to disk is the caller's job. `revoke()` wipes the local blob only – it does **not** terminate the session on Telegram's servers; the user must also do that in Telegram (Settings → Devices).
- Secret hygiene is by construction (generic error messages, redacted log, `toJSON`) and a test, not a guarantee against a hostile host process or memory inspection. JS strings can't be reliably zeroed.
- Auto mode needs `mode: 'auto'` **and** `autoEnabled=true` **and** a callback; otherwise it silently stays preview. The scraper never signs or submits; downstream risk limits, simulation and authorization still apply.
- Channel text is untrusted data: used only for keyword matching and address extraction. Config is frozen. Extraction is regex-based; a matching string is not proof a token is real or safe (the validator only checks existence on a chain). Scam/honeypot checks are out of scope here.
- Dedup state is in memory and resets on restart.

Run: `node --experimental-transform-types --no-warnings --test apps/scraper/scraper.test.ts`
