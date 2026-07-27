# Delegate Worktrees are the caller's, not the platform's

Parallel children sharing one worktree collide over build artifacts, so isolation has to come from somewhere. We considered a managed mode — `delegate_run` creating a git worktree per child, populating its dependencies, and merging results back — and rejected it: the merge-back policy cannot be generic (nothing sensible resolves a conflict between two children), non-git directories need a second path, and the lifecycle adds create, populate, track, and clean-up state to a tool that currently owns none. Instead `delegate_run` takes an optional `cwd` and runs the child there.

## Consequences

Isolation costs the parent three commands, documented in the `delegate-worktrees` skill along with the constraint that bit us: hardlinked artifact directories cannot cross filesystems, so a worktree under `/tmp` (tmpfs) fails with `EXDEV` per file. Integration and conflict resolution stay with the parent, where the judgement is. Children in separate worktrees still share the process: background terminals, tokens, and the machine.
