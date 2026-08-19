---
name: tdd
description: Use for test-first development and cheap regression tests.
disable-model-invocation: false
user-invokable: false
---

# Test-driven development

TDD is the red to green loop. This skill makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Consult these rules during every cycle, not after it.

When exploring the codebase, read `CONTEXT.md` if it exists so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you are touching.

## When to use a regression test

For a bug with an obvious cheap local test target, make the broken behavior executable before changing production code. A practical target already has a nearby test seam and can run without broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn.

When that path is unclear or expensive and the user did not request test-first work, use the closest useful executable check instead. State why a failing test was not worth its cost. Prefer no new test over one that mostly tests mocks, timing, unrelated global state, or current implementation details.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not. A good test reads like a specification. "User can checkout with valid cart" names the capability and survives internal refactoring.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary where behavior can be observed without reaching inside. Infer the intended seam from the public interface, nearby tests, domain documents, and the requested behavior. Record the chosen seam before writing the test so the choice can be reviewed.

Choose the narrowest established seam that can prove the behavior. If the interface shape or seam itself is in question, consult `codebase-design` before writing the test. Keep tests on critical paths and complex logic rather than spreading assertions across every internal edge.

## The per-unit loop

For each behavior unit:

1. Identify the intended behavior, current behavior, affected path, and smallest observable example.
2. Write one focused test at the chosen seam.
3. Run it and confirm red for the intended reason. A passing test or unrelated failure does not establish the unit.
4. Make the smallest production change that satisfies the test without anticipating later units.
5. Rerun the focused test and confirm green. Run nearby validation when the change can affect adjacent behavior.
6. Start the next unit only from this verified state.

Apply the same bracket to a migration, sweep, or run of similar edits. Make one independently checkable change, run its focused check, then proceed. Do not batch units and postpone evidence to one final run. Finish with the repository's required broader checks.

If a requested failing test is impractical, establish a before and after with the closest executable check, such as a targeted script, manual reproduction command, browser automation, snapshot comparison, log assertion, or focused integration check.

## Anti-patterns

- **Implementation-coupled.** Mocks internal collaborators, tests private methods, or verifies through a side channel. The test breaks during a behavior-preserving refactor.
- **Tautological.** Recomputes the expected value the way the code does, so it passes by construction. Expected values need an independent source such as a known literal, worked example, or specification.
- **Horizontal slicing.** Writes all tests before all implementation. Bulk tests commit to imagined behavior and test structure before the implementation teaches anything. Use vertical tracer bullets, one test and one implementation at a time.

## Guardrails

- Keep one seam, one test, and one minimal implementation in each cycle.
- Keep each regression test focused on the bug. Avoid unrelated coverage and fixture churn.
- Correct a test that passes before the fix or fails for the wrong reason before editing production code.
- Preserve valid assertions and nearby contracts. Change an expectation only when the required behavior changed.
- Make flaky regression signals deterministic where practical and name the signal being fixed.
- Review and refactor after a unit is green, without changing its observable behavior.

## Completion evidence

Report the failing-before test or executable check and its relevant failure. Report the passing-after run, per-unit checks for multi-step work, and nearby or repository validation. If no failing-before test was practical, report the reason and the substitute before and after check.
