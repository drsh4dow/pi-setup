---
name: code-review
description: Review a branch, PR, or work-in-progress diff against repository standards and the requested behavior. Use for code review or "review since X".
---

# Code review

Review standards and specification in one pass yourself. Use an independent reviewer when requested or when an independent assessment is worth the handoff. A delegated reviewer performs the review directly.

## Scope

Resolve the user's comparison point and inspect the actual diff. For branch changes, compare against the merge-base. For work-in-progress requests, include staged, unstaged, and relevant untracked files. State what you reviewed; ask only if the intended scope cannot be inferred.

Find the requirements in the supplied task, linked issue, or authoritative repository documents. Follow the repository's issue-tracker instructions when fetching an issue. If no specification is available, state that limitation and review the behavior and standards you can establish.

## Review

Check the changed behavior and affected callers for defects, missing requirements, regressions, and unnecessary additions. Prefer removing redundant paths, mutable copies, and pass-through layers to adding abstractions. Apply documented repository rules; style preferences alone are not defects.

Support each finding with a file location, the violated requirement or broken behavior, and reproducible evidence when available. Distinguish confirmed defects from unverified concerns. Skip findings already enforced by tooling. A clean review is a valid result.

## Result

Report actionable findings by severity, identifying whether each concerns behavior or a repository rule. Summarize checks performed and remaining verification gaps. Keep optional suggestions separate from required fixes. Return findings without editing code unless repair is part of the assigned task.
