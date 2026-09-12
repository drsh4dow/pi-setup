---
name: domain-modeling
description: Resolve consequential domain terminology or update a project's glossary and architectural decisions.
---

# Domain modeling

Use precise terms when they affect the design. Read the relevant glossary and ADRs before proposing new language. Ordinary terminology discussion does not authorize documentation edits.

## Resolve the model

- When ambiguity changes a decision, explain the competing meanings and recommend a term. Ask only when intent cannot be inferred.
- Use concrete scenarios to distinguish states, relationships, and ownership that matter to the task.
- Compare claims about behavior with the relevant code. Surface discrepancies without treating current code as the intended specification.
- Keep established terminology when it remains accurate. Avoid creating glossary entries for general programming concepts or every noun in the conversation.

## Record authorized decisions

When documentation work is included in the task, update resolved terms in `CONTEXT.md` using [CONTEXT-FORMAT.md](CONTEXT-FORMAT.md). Keep it a domain glossary; implementation decisions belong elsewhere. Create files only when there is useful content to record.

Use root `CONTEXT.md` and `docs/adr/` for a single-context project. If `CONTEXT-MAP.md` exists, follow it to the relevant context's documents. Preserve existing repository conventions.

Record an ADR only when the decision is consequential to reverse, surprising without context, and the result of a real tradeoff. Use [ADR-FORMAT.md](ADR-FORMAT.md). If documentation is outside the request, surface the decision in the requested deliverable rather than editing files or interrupting to offer an ADR.
