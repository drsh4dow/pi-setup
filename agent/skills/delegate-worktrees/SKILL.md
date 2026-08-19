---
name: delegate-worktrees
description: Use when parallel delegates write or share mutable state.
disable-model-invocation: false
user-invokable: false
---

A wave is one batch of `delegate_run` calls started together. Its children share the selected worktree and build artifacts. They do not share conversation or memory.

## Separate writes first

List every mutable target the children can share, including source files, branches, state files, generated files, and build outputs. Prefer separation over coordination. Assign each target to one child, let children publish independent files or patches, and keep integration in the parent. Splitting fields inside one state file is still a shared write.

Most waves can use the main worktree when file ownership is disjoint and checks do not mutate shared outputs. Use one worktree per child when source ownership overlaps or disjoint source files still produce the same outputs, such as `target/`, `node_modules/.cache/`, `dist/`, or `pkg/`. A worktree separates repository files and copied artifacts, but not external services, databases, or paths outside it. Give those targets separate keys or directories too.

If one shared mutable target is a real requirement, do not rely on instructions to take turns. Keep one writer, run the dependent children in sequential waves, or use the target's existing lock or atomic update mechanism. Choose serialization only after ruling out separate targets.

## Create one worktree per child

The parent creates and integrates worktrees. `delegate_run` only selects one through `cwd`.

```sh
git worktree add ../wave-1-parser HEAD
test ! -d node_modules || cp -a --reflink=auto node_modules ../wave-1-parser/
test ! -d target || cp -a --reflink=auto target ../wave-1-parser/
```

Copy only artifact directories that exist and are expensive to rebuild. `--reflink=auto` uses copy-on-write when the filesystem supports it and a full copy otherwise, so child writes cannot mutate the parent's files. Keep worktrees beside the repository. On this machine `/tmp` is tmpfs, where a fallback copy can waste memory and disk-backed caches lose their benefit.

Run the child with `cwd: "../wave-1-parser"`. When it finishes, inspect and integrate its patch or commit before removing the worktree with `git worktree remove`. A correctly briefed child does not touch the main worktree.

## Write one wave brief

Permanent repository rules belong in `AGENTS.md`, which each child loads from its own `cwd` and parent directories.

Put wave-specific decisions in one brief file and cite its path in every child task. Include the design being implemented, interfaces siblings must agree on, file ownership, mutation permission, and expected result. Rewrite the brief before the next wave instead of copying its contents into every task.

## Verify after integration

Require each child to report the exact checks it ran and their results. Use those reports to find skipped checks, not as final evidence.

After integrating every child, remove its worktree and any temporary brief. Run the project's full check once from the parent worktree and inspect its output. The wave is complete when all child changes are integrated, temporary worktrees are gone, and this integrated check passes. Only that run supports the final verification claim.
