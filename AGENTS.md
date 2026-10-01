# pi-setup

Global Pi configuration: system prompt, vendored TypeScript extensions, skills,
themes, and prompts. Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as the active
system prompt.

Use `vp` for package management and scripts; Bun is the package manager. Run
`vp run verify` before reporting a code or tooling change.

Every decision made in the code/output of this repository should increase the AX
(Agent Experience) of the harness.

Before writing Effect code, read `.repos/effect/LLMS.md` and inspect its source
and tests for idiomatic usage, module structure, and API design. Use the
submodule as read-only reference and keep application imports on the installed
`effect` and `@effect/*` packages. If it is absent, initialize it with
`git submodule update --init --recursive`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `drsh4dow/pi-setup`, driven by the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
