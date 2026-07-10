---
name: beauty-gate
description: Use when working with code or auditing code.
---

A working implementation is a **draft**. The beauty gate is the pass that turns a draft into a finished change: one behavior-preserving audit of the entire affected seam. Green tests open the gate; they never waive it - tests establish behavior, not design quality.

## Steps

1. **Confirm the gate is open.** Run the change's relevant checks and inspect their output. Criterion: every relevant check green. If any check fails, finish the implementation first - the gate audits working code only.

2. **Read the complete diff.** Inspect the full working-tree diff - staged, unstaged, and new files - not only the files edited last. Criterion: every hunk read, including hunks in files touched early and forgotten.

3. **Give every hunk a verdict.** Judge each hunk against the audit reference below and mark it *keep*, *simplify*, or *delete*. Criterion: every hunk carries a verdict, and every *keep* on an additive hunk names the weight the addition carries.

4. **Apply the simplifications, then rerun.** Make the *simplify* and *delete* edits as one behavior-preserving pass, then rerun the checks from step 1. Criterion: checks green on the simplified seam. One pass only - code that has converged to a clear design stays converged; reopen the gate only if this pass changed the seam materially.

5. **Report the gate's outcome.** State what was deleted, merged, or inlined; what remained additive and why each addition is irreducible; and what the rerun verified. Criterion: a reader can tell verified simplification from intended simplification.

## Audit reference

Every question is asked of every hunk - the gate is exhaustive, not a sample.

- **Replacement**: does the new path let an old path retire? Retire it - the seam carries one path, coexistence is a *simplify* verdict waiting to happen.
- **Merge**: do two concepts or representations now overlap? Collapse them into one.
- **Disappearance**: can a branch, state, special case, dependency, file, wrapper, helper, accessor, constant, or configuration option go? Each survivor must reduce cognitive load, enforce an invariant, hide substantial complexity, or earn real reuse - relocation alone is a *delete*.
- **Cohesion**: can a tired, smart maintainer follow the behavior through one seam, without chasing pass-throughs or scattered configuration?
- **Nativeness**: does the change read as if the repository's original author wrote it?
- **Weight**: is every added line carrying enough to justify its permanent reading, testing, and migration cost?

Net deletion is evidence worth noticing, never the target: keep clarity, explicit behavior, useful tests, and necessary documentation even when they cost lines. A substantially additive final diff passes only when the additions are irreducible and no obsolete or overlapping implementation remains.
