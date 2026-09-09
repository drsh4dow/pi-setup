---
name: using-subagents
description: Use before creating subagents.
user-invokable: false
---

# Using subagents

Give each child a bounded outcome, necessary context and file paths, write permissions, and a completion check. Children start fresh; include decisions they cannot discover from the repository, not the conversation transcript.

Keep concurrent write targets separate. The parent prepares and integrates worktrees when needed, inspects returned artifacts, and handles small follow-up corrections directly. A finished child cannot be resumed.

Use background runs for useful independent work. Their results arrive automatically, so the parent can continue useful work or end its turn. Use blocking runs when the result is required before continuing.
