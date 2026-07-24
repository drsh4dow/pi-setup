---
name: seam-mapping
description: The pre-edit pass that maps a change's blast radius and picks the smallest viable design before any code is written. Use before implementing a non-trivial feature, fix, or refactor; when starting work in unfamiliar code; when the user asks what a change will touch or how to approach it; or when a fix keeps regressing somewhere else.
---

A change lands on a **seam**: the region of code whose behavior, data flow, and invariants the change passes through. Editing before the seam is mapped produces the additive patch - new code bolted beside old, special cases multiplying, parallel paths coexisting. Seam mapping is the pass that runs before the first edit; `abstraction-economics` prices each name during the edit, and `beauty-gate` audits the diff after. Map, then build.

## Steps

1. **Draw the seam.** Read the code the change passes through and locate all seven seam elements (reference below). Read implementations, not just names - a function's name is a claim, its body is the fact. For a user-facing production seam, apply `software-stewardship` and record each stewardship test as an invariant or an explicit absence. Criterion: each of the seven elements is either listed with concrete locations (file and symbol) or explicitly marked absent; "absent" after a search, never after a guess; every applicable stewardship test is represented in the seam.

2. **Sketch competing designs.** Produce at least two viable designs internally. For each, count its cost: concepts a maintainer must learn, paths through the code, states, dependencies, and locations touched. Criterion: two or more designs each carry a full count - one design with a justification is a rationalization, not a comparison.

3. **Choose the smallest native design.** Pick the design with the lowest counts that fits the repository's existing conventions. Ties break toward the design that retires the most existing code. Criterion: the choice names the count it wins on; when a costlier design wins, the constraint that forced it is named - and a constraint is a fact about the system or the user's intent, never taste.

4. **Mark the retirements.** List what the chosen design lets the change delete, merge, or inline: the old path the new one subsumes, the special case it makes unnecessary, the overlapping representation it collapses. New behavior that subsumes an old path replaces it - the seam carries one path. Criterion: every parallel path and special case found in step 1 carries a verdict - retired by this change, or kept with a named concrete need.

5. **Commit to one coherent change.** The implementation plan is the feature plus its retirements as a single change; retirements shipped "in a follow-up" are retirements that never ship. Extending beyond the initially dirty files is justified exactly when step 4 demands it. Criterion: the plan states scope, retirements, and the checks that will pin behavior - ready to hand to implementation, with `beauty-gate` auditing the result.

## Seam elements

What step 1 hunts for. The list is exhaustive on purpose - the elements skipped are the ones that regress.

- **Entry points** - every caller, route, handler, job, or event that reaches the code being changed.
- **Data flow** - what data enters, how it transforms, where it exits; the shapes at each boundary.
- **Invariants** - conditions the seam currently guarantees: ordering, uniqueness, non-null, idempotency, auth. The change must name which it preserves.
- **Existing abstractions** - the concepts already in play; the change speaks in these before minting new ones.
- **Parallel paths and special cases** - branches doing similar work, legacy variants, feature flags, copy-pasted near-duplicates. Prime retirement candidates.
- **Pinning tests** - the tests that fail if current behavior changes; their absence is a finding, not a relief.
- **Obsolescence candidates** - code, config, docs, or migrations the change makes dead.
