---
name: tdd
description: "Test-first red-green loop for features and bug fixes. Use when building a feature or fixing a bug whose behavior has a cheap local test target, or when the user asks for TDD, a failing test, or a regression test. Skip when the test path is unclear, expensive, or integration-heavy."
disable-model-invocation: false
user-invokable: false
---

# Test-driven development

Make each behavior the change adds or fixes executable before writing the code for it: a test that goes red, then the least code that turns it green. Inspired by Matt Pocock's `tdd` skill.

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

The loop is done when every behavior the ticket or bug names has a green test at an agreed seam, or a recorded reason under "When a failing test is impractical", and each new test survives the two imagined edits below. Then dogfood it. Refactoring is not part of the loop. It belongs to the review stage (see the [code-review](../code-review/SKILL.md) skill), not the red-green implementation cycle.

## Dogfood the real thing

A green suite proves the code against its tests and fakes. Most bugs live where the code meets something real: an adapter's translation, an error shape, a timeout, two events in an order nobody wrote a test for. Keep the suite fast, and find those bugs by using the real thing.

1. **Drive it like a chaotic user.** Run the real app, CLI, or service with its real boundaries through the project's verification skill, a project-local skill such as `.agents/skills/verify-<app>/` that launches the app and drives its features. Cover every feature in its feature map that the change touches, then leave the happy path the way real users do: steps in the wrong order, a double submit, an interrupt or kill mid-operation, a restart, empty, huge, or malformed input, two sessions at once, a slow or failing external service. Run every contract suite the verification skill lists for a service the change touches.
2. **Turn each bug into a slice.** Write the smallest test at a seam that reproduces it, run it red, fix the code, and run it green. When only the real boundary reproduces the bug, record the drive steps that do, and run them red before the fix and green after.
3. **Drive again after the fixes.** Dogfooding is done when a drive over the same features finds no new bug.

When two fixes fail the same drive, or a third bug turns up at the same boundary, stop fixing. The design of that boundary is the suspect premise: apply the [principle-attack-the-premise](../principle-attack-the-premise/SKILL.md) skill before the next fix.

When the project has no verification skill, drive the real thing by hand: a tmux session for a CLI or TUI, the [agent-browser](../agent-browser/SKILL.md) skill for a web UI, real requests for a service. Then recommend the user run the [create-verification-skill](../create-verification-skill/SKILL.md) skill. When a drive shows that the verification skill's steps or feature map no longer match the app, report it and recommend the [maintain-verification-skill](../maintain-verification-skill/SKILL.md) skill.

When the behavior depends on the order of events, such as concurrency, retries, cancellation, or a lifecycle or state machine, each test and each drive samples one order. If a project-local skill model-checks or proves that code, follow it for this change. If none covers it, name the gap in the report and recommend the [create-formal-verification-skill](../create-formal-verification-skill/SKILL.md) skill. When a formal check fails on code this change did not touch, the verification may be stale: recommend the [maintain-formal-verification-skill](../maintain-formal-verification-skill/SKILL.md) skill.

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
- The features you drove, the off-path cases you tried, and each bug the drive found with its slice or drive steps.
- Each contract suite you ran against a sandbox, and its result.
- Each premise you attacked, and what the evidence showed.
- Each verification or formal verification skill you recommended, and the gap it would close.
