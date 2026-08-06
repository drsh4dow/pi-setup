# Multiple Codex Accounts are provider aliases, not a credential pool

Pi's auth store holds exactly one credential per provider ID, and the maintainer declined native multi-profile support (pi-mono #1391, #1770), recommending distinct provider IDs instead. We decided each additional Codex Account is a Codex Account Alias: a re-registration of the built-in `openai-codex` provider (its live model catalog, OAuth flow, and API adapter, via the public `openaiCodexProvider()` export) under `openai-codex-<label>`, owning its own `auth.json` entry. The primary account keeps the bare `openai-codex` ID with zero migration. Account switching is then ordinary model selection — `/model`, the shift+tab cycle over `enabledModels`, and `settings.delegate.model` all work unchanged — and the `chatgpt-account-id` request header derives from each credential's own token, so isolation is automatic.

## Considered Options

- **Runtime credential overlay** on the single `openai-codex` provider (prior art: `@narumitw/pi-codex-accounts`): keeps one model list but fights the auth store — token overlays, refresh-write locking, connection-cache invalidation.
- **`auth.json` snapshot swapping** (prior art: `pi-codex-account`): mutates shared state out from under a running session and loses refreshed tokens without careful writeback.
- **Automatic rate-limit failover / rotation** (prior art: `pi-multicodex`, `codex-swap`): explicitly out of scope; it hides which plan is being burned and rests on non-public quota endpoints.

## Consequences

Switching persists as the new default for future sessions because pi's native selector does so; we accept that rather than adding restore-on-exit state. Per-run account choice for delegates arrives as a generic optional `model` parameter on `delegate_run` (an unknown or unauthenticated value fails the run rather than silently substituting), which is useful beyond Codex. The alias's models must be added to `enabledModels` by hand once; the extension never writes settings.
