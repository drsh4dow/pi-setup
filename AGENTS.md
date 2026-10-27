# pi-setup

Global Pi configuration: system prompt, vendored TypeScript extensions, skills,
themes, and prompts. Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as the system
prompt for every model.

The configuration in this repo affects all projects, so they should not be overfitted to the repo.

Use `vp` for package management and scripts. Run
`vp run verify` before reporting a code or tooling change.

Every decision made in the code/output of this repository should increase the AX
(Agent Experience) of the harness.

Before writing Effect code, read `.repos/effect/LLMS.md` and inspect its source
and tests for idiomatic usage, module structure, and API design. Use the
submodule as read-only reference and keep application imports on the installed
`effect` and `@effect/*` packages. If it is absent, initialize it with
`git submodule update --init --recursive`.

## Working tree

The user commits to `main` in this checkout while agents work. Make changes in
a worktree at `.worktrees/<branch>`
(`git worktree add .worktrees/<branch> -b <branch>`). Run `vp install` from
inside it once `git rev-parse --show-toplevel` prints its path: its `prepare`
script builds `.build/bin`, and run from this checkout it rebuilds the binaries
every Pi session uses. Before reporting or merging, run `git log HEAD..main`
there, and rebase onto `main` when it moved, so the merge stays linear and keeps
the user's commits. GitHub allows only rebase merges here.

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
- Standards: `AGENTS.md`, `vite.config.ts` lint rules, and strict `tsconfig.json`, checked by `vp run verify` in CI. See `docs/agents/standards.md`.
