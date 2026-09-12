# Difficult reproductions

Choose a technique for the uncertainty in front of you. These are options, not sequential gates.

- **Captured input:** replay a request, event log, or fixture through the affected path. Keep credentials out of shared artifacts.
- **Minimization:** remove inputs or steps while preserving the symptom when it helps isolate the cause. Stop when further reduction no longer helps.
- **Intermittent failure:** repeat the trigger, isolate state, pin randomness where useful, or stress the suspected timing window. Record attempts and failures; a clean run alone does not establish a fix.
- **Bisection:** when known-good and failing revisions exist, automate the symptom check in an isolated checkout and use `git bisect run`.
- **Differential check:** compare the same input across versions or configurations when one provides a trustworthy reference.
- **Temporary harness:** isolate the relevant subsystem when the full application prevents useful observation. Preserve the interactions that cause the failure.
- **Human-only reproduction:** use [the HITL template](scripts/hitl-loop.template.sh) when the agent cannot perform the required interaction. Ask for the specific action or artifact that is missing.

For restart failures, inspect persisted state, caches, locks, and configuration alongside the code. Preserve evidence before clearing state. Recovery after clearing a file is evidence about state handling, not proof that deletion is the correct fix.

Tag temporary logging with a unique prefix so cleanup is a focused search. Retain diagnostic tools only when future use justifies their maintenance.
