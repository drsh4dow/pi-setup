# Codex accounts

Add account labels to `~/.pi/agent/codex-accounts.json`, or the agent directory selected by `PI_CODING_AGENT_DIR`:

```json
{
  "accounts": ["A", "B", "C"]
}
```

Labels are unique and contain letters, digits, dots, underscores, or hyphens. Start with a letter or digit. Reload Pi, then authenticate each account through its normal OAuth flow:

```text
/reload
/login openai-codex@A
/login openai-codex@B
/login openai-codex@C
```

Use a different ChatGPT account for each label. Keep model defaults and delegate configuration on logical names such as `openai-codex/gpt-5.6-sol`. Internal aliases appear in Pi's model menus and saved model changes.

Without this configuration, the existing Codex login continues working. Credentials stay in Pi's normal credential store, separately keyed and refreshed per alias. No credentials are copied between accounts.

## Selection and pins

A new session selects the account with the highest fresh weekly percentage remaining when it first uses Codex. Alphabetical labels break ties. Selection ignores shorter usage windows. It is not round-robin; several sessions can choose the same account.

The account stays pinned while models can change. Resume and reload preserve the pin. Forks and newly spawned delegates select independently, even if their initial model names contain a parent's account alias. Sessions with existing Codex history keep their original login rather than selecting another account.

Unknown, stale, or exhausted weekly readings are ineligible. If none qualify, selection fails with an explanation. A pinned account never automatically changes because its quota, credentials, or configuration become unavailable. Reauthenticating its label to a different ChatGPT account blocks requests in that session. Restore the original account or start a new session.

Configuration changes take effect after `/reload`. Keep labels stable while sessions using them remain in use.

## Usage

Run `/codex-usage` to show every configured account's weekly percentage remaining, reset time, reading age, and retrieval errors. The current account is marked. A session pinned to the original login also shows that login. The command does not select or change an account.

Selection and the command share a persistent 15-minute cache. Concurrent refreshes are coalesced across local sessions and processes. There is no background polling and no extra usage query per prompt. Normal response headers update readings when available. Failed refreshes retain previous readings for display, honor `Retry-After`, and back off; stale readings cannot win selection.

Usage requests use ChatGPT's internal `GET /backend-api/wham/usage` endpoint, as implemented by the [official Codex client](https://github.com/openai/codex/blob/7c88f037d935b4e78311027c32da4f046fd84058/codex-rs/backend-client/src/client/rate_limit_resets.rs). It is not a public HTTP API contract and may change. The weekly window is identified by duration, not by whether the server calls it primary or secondary. Passive readings use the [official Codex response headers](https://github.com/openai/codex/blob/7c88f037d935b4e78311027c32da4f046fd84058/codex-rs/codex-api/src/rate_limits.rs).

Caching reduces requests but cannot guarantee avoiding provider restrictions. Token and USD accounting remains separate under Session Usage.

## Verification

```sh
node --test agent/extensions/codex-accounts/test/*.test.ts
bun run verify
```

Tests use temporary credentials, cached usage fixtures, and local transport. They do not authenticate with OpenAI or inspect real account credentials.
