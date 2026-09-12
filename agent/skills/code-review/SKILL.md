---
name: code-review
description: Review a branch, PR, or work-in-progress diff against repository standards and the requested behavior. Use for code review requests or "review since X".
---

# Code review

Review standards and specification in one pass yourself. If you also wrote the changes, identify this as self-review, not an independent assessment.

## Scope

Resolve the user's comparison point and inspect the actual diff. For branch changes, compare against the merge-base. For work-in-progress requests, include staged, unstaged, and relevant untracked files. State what you reviewed; ask only if the intended scope cannot be inferred.

Find the requirements in the supplied task, linked issue, or authoritative repository documents. Follow the repository's issue-tracker instructions when fetching an issue. If no specification is available, state that limitation and review the behavior and standards you can establish.

## Review

Check the changed behavior and affected callers for defects, missing requirements, regressions, and unnecessary additions. Review naming, control flow, duplicated decisions, hidden state, shallow wrappers, and tests whose setup or maintenance outweighs the failure they catch. Prefer deletion and simplification. Apply documented repository rules; distinguish demonstrated failures from optional design suggestions.

Support each finding with a file location, the violated requirement or broken behavior, and reproducible evidence when available. Distinguish confirmed defects from unverified concerns. Avoid duplicating findings already reported by tooling; the existence of a rule does not establish that the current code passes it. A clean review is a valid result.

## Result

Report actionable findings by severity, identifying whether each concerns behavior or a repository rule. Summarize checks performed and remaining verification gaps. Keep optional suggestions separate from required fixes. Return findings without editing code unless repair is part of the assigned task.
