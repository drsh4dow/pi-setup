---
name: principle-encode-lessons-in-structure
description: Prevent a recurring, consequential mistake with structural enforcement when it costs less than recurrence.
---

# Encode lessons in structure

When the same consequential mistake recurs, look for its source: a permissive type, misleading interface, duplicated decision, or missing check.

Prefer removing the failure mode. Otherwise choose the cheapest reliable enforcement: an existing type constraint, lint, helper, or runtime check appropriate to the problem. Add automation only when its maintenance cost is justified.

Remove redundant instructions once the mechanism enforces them. Keep rationale that future maintainers need. One-off corrections do not require notes, new rules, or follow-up tasks.
