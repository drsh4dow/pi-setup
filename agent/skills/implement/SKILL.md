---
name: implement
description: Implement work from a spec or tickets, verify it, and review the resulting diff.
disable-model-invocation: true
---

Implement the requested work using the existing design where it remains clear. Prefer deletion and simplification.

Add tests only where the system's testing criteria justify them. Use [TDD](../tdd/SKILL.md) when the user requests test-first work.

Run relevant and required checks, then use [code-review](../code-review/SKILL.md) for self-review. Address concrete findings without broadening the task.

Report the result and material verification gaps. Commit when included in the requested workflow.
