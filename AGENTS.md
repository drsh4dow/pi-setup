# pi-setup

Global Pi configuration: system prompt, vendored TypeScript extensions, skills, themes, and prompts. The agent's engineering standards live in [`agent/SYSTEM.md`](agent/SYSTEM.md).

Run `bun run verify` before reporting a change to `agent/extensions`, `agent/lib`, or `agent/scripts`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `drsh4dow/pi-setup`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
