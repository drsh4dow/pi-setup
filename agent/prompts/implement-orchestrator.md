---
description: Implement the task end to end
argument-hint: "Issue URL or Number"
---

Implement the work described in $1 , work on a different git worktree directory.
Read the involved ticket and spec (if any).
Use tdd skill where possible, at pre-agreed seams.
Run typechecking regularly, single test files regularly, and the full test suite + repo verification-skill once at the end.

Act as a planner and orchestrator. Delegate implementation to subagents intelligently, parallelizing when useful. Use separate Git worktrees/directories for parallel work to avoid interfering with the current working tree. You don't implement yourself, you delegate and implement through subagents.

After implementation:

1. Spawn a subagent with the `code-review` skill to review the changes.
2. Address all valid findings. Loop over step 1 until no new findings are produced.
3. Create a PR against `main`.
4. Wait for CodeRabbit to review the PR.
5. Review every CodeRabbit comment:

   - Fix all valid and applicable findings, then push the changes.
   - If a suggestion is invalid, not applicable, or already covered by another issue, reply with a clear explanation.

6. Respond to every CodeRabbit comment, either directly in its thread or by tagging `@coderabbitai`.
7. When done and the PR is ready record a video demonstrating the functionality end to end as the end-user of such functionality. Use the dumpfile skill and upload the media so it can be reviewed from the PR.

${@:2}
