---
name: seam-mapping
description: Use before non-trivial code changes.
user-invokable: false
---

A seam is the code region that carries the behavior, data, and invariants a change will affect. Map it before editing. Otherwise the easy patch tends to add a second path beside the first.

## Steps

1. **Map the seam.** Read implementations, not only names. Locate all seven elements below. Record each with a file and symbol, or mark it absent after searching for it. For user-facing production code, apply `software-stewardship` and record each applicable test as an invariant or a confirmed absence. This step ends when all seven elements and every applicable stewardship test are accounted for.

2. **Compare designs.** When the choice is material, sketch at least two viable designs internally. Compare the concepts a maintainer must learn, code paths, runtime states, dependencies, and locations touched. If the map leaves only one credible design, record the constraint that rules out alternatives. This step ends when each candidate has been judged on all five costs.

3. **Choose the smallest native design.** Prefer the design with fewer costs that fits the repository's existing conventions. Break close decisions in favor of deleting more existing code. If a costlier design wins, name the system or user constraint that requires it. Taste is not a constraint.

4. **Name the retirements.** List the old paths, branches, representations, helpers, configuration, or docs that the design can delete, merge, or inline. Give every parallel path and special case from step 1 a verdict. Retire it in this change, or keep it for a concrete current need.

5. **Write one implementation plan.** Include the new behavior and its retirements in the same change. State the files in scope and the checks that will pin the behavior. The plan is ready when another agent could implement it without inventing a second design.

## The seven seam elements

- `Entry points.` Every caller, route, handler, job, or event that reaches the changed behavior.
- `Data flow.` Input shapes, transformations, outputs, and each boundary between them.
- `Invariants.` Ordering, uniqueness, non-null guarantees, idempotency, authorization, and any other condition the seam preserves.
- `Existing abstractions.` The repository's current terms and concepts. Reuse them before adding new ones.
- `Parallel paths and special cases.` Similar branches, legacy variants, feature flags, and copied implementations.
- `Pinning tests.` Tests that fail if current behavior changes. Missing coverage is a finding.
- `Obsolescence candidates.` Code, configuration, documentation, or migrations the change will make dead.
