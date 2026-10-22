# pi-setup

Global Pi configuration: system prompt, vendored TypeScript extensions, skills,
themes, and prompts. Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as the system
prompt for every model.

Use `vp` for package management and scripts. Run
`vp run verify` before reporting a code or tooling change.

Every decision made in the code/output of this repository should increase the AX
(Agent Experience) of the harness.

Before writing Effect code, read `node_modules/effect/AGENTS.md`, the guide
that ships with the installed version. For API details and idiomatic usage,
read the examples in `node_modules/effect/ai-docs/` and the source in
`node_modules/effect/src/` and `node_modules/@effect/*/src/`. Run `vp install`
if `node_modules` is absent.

## Issue tracker

Issues live as GitHub issues in `drsh4dow/pi-setup`, driven by the `gh` CLI.
