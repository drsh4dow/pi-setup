---
description: Implement and deliver the task directly, delegating only when useful
argument-hint: "Issue URL, number, or task"
---

Implement $1 in a separate Git worktree. Read the relevant requirements and repo rules. Use an existing ticket when provided; create one only if requested or required by the repository.

Implement directly by default. Use independent workers when they shorten delivery or provide a worthwhile independent assessment. If the user explicitly requests an orchestrator-only role, delegate implementation and own integration and verification.

Use TDD where practical at agreed public interfaces. Run focused tests and typechecking during implementation. Review the integrated diff against the requirements and repo rules in one pass, using the code-review skill. Fix evidenced defects, then run final repository verification and repeat the affected end-user workflow.

Create a PR against `main`. Use the babysit-pr skill to monitor it and address valid findings. Demonstrate application changes through the ordinary user interface with ordinary permissions, automating the actions a user takes. Attach end-to-end media using dumpfile when it demonstrates the change. For libraries and CLIs, exercise the public interface. Report any unverified behavior and stop owned processes when finished.

${@:2}
