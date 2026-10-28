---
name: hillclimb
description: "Improve one metric against a target through a loop of measured hypotheses: a frozen harness, a keep-or-revert call per attempt, a decision log, and one commit per kept win. Use for 'hillclimb X', or sustained work to push a speed, size, score, or other number to a target. A one-off perf fix is not a hillclimb."
disable-model-invocation: true
user-invokable: true
---

# Hillclimb

**You own the metric and the experiment's integrity. Supervise and review. Delegate the attempts.** For sustained, iterative improvement of one measurable thing against a target. This is the loop.

Core discipline: one change, one measurement, keep or revert. Never stack untested changes, and never claim a win from code inspection (the **principle-prove-it-works** skill).

Open a todolist with one entry per step before the first measurement.

1. Ground the workload and architecture before choosing the metric. Run the **how** skill over the target, name the realistic workload dimensions that can move the result (data size, history, state, concurrency), and select a case that reproduces the user's complaint. If no case reproduces it, fix the repro instead of hillclimbing. Then fix one metric, the direction that counts as better, and a checkable stop predicate that pairs a target with a floor on attempts so a lucky early win can't end the run (the example "at least 50% better than baseline and at least 10 iterations" is this shape). Use the user's numbers when given, otherwise agree them.
2. Build the measurement harness, prove its sensitivity, then freeze it (the **principle-build-the-lever** skill). Run contrasting realistic workloads and confirm the target case reproduces the symptom while easier cases separate as expected. If the harness cannot distinguish them, revise the workload or metric. Vet the harness with the **benchmark-checklist** skill before you freeze it, and make it print its error count and a count of the work done. Once frozen, one repeatable command emits the metric, sampled enough to clear the noise (median of N, not a single run). Record the baseline metric and a green run of the regression gate (the tests that must keep passing) before any change.
3. Open the decision log with the **show-me-your-work** skill, in this run's state folder. Log one row per attempt: the hypothesis and change as the decision, the mechanism as the why, the commit or revert plus the before and after numbers as the evidence, and `kept` or `reverted` with the delta as the result. Read it before each attempt, so a reverted idea stays reverted.
4. Ground each hypothesis in the architecture model from step 1, so it names a specific mechanism ("defer X off the boot path because it blocks first paint"), not "try memoizing something". For a perf metric, order hypotheses by the performance mantras, cheapest first:
   1. Don't do it. Stop work whose result nothing uses rather than cheapening it.
   2. Do it, but don't do it again.
   3. Do it less.
   4. Do it later.
   5. Do it when they're not looking.
   6. Do it concurrently.
   7. Do it cheaper.
5. Loop, one hypothesis per iteration:
   - Hand the change to a delegate per the **subagents** skill, with a tight scope. Supervise and review the diff rather than typing it, per `<context>` in the system prompt. When several independent hypotheses are live, fan them to parallel delegates, each in its own worktree (the **principle-separate-before-serializing-shared-state** skill).
   - Measure before and after with the frozen harness, and run the regression gate.
   - Accept only when the metric moves past noise and the gate stays green. Otherwise revert the change in full. A tweak that "might help" is not kept.
   - One commit per accepted fix, staging only the files you changed (`git add <files>`, never `-A`), per the **writing-good-commits** skill. Log the row either way, kept or reverted.

   Each iteration ends in a check before the next begins (the **principle-sequence-verifiable-units** skill).
6. Push past the first plateau. On a stall, several rejects in a row, pivot category, combine near-misses, re-read the source, or try something more radical before concluding the hill is climbed. Correctness and simplicity outrank the number. Revert a win that breaks behavior, and keep a simplification that holds the number (the **principle-laziness-protocol** skill).
7. Stop when the predicate is met, or when the remaining ideas are marginal and not worth their cost. Don't relax the predicate to meet it, and don't quit while cheap untried hypotheses remain. If you are stuck, surface it instead of spinning.
8. Close the decision log per the **show-me-your-work** skill: audit it against the transcript and get the cross-family review. Then open the PR per the **writing-good-prs** skill, with the accepted commits stacked in the order they landed.

**Reply:** the metric and target, baseline to final with the percent delta, iterations run (kept vs reverted), each accepted fix on one line, the decision log path, the best idea you would try next if pushed further, and the Attention section.
