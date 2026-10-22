# pi-setup

Global Pi configuration: system prompt, vendored TypeScript extensions, skills,
themes, and prompts. Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as the system
prompt for every model.

Use `vp` for package management and scripts. Run
`vp run verify` before reporting a code or tooling change.

Every decision made in the code/output of this repository should increase the AX
(Agent Experience) of the harness.

Before writing Effect code, read `.repos/effect/LLMS.md` and inspect its source
and tests for idiomatic usage, module structure, and API design. Use the
submodule as read-only reference and keep application imports on the installed
`effect` and `@effect/*` packages. If it is absent, initialize it with
`git submodule update --init --recursive`.

## Agent skills

The engineering skills read this repository's config record in `docs/agents/`.
Rerun `/skill:setup-sh4dow-skills` when the tracker, the domain layout, or the
guardrails change.

- Issue tracker: GitHub issues in `drsh4dow/pi-setup`, through `gh`. See `docs/agents/issue-tracker.md`.
- Domain docs: single-context. See `docs/agents/domain.md`.
- Standards: `AGENTS.md`, `vite.config.ts` lint rules, and strict `tsconfig.json`, checked by `vp run verify` in CI. See `docs/agents/standards.md`.
