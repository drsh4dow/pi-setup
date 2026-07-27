---
name: delegate-worktrees
description: Use when fanning out delegate_run children that write to the same repo, when parallel children collide over build artifacts, or when briefing a wave of children on shared context.
user-invokable: false
---

# Delegating a wave

A **wave** is one batch of `delegate_run` calls issued together. Children in a wave share your worktree, your build artifacts, and nothing else — no conversation, no memory of each other.

## Assign disjoint files first

Most waves need no isolation. Give each child a file set no sibling touches, keep integration yourself, and stop here.

Isolation is for the case disjoint files cannot fix: children running builds that write the *same* artifact directory — `target/`, `node_modules/.cache/`, `dist/`, `pkg/`. Two cargo builds in one `target/` block on the same lock; two bundlers race over the same output.

## Prepare a worktree per child

The caller prepares, the caller integrates. `delegate_run` only points a child at a directory via `cwd`.

```sh
git worktree add ../wave-1-parser HEAD
cp -al node_modules ../wave-1-parser/node_modules   # hardlink, not copy
cp -al target ../wave-1-parser/target
```

Hardlinks cannot cross filesystems, so the worktree lives beside the repo. `/tmp` is tmpfs on this machine: `cp -al` into it fails with `EXDEV` for every file, and a large `node_modules` turns that into thousands of error lines.

Then `delegate_run(task, cwd: "../wave-1-parser")`, and afterwards you merge each worktree back and run `git worktree remove`. Children never touch the mainline worktree.

## Brief the wave once

Repo-permanent rules belong in `AGENTS.md`, which every child already loads from its own cwd upward.

Wave-specific context — this refactor's design rationale, the interface the wave is converging on, decisions you made before fanning out — belongs in a brief file you write, cited by path in every task. Rewrite the file for the next wave rather than versioning it inside the tasks.

## Gate once, after integration

Children report the verbatim commands they ran and the results. Read those to spot a child that skipped a gate; re-running each child's checks yourself is paying twice.

Run the project's full check once, after you have integrated the wave. That is the run whose result you can actually claim.
