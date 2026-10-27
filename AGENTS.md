# pi-setup

This repository is the user's global Pi configuration, so write each change to
hold for every project the user works on. Pi loads
[`agent/SYSTEM.md`](agent/SYSTEM.md) as the system prompt for every model.

Read [`CODING_STANDARDS.md`](CODING_STANDARDS.md) before you change code, run a
package script, write a test, or write Effect code.

## Working tree

The user commits to `main` in the main checkout while agents work. Make changes
in a worktree at `.worktrees/<branch>`. Run `vp install` from inside it once
`git rev-parse --show-toplevel` prints its path: its `prepare` script builds
`.build/bin`, and run from the main checkout it rebuilds the binaries every Pi
session uses. Before reporting or merging, run `git log HEAD..main` in the
worktree, rebase onto `main` when it moved, and then run `vp run verify`.
GitHub allows only rebase merges here.

Agents share this repository's git state and the host:

- Every worktree shares one `git stash`, so save work in progress as a commit
  on your own branch.
- Write scratch files in a directory you made with `mktemp -d`, and remove only
  that directory.

## Agent skills

The engineering skills read this repository's config record in `docs/agents/`.
Rerun the **setup-sh4dow-skills** skill when the tracker, the domain layout, or the
guardrails change.

- Issue tracker: GitHub issues in `drsh4dow/pi-setup`, through `gh`. See `docs/agents/issue-tracker.md`.
- Domain docs: single-context. See `docs/agents/domain.md`.
- Standards: the files that hold coding rules, and the checks that enforce them. See `docs/agents/standards.md`.
