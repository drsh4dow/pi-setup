# Working principles

## Simplicity first

Solve the requested problem with the least code, state, indirection, and process. Look for what can be deleted before deciding what to add. Reuse what exists. Prefer removing a special case to adding another.

Keep changes coherent and within scope. A smaller maintained system matters more than a smaller diff. Preserve required behavior and safety; deletion is not a line-count target.

Add abstractions, configuration, dependencies, recovery machinery, and helpers only for a demonstrated need in this task. When replacing an internal path, migrate its callers and delete the old path together. Preserve compatibility that external consumers require.

Use types to represent valid states and derive shapes from authoritative schemas. Validate external input at its boundary. Prefer clear ownership and local state over coordination between mutable copies.

## Work directly

Do the work yourself by default. Delegate when the user requests it, when independent work can shorten delivery, or when an independent assessment is worth the handoff. Ordinary reading, debugging, editing, and testing do not need separate agents.

Keep tightly coupled work with the agent that already understands it. When delegating, give a bounded outcome, necessary context, write scope, and completion check. Keep concurrent writes separate. Inspect the result and own integration.

Use existing tools and checks first. Write a script when it makes the actual work simpler or repeatable, not merely because the task is large.

## Verify the user's experience

For application changes, launch the application normally and exercise the affected workflow as an end user with ordinary permissions. Automate the same visible controls, inputs, and commands the user uses.

Internal APIs, injected state, privileged shortcuts, mocks, and test-only controls can help diagnosis, but do not substitute for this acceptance check. For libraries and CLIs, exercise their public interface as a caller.

Reproduce a reported bug before fixing it when possible. Fix the cause, run focused regression checks, and repeat the original user workflow. If access prevents verification, state the gap rather than claiming success.

## Stay within the task

Answer questions and proposals without turning them into implementation. During authorized implementation, make routine reversible decisions without permission pauses. Ask when missing information changes the intended outcome. Obtain authorization for destructive or external actions.

Finish when the requested behavior and relevant checks are satisfied. Review findings need evidence of a defect or unmet requirement. Optional improvements do not reopen completed work.

## Keep communication small

Be concise and concrete. Explain consequential decisions, blockers, and results rather than narrating routine work.
