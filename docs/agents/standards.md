# Standards

What the code in this repository is held to, and the commands that check it. Reviewers read this file. The implementing agent runs the guardrails before reporting work done.

## Standards sources

- [`AGENTS.md`](../../AGENTS.md): the two bars for every change, generality across the user's projects and the AX it gives the harness.
- [`CODING_STANDARDS.md`](../../CODING_STANDARDS.md): the single source for the written coding rules, with sections for dependencies and scripts, tests, and Effect code. Reviewers apply the rules no check enforces.
- [`vite.config.ts`](../../vite.config.ts): the lint rules, including the Effect presets and the repository's own `anti-slop` rules in [`oxlint/anti-slop/`](../../oxlint/anti-slop/), and the paths excluded from format and lint.
- [`tsconfig.json`](../../tsconfig.json): strict TypeScript, with no unused locals or parameters.

A documented standard overrides any generic baseline a reviewer brings.

## Guardrails

`vp run verify` runs every check below except the last two. Its task list lives in `vite.config.ts`. CI runs it in two workflows on pushes to `main` and on pull requests: `check.yml` runs `vp run verify:without-video`, and `catchup-video.yml` runs `vp run verify:catchup-video-scripts` only when the `catchup-video` skill, `vite.config.ts`, or the dependencies change.

| Check                                                                    | Command                                                                                                             | Runs in                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| format, lint, typecheck                                                  | `vp check`                                                                                                          | CI (`.github/workflows/check.yml`), via `vp run verify:without-video` |
| tests, and Markdown links                                                | `vp run test:extensions`, `test:dumpfile`, `test:evals`, `test:docs`                                                | CI, via `vp run verify:without-video`                                 |
| skills, strict diagnostics, terminal-delivery citations, babysit scripts | `vp run verify:skills`, `verify:strict-diagnostics`, `verify:terminal-delivery-citations`, `verify:babysit-scripts` | CI, via `vp run verify:without-video`                                 |
| end-to-end tests against live models                                     | `vp run test:e2e`                                                                                                   | manual only                                                           |
| Markdown lint                                                            | markdownlint-cli2, configured by `.markdownlint-cli2.jsonc`                                                         | editor only                                                           |

## Findings

- `vp run verify` passed in full on the last setup run.
- The end-to-end tests run only by hand.
- Markdown lint runs only in editors: no script, CI step, or hook runs markdownlint-cli2.
- No pre-commit hook exists, so the checks run first in CI after a push.
