# Delegate worktrees are the caller's, not the platform's

Parallel children sharing one worktree collide over build artifacts, so isolation has to come from somewhere. We considered a managed mode — `delegate_run` creating a git worktree per child, populating its dependencies, and merging results back — and rejected it: the merge-back policy cannot be generic (nothing sensible resolves a conflict between two children), non-git directories need a second path, and the lifecycle adds create, populate, track, and clean-up state to a tool that currently owns none. Instead `delegate_run` takes an optional `cwd` and runs the child there.

## Consequences

The caller creates and prepares each worktree, passes its path as `delegate_run.cwd`, then integrates the result. Worktrees that reuse hardlinked artifact directories must stay on the same filesystem; placing one under `/tmp` when it is a separate tmpfs fails with `EXDEV`. Integration and conflict resolution stay with the caller, where project-specific judgement belongs. Separate worktrees isolate file writes, not machine resources or token use. Each child owns its background terminals, and the delegate runtime stops them when that child settles.
