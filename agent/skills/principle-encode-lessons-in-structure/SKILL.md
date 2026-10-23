---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction."
disable-model-invocation: false
user-invokable: false
---

# Encode Lessons in Structure

Encode recurring fixes in mechanisms (tools, code, metadata, automation) instead of textual instructions. Every error, human correction, and unexpected outcome is a learning signal. Capture it, route it, and close the loop.

**Why:** Textual instructions are easy to miss. They require the reader to notice, remember, and comply. Structural mechanisms (lint rules, metadata flags, runtime checks, automation scripts) enforce the rule without cooperation.

**Pattern:**
When you catch yourself writing the same instruction a second time:
1. Ask: can this be a lint rule, a metadata flag, a runtime check, or a script?
2. If yes, encode it. Delete the instruction.
3. If no (requires judgment), make the instruction more prominent and add an example of the failure mode.

**Pick the strongest mechanism.** When more than one mechanism would work, choose the strongest the situation allows (an unrepresentable state that cannot compile, then a lint or banned API that fails CI, then a canonical helper, then a runtime check), because agents copy whatever the surrounding code already does and a weaker guard becomes the next template.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.

**Design gates that hold.**
- Give every number a mechanism. A number with no command behind it is an aspiration, not a constraint. State the number and the reason together. A threshold without a rationale gets deleted by the next person who hits it.
- When you have no number, ratchet. Set 80% coverage on a codebase at 62% and you get a red build forever, then a team that learns to ignore red builds. The alternative asks for no decision: record where you are, then refuse to get worse. Every check compares against the recorded value, not an aspiration. When a number improves, update it; when it drops, that's the finding.
- Unblock with an exception, not a deletion. An exception with an owner and a date unblocks you. Deleting the constraint unblocks everyone forever.
- Guard the bar itself. Watch for these five moves in the diff: the threshold moved, a test got easier, a checker got silenced, work is unfinished, an exception appeared. A regex-level guard over the diff is enough: it catches the cheap-road-to-green moves agents actually make, not a determined human hiding a change. When the guard can't tell whether a change tightens or loosens, report it; staying quiet is the wrong default.

**Feedback loop:**
- **Capture every correction.** When the human intervenes or tests fail, decide if it's a one-off or a pattern.
- **Route to the right layer.** One-off -> brain note. Recurring fix -> skill or lint rule. Systemic issue -> principle.
- **Close the loop.** Don't just record. Apply now or create a concrete todo.
- **Log every attempt, including the reverted ones.** Keep a short ledger so a discarded idea stays discarded. What matters is that the next person (or the next agent) reads it before proposing an experiment, and doesn't re-run one that already failed.

**Anti-patterns:**
- Acknowledging without recording ("I'll keep that in mind" does not persist)
- Recording without routing (a brain note about a lint rule that should exist is wasted unless the lint rule gets implemented)
- Fixing without generalizing (fixing one instance while leaving the recurring pattern intact)
