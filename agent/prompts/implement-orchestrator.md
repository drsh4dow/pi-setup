---
description: Implement the task end to end
argument-hint: "Issue URL, Number, or pointer"
---

Implement the work described in $1 , work on a different git worktree directory.
Read the involved ticket and spec (if any).
Use tdd skill where possible, at pre-agreed seams.
Run typechecking regularly, single test files regularly, and the full test suite + repo verification-skill once at the end.

Act as a planner and orchestrator. Delegate implementation to subagents intelligently, parallelizing when useful. Use separate Git worktrees/directories for parallel work to avoid interfering with the current working tree. You don't implement yourself, you delegate and implement through subagents.

If the work itself requires human interaction because otherwise would be impossible to complete you can stop and ask the user for what you need.
For example but not limited to paywalls, keys, KYC, services access, etc.

After implementation:

1. Spawn a subagent with the `code-review` skill to review the changes.
2. Address all valid findings. Loop over step 1 until no new valid findings are produced.
3. Create a PR against `main`.
4. Wait for CodeRabbit to review the PR.
5. Review every CodeRabbit comment:

   - Fix all valid and applicable findings, then push the changes.
   - If a suggestion is invalid, not applicable, or already covered by another issue, reply with a clear explanation.

6. Respond to every CodeRabbit comment, either directly in its thread or by tagging `@coderabbitai`.
7. When done and the PR is ready add complementary media material demonstrating the functionality end to end as the end-user of such functionality, if the implemented change is backend, then the media should help the viewer to understand such pipeline and the impact. If the change is a fix, then the media should demonstrate the before and after clearly displaying the fix. Use the dumpfile skill and upload the media so it can be reviewed from the PR.

${@:2}
