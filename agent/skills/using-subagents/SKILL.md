---
name: using-subagents
description: Use before creating subagents.
user-invokable: false
---

# Using subagents

Give each child a bounded outcome, necessary context and file paths, write permissions, and a completion check. Children start fresh; include decisions they cannot discover from the repository, not the conversation transcript.

Keep concurrent write targets separate. The parent prepares and integrates worktrees when needed, inspects returned artifacts, and handles small follow-up corrections directly. A finished child cannot be resumed.

Use background runs when there is useful independent work to do. When blocked on several children, use `delegate_session` with `action: "wait"` and `mode: "next"` to receive one completed result; remove its id before waiting again. Use `mode: "all"` when the next step needs every result.
