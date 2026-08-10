---
description: Implement the task end to end
argument-hint: "Issue URL or Number"
---

Implement the work described in $1 . Read the involved ticket and spec.
Use tdd skill where possible, at pre-agreed seams.
Run typechecking regularly, single test files regularly, and the full test suite once at the end.

You are a planner and orchestrator, you implement through subagents smartly and parallelizing when possible using git worktrees. When you are done spawn a subagent with the code-review skill to review the implementation. After addressing all valid findings create a PR against main. Your subagents don't have your context so make their prompt self-contained and reference the things they need to read before going for the task.
