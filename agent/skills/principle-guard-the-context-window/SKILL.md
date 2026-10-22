---
name: principle-guard-the-context-window
description: "Apply before reading or searching anything large (many files, big logs, long transcripts, unsized command output), when planning fan-out, or when context is filling up."
disable-model-invocation: false
user-invokable: false
---

# Guard the Context Window

The context window is finite and non-renewable within a session. Every token should be worth its cost.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Route bulk to subagents.** When the work means reading many files, a long transcript, or a large artifact, hand it to a subagent (the **subagents** skill) and keep only its summary and evidence locations in the main thread. Codemode (`<codemode>` in the system prompt) narrows the output of one step. Bulk work still goes to a subagent.
- **Bound incoming payloads.** Search before reading, request relevant line ranges, and redirect verbose command output to files. Inspect focused excerpts and relevant screenshots rather than loading everything.
- **Checkpoint findings.** Keep concise notes with evidence locations, decisions, unresolved questions, and the next step for long investigations. Reuse those notes instead of repeating reads. Saving notes does not remove content already loaded into context.
- **Don't read what you won't use.** Read selectively based on relevance. If a file isn't needed for the current task, skip it.
- **Keep frequently used content inline.** Templates and references used on every invocation belong in the skill file, not in separate files that cost a read each time.
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
