---
name: diagnosing-bugs
description: Investigate reported failures or performance regressions and verify their cause.
---

# Diagnosing bugs

Establish the symptom, inspect evidence, reproduce when practical, identify the cause, apply the smallest coherent fix, and verify the original failure. Respect the requested scope: a diagnosis request may end with findings rather than edits.

Read relevant domain documentation and code. Keep secrets in environment variables or local artifacts; redact them from shared output without blocking local investigation.

## Investigate

- Confirm the user's exact failure, affected environment, and expected behavior.
- Seek a reproduction early. Source inspection, logs, and falsifiable hypotheses can help construct it.
- Prefer an existing test, command, or captured input. Sharpen or minimize the reproduction when that will distinguish causes or speed the investigation.
- Use the smallest probe that separates plausible explanations. Instrument uncertainty rather than guessing, and change one relevant variable at a time.
- For performance, establish a baseline and measure the affected path before changing it.

For intermittent failures, bisection, replay, or human-only reproduction, consult [TECHNIQUES.md](TECHNIQUES.md).

If reproduction remains unavailable, continue evidence-based investigation. Distinguish hypotheses from confirmed findings, state what cannot be verified, and ask only for access or information that materially advances the diagnosis.

## Fix and verify

Fix the cause supported by evidence. Check whether the same cause affects related task paths, without turning a local fix into unrelated cleanup. A guard is appropriate when it enforces the actual contract; avoid guards that merely conceal a broken assumption.

Retain a regression test only when it protects a credible, non-obvious recurrence. Use the real failure pattern at the smallest suitable interface. A one-off reproduction may provide sufficient evidence without becoming a permanent test.

Verify the original failure against the final change, run relevant and required checks, and remove temporary instrumentation and owned scratch processes. Report the cause, result, and material verification gaps. Reuse completed verification unless subsequent changes invalidate it.
