---
name: principle-redesign-from-first-principles
description: "Apply when integrating a new requirement into an existing design, during a planned rewrite or migration, or when a new internal API replaces one that still has callers."
disable-model-invocation: false
user-invokable: false
---

# Redesign From First Principles

When integrating a change, don't bolt it onto the existing design. Redesign as if the requirement had been a foundational assumption from the start, then converge on that design without keeping the old one alive.

**Design the end state.**
- Read all affected files and understand the current design.
- Ask: "if we were writing this from scratch with this new requirement, what would we build?"
- Size the change by the end state, per the [Laziness Protocol](../principle-laziness-protocol/SKILL.md): the code that remains, not the lines the diff touches.

**Converge on it.** Temporary compatibility code becomes long-lived debt, and old and new paths side by side make the codebase append-only.
- Propagate the change through every reference: types, docs, examples, rationale sections.
- When a new internal API replaces an old one, inventory the callers, migrate them, and delete the old API in the same wave. Do not keep a legacy path only because internal callers still exist.
- Treat a temporary adapter as exceptional and time-boxed, never as default architecture.
- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details.
- Migrating and deleting in one wave applies when no external users depend on backward compatibility and the project can absorb a coordinated breaking change.
- Persisted data and published names are the exception. A schema change is the riskiest migration because the data is the one thing you cannot roll back by reverting a deploy. **Additive first, destructive last and alone.** Adds (new nullable column, new table, new index) are safe in any deploy; drops and renames get their own deploy *after* no code references the old shape.

**Deliver it in green units.** Think about the whole redesign, then deliver it incrementally, each unit ending in a passing check per [Sequence Verifiable Units](../principle-sequence-verifiable-units/SKILL.md). Run the full static and runtime verification when the redesign is complete.

This is the method for preserving option value when integrating changes into an existing design.
