# Codex accounts use provider aliases

Pi stores credentials and serializes OAuth refreshes by provider ID, so each labeled Codex account gets its own `openai-codex@LABEL` provider. We accept aliases in model menus and persisted model changes rather than patching Pi's authentication runtime or replacing authorization headers outside its refresh machinery. Model configuration can keep using logical `openai-codex`; the account adapter also normalizes protocol history to that provider because Codex's tool-call conversion recognizes specific provider IDs.

A session persists both its provider and OAuth account identity. The provider checks that pin at dispatch, since Pi reports extension-hook errors without necessarily stopping the request.
