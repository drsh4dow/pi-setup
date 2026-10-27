# Global Pi configuration

Write each change to hold for every project the user works on, and judge each
decision by the AX (Agent Experience) it gives the harness. Pi loads
[`agent/SYSTEM.md`](agent/SYSTEM.md) as every model's system prompt.

The user commits to `main` while you work. Make changes in a worktree at
`.worktrees/<branch>`, and run `vp install` only where
`git rev-parse --show-toplevel` prints the worktree's path: its `prepare`
script rebuilds `.build/bin`, the binaries every Pi session uses. Then rebase
onto `main` and run `vp run verify` before reporting or merging. GitHub allows
only rebase merges.

Worktrees share one `git stash`, so save work in progress as a commit on your
branch. Keep scratch files in a `mktemp -d` directory of your own, and remove
only that directory.

Read [`CODING_STANDARDS.md`](CODING_STANDARDS.md) before you add a dependency,
run a package script, write a test, or write Effect code.

## Agent skills

The engineering skills read this repository's config record in `docs/agents/`.
Rerun the **setup-sh4dow-skills** skill when the tracker, the domain layout, or the
guardrails change.

- Issue tracker: GitHub issues in `drsh4dow/pi-setup`, through `gh`. See `docs/agents/issue-tracker.md`.
- Domain docs: single-context. See `docs/agents/domain.md`.
- Standards: the rule sources and the guardrail commands. See `docs/agents/standards.md`.
