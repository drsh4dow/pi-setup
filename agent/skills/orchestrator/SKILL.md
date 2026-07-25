---
name: orchestrator
description: Plan and run bounded subagents from complete briefing packets.
disable-model-invocation: true
---

# Orchestrator

Act as the **foreman**: keep decisions, dependencies, and final responsibility in the parent; give each child one bounded outcome and the context needed to begin at the work seam.

## 1. Map the critical path

Read enough of the request and workspace to identify the deliverable, known decisions, relevant files, dependencies, and verification. Decide whether delegation shortens the critical path or supplies an independent perspective. Keep work in the parent when briefing and integrating it would cost as much as doing it directly.

Completion criterion: every proposed child has a concrete advantage over parent execution and no child is assigned context the parent has not yet gathered.

## 2. Cut coherent assignments

Give one child one outcome it can complete and verify within its execution budget. Split large work at durable seams such as independent modules, implementation versus adversarial review, or research versus application. Keep coupled edits and their tests together. Prefer the fewest coherent jobs because every child pays startup and integration costs.

Size work to finish before automatic convergence: `fast` within 4 minutes/1.5M reported tokens, `thorough/read` within 8 minutes/4M, and `thorough/write` within 20 minutes/15M. Hard ceilings are recovery fuses, not planning targets.

Choose execution deliberately:

- `fast/read` for scouting, focused research, review, critique, and diagnosis.
- `fast/write` for small, well-located corrections.
- `thorough/read` when synthesis is genuinely reasoning-heavy.
- `thorough/write` for a bounded implementation where mistakes are expensive or difficult to detect.
- `delegate_run` for one new child; `delegate_workflow` for two or more tasks known in advance.
- Background execution only when useful parent work can proceed concurrently. Read jobs may overlap; a write job runs alone.

Completion criterion: each assignment has one deliverable, one workspace intent, explicit boundaries, and a finish line that fits its class.

## 3. Write the briefing packet

A child starts with no parent conversation. Put all decision-relevant context in its task:

1. **Objective and deliverable** — the exact result to return or leave in the workspace.
2. **Known state** — decisions already made, observed symptoms, relevant commands already run, and facts the child may rely on.
3. **Work seam** — repository path, exact files/symbols or URLs, and the smallest area it should inspect.
4. **Boundaries** — in-scope behavior, permissions, preserved invariants, and excluded work.
5. **Verification** — specific checks to run and evidence to inspect.
6. **Output contract** — what the response must contain, including residual risk or incomplete work.

Supply excerpts or earlier outputs only when they change the child's decisions. An execution assignment begins from the supplied evidence and confines discovery to the named seam. A research assignment names the question, source standard, and stopping criterion.

Completion criterion: a fresh agent can start at the named seam without rediscovering parent context, and can tell objectively when to stop.

## 4. Dispatch and supervise

Run independent tasks concurrently up to the global child cap; stage tasks only when a later task truly consumes an earlier result. Pass only declared, bounded handoffs. Inspect status instead of duplicating work. Steer a running child only with new facts or a changed decision, phrased as a complete update. Cancel work that has become stale.

If a child reaches a limit or reports partial progress, preserve its workspace state and result. Re-scope the remainder into a smaller briefing packet rather than repeating the original assignment.

Completion criterion: every live child is still relevant, has one owner, and lies on the current critical path.

## 5. Integrate as the parent

Treat child reports as claims and workspace state plus check output as evidence. Resolve overlaps, run the final relevant checks, and review the combined diff. The parent owns the delivered behavior, user-facing report, and any recovery from partial work.

Completion criterion: outputs are integrated, relevant checks were inspected, no child remains live, and the parent can explain the final state without relying on hidden child context.
