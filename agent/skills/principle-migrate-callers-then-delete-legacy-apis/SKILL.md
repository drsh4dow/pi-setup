---
name: principle-migrate-callers-then-delete-legacy-apis
description: Plan API migrations and coordinated refactors, including compatibility and verification boundaries.
---

# Migrate callers and delete legacy APIs

For internal APIs whose callers can change together, inventory callers, migrate them, and delete the old API in the same refactor. Preserve compatibility only for real consumer or deployment constraints.

Choose coherent verification boundaries before a wide migration. Coordinated edits may temporarily break within a scoped, reversible unit; check the unit before building further on it. Verification need not follow every individual edit.

When consumers deploy independently, use expand–contract: introduce the new form, migrate consumers, then remove the old form once no dependent consumer remains. State the condition for removing compatibility code.

Keep commits reviewable and branch operations within the authorized workflow. Update relevant contracts and examples. Remove obsolete implementation-coupled tests without automatically replacing each one; retain protection for meaningful failures.

Complete relevant and repository-required checks at the final boundary. Intermediate checks should localize failures, not repeat completed verification without a reason.
