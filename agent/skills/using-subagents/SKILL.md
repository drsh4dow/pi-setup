---
name: using-subagents
description: Use before creating subagents or isolating bulky context.
disable-model-invocation: false
user-invokable: false
---

# Using subagents

A subagent does not share the parent's context. Give it a self-contained initial brief. Read `writing-for-agents` first when the brief needs more than a direct task statement.

## Delegate selectively

Delegate work that is independently scoped and would otherwise add bulk to the main context, such as inspecting long files, collecting verbose command output, or covering separate research branches. Keep work in the parent when it needs the parent's full conversational context, has a small payload, or requires tightly coupled decisions. Delegation has setup, review, and context costs of its own.

Do not read a large payload merely to decide whether to delegate it. Use filenames, metadata, targeted search, or a small sample to establish relevance. Tell the subagent which evidence it may inspect and what question that evidence must answer. The same rule applies inside the delegated run: read only material that can change the result.

## Write the initial brief

Include:

- the exact outcome and completion criterion
- supplied facts and decisions the subagent should treat as established
- owned files, allowed tools, mutation authority, and explicit exclusions
- the narrow seam to inspect and when expansion is justified
- checks to run and the required result format

Set a concrete bound such as files, branches, commands, turns, or elapsed time. Ask for evidence before elaboration. A delegated report is evidence to inspect, not proof that the task is complete.

## Keep bulk isolated

Leave raw logs, large documents, screenshots, and broad search results in the delegated context when the parent only needs their implications. Require a bounded report that leads with:

1. outcome or answer
2. decisive evidence with file and line references where available
3. checks run and exact results
4. uncertainty, residual risk, or the smallest blocker

Set a size bound appropriate to the handoff, usually a short paragraph or a fixed number of bullets. Request raw excerpts only for evidence the parent must quote, verify, or edit against. Inspect the relevant source or rerun a focused check before relying on a consequential claim.
