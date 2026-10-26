---
name: tdd
description: "Test-first red-green loop for features and bug fixes. Use when building a feature or fixing a bug whose behavior has a cheap local test target, or when the user asks for TDD, a failing test, or a regression test. Skip when the test path is unclear, expensive, or integration-heavy."
disable-model-invocation: false
user-invokable: false
---

# Test-driven development

Make each behavior the change adds or fixes executable before writing the code for it: a test that goes red, then the least code that turns it green.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## Seams

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

Test only at agreed seams, settled before the first test:

- A brief, a contract note, or the ticket that names the seams settles them.
- In an interactive session with no seams named, ask the user: "What's the public interface, and which seams should we test?" Give each proposed seam a one-line note on what it catches and what it misses.
- Unattended with no seams named, test through the seam the existing tests already use for that code path, and name it in the report as your assumption.

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the interface should expose), read the [codebase-design](../codebase-design/SKILL.md) skill for the vocabulary.

## The loop

Work in **vertical slices**: one test, one implementation, repeat, each test a **tracer bullet** that responds to what the last cycle taught you. Tests written in bulk before the code verify _imagined_ behavior: they test the shape of things rather than user-facing behavior, go insensitive to real changes, and commit to a test structure before you understand the implementation.

Read [examples.md](examples.md) before writing the first test. It pairs a good and a bad test for each rule below, including a red run that fails for the wrong reason.

1. **Pick one slice.** One seam, one test, one minimal implementation per cycle. For a bug, the first slice is the smallest test that would have caught it.
2. **Write the test and run it red.** Confirm it fails for the intended reason. If it passes, or fails for an unrelated reason, fix the test before touching the code. A missing export, a typo, or broken setup is an unrelated reason: stub the code so the run reaches the assertion.
3. **Write only enough code to pass it.** Don't anticipate future tests or add speculative features.
4. **Run it green**, with the tests nearby, then take the next slice.

The loop is done when every behavior the ticket or bug names has a green test at an agreed seam, or a recorded reason under "When a failing test is impractical", and each new test survives the two imagined edits below. Then dogfood the change per the [principle-prove-it-works](../principle-prove-it-works/SKILL.md) skill's "Dogfood the real thing" section, which also says what a drive reports. Refactoring is not part of the loop. It belongs to the review stage (see the [code-review](../code-review/SKILL.md) skill), not the red-green implementation cycle.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists. Name it in the glossary's terms.

Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec. Judge each test with the [principle-test-behavior-not-implementation](../principle-test-behavior-not-implementation/SKILL.md) skill's two imagined edits, which also define the tautological tests to leave out.

Run every boundary the suite can run fast and locally for real: your own modules, a temp directory, a subprocess, a local test database. Fake only what it cannot run: a third-party API, a production-only service, time, and randomness. Give each fake of an external service a **contract suite**, one set of tests that runs against the fake in the suite and against the real service's sandbox from the verification skill, never in CI, so the fake cannot drift from the service. At a boundary, pass the dependency in instead of constructing it inside the code, and give each external operation its own function, so each fake returns one shape and the test shows which operations it exercises.

When a change touches an adapter or crosses a boundary, at least one check crosses it for real: a suite test when the boundary runs fast locally, otherwise its contract suite against the sandbox.

- Change a test only when the expected behavior changed, and keep its assertions as strict as the contract.
- Make a flaky behavior deterministic in the test where you can, and name the signal it locks down.

## When a failing test is impractical

Prefer no new test over a bad test. A bad test mostly tests mocks, depends on timing or unrelated global state, needs slow or expensive infrastructure, or would be deleted right after proving the change. A slow check still runs, in the dogfood drive instead of the suite.

When the only test path is one of those, or the reproduction is vague or needs production-only state, use the closest executable check instead: a drive through the project's verification skill, a targeted script, a reproduction command, a snapshot comparison, a log assertion, or a focused integration check. Run it red before the change and green after, the same as a test.

## Report

- Each seam you tested at, and where it came from: the brief, the user, or your assumption.
- Each slice's red run: the command and the failure it produced.
- The green run of every new test, and the nearby checks you ran.
- Each behavior with no red run, why, and the closest check you used instead.
