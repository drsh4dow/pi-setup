# Standards

What the code in this repository is held to, and the commands that check it. Reviewers read this file. The implementing agent runs the guardrails before reporting work done.

## Standards sources

<Each file that documents how code is written here, such as `CODING_STANDARDS.md`, `CONTRIBUTING.md`, or a style guide, with one line on what it covers. Write "none" when the repository documents nothing.>

A documented standard overrides any generic baseline a reviewer brings.

## Guardrails

| Check | Command | Runs in |
| --- | --- | --- |
| <format, lint, typecheck, test> | `<command>` | <CI workflow, pre-commit hook, or "manual only"> |

## Findings

<Each guardrail that fails today, is missing, or runs nowhere automatic, from the last setup run. Write "none" when every check runs and passes.>
