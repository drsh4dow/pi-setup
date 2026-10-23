# Standards

What the code in this repository is held to, and the commands that check it. Reviewers read this file. The implementing agent runs the guardrails before reporting work done.

## Standards sources

- [`AGENTS.md`](../../AGENTS.md): use `vp` for scripts, judge every decision by the AX it gives the harness, and read the `.repos/effect` reference before writing Effect code.
- [`vite.config.ts`](../../vite.config.ts): the lint rules, including the Effect presets and the repository's own `anti-slop` rules in [`oxlint/anti-slop/`](../../oxlint/anti-slop/), and the paths excluded from format and lint.
- [`tsconfig.json`](../../tsconfig.json): strict TypeScript, with no unused locals or parameters.

A documented standard overrides any generic baseline a reviewer brings.

## Guardrails

`vp run verify` runs every check below except the last two. Its task list lives in `vite.config.ts`.

| Check                                                                                    | Command                                                                                                                                      | Runs in                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| format, lint, typecheck                                                                  | `vp check`                                                                                                                                   | CI (`.github/workflows/check.yml`, every push and PR), via `vp run verify` |
| tests, and Markdown links                                                                | `vp run test:extensions`, `test:dumpfile`, `test:evals`, `test:docs`                                                                         | CI, via `vp run verify`                                                    |
| skills, strict diagnostics, terminal-delivery citations, poteto scripts, babysit scripts | `vp run verify:skills`, `verify:strict-diagnostics`, `verify:terminal-delivery-citations`, `verify:poteto-scripts`, `verify:babysit-scripts` | CI, via `vp run verify`                                                    |
| end-to-end tests against live models                                                     | `vp run test:e2e`                                                                                                                            | manual only                                                                |
| Markdown lint                                                                            | markdownlint-cli2, configured by `.markdownlint-cli2.jsonc`                                                                                  | editor only                                                                |

## Findings

- `vp run verify` passed in full on the last setup run.
- The end-to-end tests run only by hand.
- Markdown lint runs only in editors: no script, CI step, or hook runs markdownlint-cli2.
- No pre-commit hook exists, so the checks run first in CI after a push.
