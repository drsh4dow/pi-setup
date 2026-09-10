---
name: using-subagents
description: Use before creating subagents.
user-invokable: false
---

# Using subagents

Delegate bounded parts of the work. Keep responsibility for the overall task, integration, and final review. A skill describes the workflow; it does not imply that one child should perform every step.

Give each child a bounded outcome, necessary context and file paths, write permissions, and a completion check. Children start fresh; include decisions they cannot discover from the repository, not the conversation transcript.

Keep concurrent write targets separate. The parent prepares and integrates worktrees when needed, inspects returned artifacts, and handles small follow-up corrections directly. A finished child cannot be resumed.

Every run returns its identity immediately and executes in the background. Launch independent assignments concurrently; compose dependent assignments after their prerequisites finish. Results arrive after the active tool-call batch or wake an idle parent. Continue useful work, then yield without a waiting announcement. Inspect progress or results when they inform a decision rather than polling for completion.
