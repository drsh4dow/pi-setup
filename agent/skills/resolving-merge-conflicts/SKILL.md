---
name: resolving-merge-conflicts
description: Resolve conflicts within an authorized merge or rebase while preserving unrelated work.
---

1. Inspect the current operation, conflicting files, and unrelated changes or staging.
2. Establish each side's intent from the diff and relevant history. Read linked PRs or tickets when needed to resolve uncertainty.
3. Preserve both intents where possible. Where incompatible, follow the operation's stated goal and explain the tradeoff. Ask only when product intent remains unresolved; do not invent new behavior to make the merge succeed.
4. Run relevant and repository-required checks. Fix what the merge broke within the task's scope.
5. Stage only resolved task files, preserving unrelated changes and staging. Finish the authorized merge or continue the rebase through its remaining commits. Follow an explicit request to stop or abort the operation.
