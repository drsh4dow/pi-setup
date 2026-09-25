---
name: diagnosing-bugs
description: Diagnose bugs and performance regressions. Use when the user asks to debug or reports broken, failing, or slow behavior.
---

# Diagnosing bugs

Start with the reported symptom, relevant source, logs, and documentation. When evidence identifies a straightforward cause, apply a focused correction and verify it. Use the extended workflow below for difficult or unresolved failures, selecting the steps that reduce the uncertainty.

When exploring the codebase, read `CONTEXT.md` if it exists and check ADRs relevant to the affected modules.

## Protect secrets in evidence

Redact secrets from displayed commands, outputs, and captured artifacts. Keep credentials in environment variables rather than command text. Quote only the relevant lines from artifacts that contain authentication headers.

## 1. Establish a feedback loop

Find the smallest observation that distinguishes the user's failure from correct behavior. Inspect source and form hypotheses as needed to construct it. Prefer an existing test or command before building new infrastructure.

Choose a method suited to the failure:

- Run a test through the affected interface.
- Exercise a CLI or HTTP endpoint with a representative input.
- Drive the affected browser interaction and inspect its output.
- Replay a captured trace through the relevant code.
- Compare the same input across known-good and failing versions.
- Use a small isolated reproduction when the application cannot be exercised directly.

The loop should detect the user's exact symptom, rather than merely show that execution completed. Run it against the failing behavior when possible and retain the relevant result for comparison after the fix.

Make the loop faster and more deterministic when that helps the investigation. For intermittent failures, measure the reproduction rate and use bounded repeats or targeted stress supported by the suspected cause. A single passing run does not establish a fix.

If reproduction is unavailable, continue with source, logs, and other evidence that can narrow the cause. When missing access or evidence blocks progress, follow the system prompt's collaborative troubleshooting policy and ask a focused question. State the verification limit rather than claiming an unobserved reproduction.

## 2. Reduce the reproduction

Remove unrelated inputs, configuration, or setup when doing so helps isolate the cause. Preserve the user's failure mode. Stop reducing once the reproduction is small enough to distinguish the plausible causes; exhaustive minimization is not a prerequisite to a fix.

## 3. Test an explanation

State the suspected cause and the observation that would support or refute it. Consider alternatives when the evidence is ambiguous or an attempted fix fails; no fixed hypothesis count is required.

For a difficult investigation, briefly share the leading explanation and the next discriminating check. Ask for the user's input when their knowledge is needed to choose the next step, following the system prompt's clarification policy.

Use probes that test a specific prediction. Change one relevant variable at a time when comparing outcomes.

- Prefer debugger or REPL inspection when available.
- Add targeted logs at boundaries that distinguish the suspected causes. Tag temporary logs with a unique prefix so they can be removed reliably.
- For performance regressions, establish a baseline with a representative measurement, such as a timing run, profiler, or query plan. Use bisection when version history can isolate the regression.

After a failed check, revise the explanation using the new evidence instead of repeating variations of the same unsupported fix.

## 4. Fix and verify

Apply the smallest coherent correction supported by the evidence. Select regression tests using the system prompt's Tests and verification rules.

When a new regression test is warranted, exercise the real failure through a stable interface. Run it before the fix when practical to establish that it catches the failure, then verify it passes after the correction. If no suitable interface is available, use the best direct verification available and disclose the coverage gap.

Verify the original symptom. If a reduced test does not cover the original scenario, check that scenario separately. Reuse successful checks unless new changes, failures, or unresolved concerns justify repeating them.

## 5. Finish

Remove temporary instrumentation and clean up only artifacts created for this investigation. Retain a reproduction when it has continuing diagnostic value.

Report the supported cause, the correction, and material verification gaps. Include the cause in a commit or PR description when that deliverable is requested.
