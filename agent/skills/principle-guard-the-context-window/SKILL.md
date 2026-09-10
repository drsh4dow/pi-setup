---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, broad investigations. Use targeted searches, bounded reads, and file-backed logs; retain concise evidence and decisions."
disable-model-invocation: false
---

# Guard the Context Window

The context window is finite and non-renewable within a session. Every token should be worth its cost.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Bound incoming payloads.** Search before reading, request relevant line ranges, and redirect verbose command output to files. Inspect focused excerpts and relevant screenshots rather than loading everything.
- **Checkpoint findings.** Keep concise notes with evidence locations, decisions, unresolved questions, and the next step for long investigations. Reuse those notes instead of repeating reads. Saving notes does not remove content already loaded into context.
- **Don't read what you won't use.** Read selectively based on relevance. If a file isn't needed for the current task, skip it.
- **Keep frequently used content inline.** Templates and references used on every invocation belong in the skill file, not in separate files that cost a read each time.
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
