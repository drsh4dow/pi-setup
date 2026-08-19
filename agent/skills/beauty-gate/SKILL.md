---
name: beauty-gate
description: Use for final code-diff review.
disable-model-invocation: false
user-invokable: false
---

A working implementation is still a draft. Tests establish behavior. This final pass decides whether the design deserves to remain.

## Steps

1. **Prove the result.** Run the relevant checks and inspect their output. Then verify the changed behavior against the direct artifact or actual feature path. A build, derived value, cached output, or delegated report is not proof when the real result can be inspected. Fix failures before continuing. The audit starts only when the implementation works.

2. **Read the complete change.** Include its staged changes, unstaged changes, and new files. Read every assigned hunk, including files changed early in the task. Treat unrelated worktree changes as user data, not part of the audit.

3. **Judge every hunk.** Mark it internally as keep, simplify, or delete. For each additive hunk you keep, name the concrete behavior or constraint that requires it. Find the obsolete, redundant, or speculative parts that can be removed before accepting additions built around them.

4. **Simplify the seam.** Apply every simplify and delete verdict without changing behavior. Prefer the design that leaves a tired maintainer with fewer states, decisions, and files to trace. Rerun the proof from step 1 and inspect the result. If simplification changes the design enough to create new decisions, read the diff again.

5. **Report what survived.** State what you deleted, merged, or inlined, why the remaining additions are necessary, and what the final proof directly verified.

## Questions for every hunk

- Does the new path replace an old one? Remove the old path rather than carrying both.
- Do two concepts or representations now overlap? Collapse them into one.
- Can a branch, state, special case, dependency, file, wrapper, helper, accessor, constant, or option disappear? Keep it only when it reduces concepts, enforces an invariant, hides substantial complexity, or has real reuse.
- Can a tired maintainer follow the behavior without chasing pass-throughs or scattered configuration?
- Does the code use the repository's existing terms, control flow, and file structure?
- Does each added line justify its permanent reading, testing, and migration cost?

Net deletion is evidence, not the goal. Keep explicit behavior, useful tests, clear code, and necessary documentation. A large additive diff passes only when no obsolete or overlapping implementation remains and each addition is required by the behavior or a concrete constraint.
