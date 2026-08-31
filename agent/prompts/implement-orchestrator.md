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
4. Wait for CodeRabbit to review the PR.
5. Review every CodeRabbit comment:

   - Fix all valid and applicable findings, then push the changes.
   - If a suggestion is invalid, not applicable, or already covered by another issue, reply with a clear explanation.

6. Respond to every CodeRabbit comment, either directly in its thread or by tagging `@coderabbitai`.
7. When done and the PR is ready record a video demonstrating the functionality end to end as the end-user of such functionality. Use the dumpfile skill and upload the media so it can be reviewed from the PR.

${@:2}
