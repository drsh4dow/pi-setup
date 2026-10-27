# pi-setup

Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as the system prompt for every
model.

The Pi configuration in this repository applies to every project the user works
on, so write each change to hold for any project.

Use `vp` for package management and scripts. Run
`vp run verify` before reporting a code or tooling change.

Judge every decision in this repository's code and output by the AX (Agent
Experience) it gives the harness.

Before writing Effect code, read [`CODING_STANDARDS.md`](CODING_STANDARDS.md).

## Working tree

The user commits to `main` in the main checkout while agents work. Make changes
in a worktree at `.worktrees/<branch>`. Run `vp install` from inside it once
`git rev-parse --show-toplevel` prints its path: its `prepare` script builds
`.build/bin`, and run from the main checkout it rebuilds the binaries every Pi
session uses. Before reporting or merging, run `git log HEAD..main` in the
worktree, and rebase onto `main` when it moved. GitHub allows only rebase
merges here.

Agents share this repository's git state and the host:

- Every worktree shares one `git stash`, so save work in progress as a commit
  on your own branch.
- Write scratch files in a directory you made with `mktemp -d`, and remove only
  that directory.
- A test or dogfood run that stubs `gh` runs in its own `mktemp -d` directory,
  with a `PATH` that cannot reach the real `gh`.

## Agent skills

The engineering skills read this repository's config record in `docs/agents/`.
Rerun the **setup-sh4dow-skills** skill when the tracker, the domain layout, or the
guardrails change.

- Issue tracker: GitHub issues in `drsh4dow/pi-setup`, through `gh`. See `docs/agents/issue-tracker.md`.
- Domain docs: single-context. See `docs/agents/domain.md`.
- Standards: `AGENTS.md`, `CODING_STANDARDS.md`, `vite.config.ts` lint rules, and strict `tsconfig.json`, checked by `vp run verify`. See `docs/agents/standards.md`.
