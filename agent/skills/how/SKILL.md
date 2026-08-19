---
name: how
description: Use to explain existing code.
disable-model-invocation: false
user-invokable: false
---

# How

Build a working mental model of existing code. Trace the implementation before explaining it. The result should let an engineer start working in the area without turning into annotated source code.

This is read-only unless the user separately asks for a change.

## Scope the question

Infer the user's goal and current familiarity from the conversation. State a reasonable interpretation when the scope is ambiguous, then investigate. Let the user correct it rather than blocking a reversible explanation on a question.

Choose the smallest investigation that can answer the question:

- For one function or module, inspect it directly.
- For a subsystem or cross-cutting flow, split the investigation into two to four distinct angles such as entry and request flow, state and data model, or configuration and external seams.
- For ownership and layering questions, trace callers, dependencies, and existing seams. Explain where the behavior lives now and which module owns the relevant invariant. Do not redesign it unless asked.

Lean toward direct inspection. Delegation must buy independent coverage or reduce a genuinely broad search.

## Trace the code

Start from the observable trigger: a command, request, event, scheduled job, or function call. Follow the actual call chain to its effect.

For every material step:

1. Read the implementation, its important types, and its callers or callees. Names and directory structure are clues, not evidence.
2. Track the data entering the step, transformations and decisions, and the output or side effect.
3. Identify seams with other modules, including validation, persistence, network calls, and error handling.
4. Record exact files and symbols. Note behavior a newcomer would likely misread.
5. Continue until the path from trigger to effect has no unexplained jump. Mark any remaining gap instead of guessing.

For a broad question, use bounded read-only `delegate_run` calls in parallel. Give each delegate the same question and one non-overlapping angle. Require components, traced flow, files read, seams, surprises, and open questions. Inspect the cited code yourself where findings conflict, leave a gap, or support a central claim. A delegate report is a map, not proof.

## Explain it once

Teach at the level implied by the conversation. Start with the smallest complete answer: one or two sentences naming what the thing is and what happens. Then add only the detail needed for the user's goal.

Build the explanation in this order when each part earns its place:

1. A plain definition tied to this codebase.
2. The runtime flow from trigger to effect, including key decisions and data changes.
3. The few types or modules needed to understand that flow.
4. A short map of the files where someone would begin work.
5. Non-obvious behavior, unresolved gaps, or sharp edges.

Use concrete subjects and actions. Say which function calls which adapter and what data crosses the seam. Explain the problem an abstraction solves and its mechanism rather than listing symbols. Cite paths and symbols close to the claim they support. Include a short code excerpt only when the syntax itself carries the idea.

Use a diagram when it explains a multi-part flow faster than prose. For three or more moving parts, build the picture in small stages, redrawing the prior stage and adding one part each time. Skip diagrams that merely repeat the text.

Keep a one-shot explanation self-contained. Do not create lessons, learning records, mission files, quizzes, or a curriculum workspace. End after the explanation unless the user asks to go deeper.

## Critique architecture

When the user asks what is architecturally wrong or what could improve, explain the current design first. Critique from that verified model, not from pattern preference.

For a narrow module, judge it directly. For a broad or consequential subsystem, ask two or three read-only delegates for independent critiques through distinct relevant lenses:

- whether abstractions represent real concepts and place seams between things that change independently
- whether the data model matches runtime access and transformations
- whether validation, errors, and dependencies cross seams cleanly enough to test the module through its interface
- whether complexity pays for current needs and plausible next changes
- whether unexplained differences from nearby code create maintenance cost

Require concrete file and symbol evidence plus the practical impact. Reject line-level style findings, hypothetical extensibility, and rewrite proposals that do not establish a current problem.

Inspect the evidence and classify each finding:

- **Act on:** a demonstrated structural problem worth fixing now
- **Consider:** a real concern whose cost or remedy needs a decision
- **Noted:** a valid low-priority tradeoff
- **Dismissed:** unsupported, mistaken, or only stylistic

Present the standalone explanation before the critique. An empty critique is valid when the architecture fits its job.
