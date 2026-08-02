---
name: hacker-method
description: Start or resume an autonomous, high-yield bug-bounty campaign.
argument-hint: "Optional: payout floor, pinned target, constraints"
---

Invoke the `hacker-method` skill at `.agents/skills/hacker-method/SKILL.md`.

Run the continuous portfolio-autopilot workflow now. Optimize expected payout yield, select or opportunity-cost-pivot targets autonomously, use bounded offline scouts, keep exactly one live causal thread, and persist every decisive result through the skill's SQLite, evidence, and checkpoint contracts. Do not ask me to choose phases, tools, hypotheses, or targets unless the arguments explicitly pin a target or only I can supply a required access factor or irreversible/outward-facing approval.

Treat the arguments as campaign-mandate overrides and record them canonically. If they omit a payout floor, derive it from the strongest currently reachable portfolio opportunities. If they omit a target, rank current programs and admit the best one. If they pin a target, record its opportunity cost and honor the pin.

Continue across compaction, rejected theses, and target pivots. A failed hypothesis is a tombstone, not a stopping condition. Stop only after producing a production-proven finding above the payout floor with a verified submission-ready report package, when the user requests a stop, or when progress depends exclusively on user-provided input or approval. Lead the final response with the outcome and exact verification evidence.

<campaign-mandate>
$ARGUMENTS
</campaign-mandate>
