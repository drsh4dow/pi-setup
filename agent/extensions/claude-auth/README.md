# Claude auth

Pi extension that reuses Claude Code subscription credentials.

It reads the active account from macOS Keychain or `~/.claude/.credentials.json`, registers Anthropic's OAuth lifecycle, applies Claude Code request headers, and writes rotated tokens back to Claude Code's credential store. Multiple macOS accounts remain selectable through `/login anthropic`.

The extension does not write `auth.json` while loading or on a timer. At session start it asks Pi's locked `AuthStorage` to update only when the Anthropic credential actually changed. Pi remains the sole owner of `auth.json`, so other providers and concurrent sessions are preserved.

Usable access tokens are reused until their actual expiry. Before writing a refreshed token back to Claude Code, the extension verifies that the source refresh token is still the one it refreshed; if Claude Code rotated it concurrently, Claude Code's newer credentials win.

## Development

Dependencies and tooling are declared at the repository root.

```sh
bun run test:claude-auth
bun run typecheck
bun run check
```

Optional environment variables:

- `PI_CLAUDE_AUTH_DEBUG=1` enables redacted logs at `~/.pi/agent/pi-claude-auth-debug.log`; a path writes there instead.
- `ANTHROPIC_CLI_VERSION` overrides the reported Claude Code version.
- `CLAUDE_CODE_ENTRYPOINT` overrides the billing entrypoint.
- `ANTHROPIC_USER_AGENT` overrides the complete user-agent.
