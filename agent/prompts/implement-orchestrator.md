---
description: Implement the task end to end
argument-hint: "Issue URL or Number"
---

Implement the work described in $1 , work on a different git worktree directory.
If there is no ticket for it create one on github, in that ticket capture a checklist
of tasks you must do, the problem you are solving, and our shared understanding we reached so even if the context gets compacted it will survive on memory and you will retain the key tasks/decisions.
Use tdd skill where possible, at pre-agreed seams.
Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Act as a planner and orchestrator. Delegate implementation to subagents intelligently, parallelizing when useful. Use separate Git worktrees/directories for parallel work to avoid interfering with the current working tree.

After implementation:

1. Spawn a subagent with the `code-review` skill to review the changes.
2. Address all valid findings.
3. Create a PR against `main`.
4. Immediately use the `babysit-pr` skill to start the session-owned PR watcher. Starting the watcher does not block this workflow.
5. Record a video demonstrating the functionality end to end as its end user. Use the dumpfile skill and upload the media so it can be reviewed from the PR.

${@:2}
