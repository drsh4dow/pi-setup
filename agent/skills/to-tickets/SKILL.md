---
name: to-tickets
description: Break a spec or conversation into a small set of coherent tickets with explicit dependencies.
disable-model-invocation: true
---

# To tickets

Work from the conversation and supplied references. Read linked specs or issues and relevant comments. Inspect the repository only as needed to establish implementation constraints and domain vocabulary.

## Slice the work

Create as few coherent tickets as needed. Each should deliver a useful, independently verifiable outcome within a manageable implementation scope. Prefer a narrow end-to-end path to layer-by-layer tickets, without inventing layers or tests the work does not need.

Declare only dependencies that genuinely prevent a ticket from starting. Avoid speculative scaffolding or prefactoring tickets. For coordinated migrations, follow [migration guidance](../principle-migrate-callers-then-delete-legacy-apis/SKILL.md); use compatibility stages only when actual consumers or deployment constraints require them.

Each ticket should contain:

- **What to build:** the requested outcome and why it matters.
- **Acceptance criteria:** the conditions for completion, without translating every criterion into a test.
- **Decisions and context:** contracts and nuances that would otherwise be lost, including useful source pointers or prototype snippets.
- **Blocked by:** real prerequisites, or none.
- **Parent:** the source issue when applicable.

## Deliver or publish

Follow [writing-good-tickets](../writing-good-tickets/SKILL.md). Present the breakdown when a draft is requested. When publication is authorized and material choices are resolved, publish without another approval loop. Ask only about unresolved choices that change scope or dependencies.

Read repository tracker and label instructions. Publish in dependency order so blockers can reference real identifiers, using native dependency links where supported. For a file-based tracker, write one file per ticket in dependency order. If no destination can be established, finish the draft before asking.

Mark tickets ready only when their requirements are sufficiently resolved under the repository's label policy. Report identifiers and blockers. Ticket creation does not authorize implementing the frontier or closing or modifying the parent issue.
