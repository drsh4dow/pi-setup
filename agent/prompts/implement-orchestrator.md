---
description: Implement a ticket end to end through delegated agents
argument-hint: "<issue URL, number, or pointer>"
---

Implement $1 in a new worktree from `origin/main`. Do not modify the current worktree or implement code yourself. Plan, delegate, integrate, and verify. You execute your will through subagents smartly.

Read the ticket/task, and related documents if not already in context.

Use the fewest implementation subagents that can complete the ticket coherently. Prefer one subagent when it can own the full TDD loop within the 150k active-context limit.

Scope each delegated task so one fresh subagent can complete it end to end while keeping its active context below 150k tokens. This limit applies separately to each subagent, not to their combined or cumulative token usage. Include instructions, documents, source files, tool output, working history, and the final response in the estimate.

When splitting is necessary, prefer independently testable vertical slices. Each slice owns its tests and implementation across the affected layers. Do not split tests from implementation or divide work by architectural layer merely to create parallel tasks.

Delegate shared foundations first and verify them before starting dependent slices. Parallelize only slices with independent write ownership, using separate worktrees. Require every implementation subagent to use the TDD skill. Verify diffs and artifacts yourself.

Run focused tests and typechecking after each integrated change. Do not run the full verification gate during implementation.

The full verification gate is format, lint, typecheck, full tests, and the repo verification skill.

After implementation:

1. Run one `code-review` subagent.
2. Fix findings that cite a contract requirement or hard repo rule and include reproducible evidence.
3. Complete the full verification gate on the final pre-PR state. If it fails, fix the cause and restart the gate.

Do not run further broad reviews. Fix any remaining valid finding with targeted verification. Reject speculation, scope expansion, prototype production-parity beyond the contract, settled findings, and work tracked elsewhere.

Then:

1. Create a PR against `main`.
2. Wait for CodeRabbit unless rate-limited.
3. Apply the same validity rules to every comment.
4. Fix valid comments, push, and reply to every thread. Do not solicit repeated full reviews.
5. If the branch changed after opening the PR, complete the full verification gate again. Otherwise, reuse the successful pre-PR result.
6. Add end-to-end media to the PR using `dumpfile`.
7. Stop owned processes.

Do not run the full verification gate at any other point.

Ask the user only when faithful completion is impossible without human access or input.

${@:2}
