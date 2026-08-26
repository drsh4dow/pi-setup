---
name: using-subagents
description: Use before creating subagents.
user-invokable: false
---

# Using subagents

Subagents doesn't share your context and cannot access your conversation, so the initial prompt the subagent receive should be self-contained. For writing a good prompt for agents read the writing-for-agents skills if not already in context.

Subagents also don't share context between them or between rounds, so prompts that start with "final round of..." or "previous something..." are unnecessary noise for the subagent.
