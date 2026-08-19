---
name: seam-mapping
description: Use before non-trivial code changes.
disable-model-invocation: false
user-invokable: false
---

A seam is the code region that carries the behavior, data, and invariants a change will affect. Map and redesign it before editing. Otherwise the easy patch tends to add a second path beside the first.

## Workflow

1. **Map the seam.** Read implementations, not only names. Locate all seven elements below. Record each with a file and symbol, or mark it absent after searching for it. For user-facing production code, apply `software-stewardship` and record each applicable test as an invariant or a confirmed absence. This step ends when all seven elements and every applicable stewardship test are accounted for.

2. **Sketch the material interfaces.** Start with realistic caller usage. Then sketch the affected data structures, function signatures, and module ownership. Bodies can remain pseudocode when behavior is not needed to judge the shape. Trace the dominant data flow through the sketch and state where validation and each invariant live. Keep this proportional: do not scaffold unchanged or obvious internals.

3. **Compare native designs.** When the choice is material, sketch at least two structurally distinct designs. Ask what the system would look like if the new requirement had existed on day one, rather than treating the current shape as fixed. Compare the concepts a maintainer must learn, code paths, runtime states, dependencies, locations touched, and complexity exposed to callers. Reject designs that add a parallel path, leak an internal representation, split one operation into caller-coordinated stages, or add a pass-through layer. If only one design is credible, record the constraint that rules out alternatives.

4. **Choose the smallest native design.** Prefer the design with fewer costs that fits the repository's conventions and absorbs the requirement into one source of truth. Break close decisions in favor of deleting more existing code. If a costlier design wins, name the system or user constraint that requires it. Taste is not a constraint. If implementation later produces repeated workarounds, related special cases, type escape hatches, or callers that must know internal rules, return to the map and redesign with those facts as requirements instead of bolting on fixes.

5. **Prove retirement conditions.** List every old path, representation, helper, configuration entry, test, and document that the design replaces. Inventory repository callers with code search and inspect dynamic registration, generated code, package exports, plugin hooks, published interfaces, and downstream repositories when applicable. Do not infer "internal" from a local search. Delete an old API in the same migration only after evidence shows either that no external consumer can depend on it or that the project explicitly accepts the coordinated break. Otherwise preserve compatibility as a named product constraint, not an unexamined default. Temporary adapters require an owner, removal condition, and bounded lifetime.

6. **Plan one migration to the end state.** Include the new behavior, caller migrations, test updates, and retirements in the same plan. State files in scope and checks that pin the new contract. Keep the repository buildable between ordinary steps. Intermediate breakage is allowed only for an explicit isolated migration phase whose scope, start and end boundaries, rollback, and high-signal checks are written in the plan. Do not expose a broken shared worktree, live configuration, published package, or externally consumed branch. End the phase by removing temporary code and running the project's full static and runtime verification before reporting completion.

The plan is ready when another agent can implement it without inventing a second design, guessing whether an old API is public, or deciding where breakage is allowed.

## The seven seam elements

- `Entry points.` Every caller, route, handler, job, or event that reaches the changed behavior.
- `Data flow.` Input shapes, transformations, outputs, and each boundary between them.
- `Invariants.` Ordering, uniqueness, non-null guarantees, idempotency, authorization, and any other condition the seam preserves.
- `Existing abstractions.` The repository's current terms and concepts. Reuse them before adding new ones.
- `Parallel paths and special cases.` Similar branches, legacy variants, feature flags, and copied implementations.
- `Pinning tests.` Tests that fail if current behavior changes. Missing coverage is a finding.
- `Obsolescence candidates.` Code, configuration, documentation, or migrations the change will make dead.
