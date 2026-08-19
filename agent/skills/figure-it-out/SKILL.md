---
name: figure-it-out
description: Use for ambitious or unattended work lacking a focused skill.
disable-model-invocation: false
user-invokable: false
---

# Figure it out

Design a task-specific workflow only when the available focused skills leave important coordination or discovery work uncovered. This skill owns the experiment sequence, not the technical methods inside each step. Load focused skills for those methods.

## Frame the run

Before implementation, write:

- A falsifiable done predicate. Name the observable artifact, the check, and the passing result. Replace terms such as "robust" or "complete" with evidence a reviewer can inspect.
- The known scope and the unknowns that could change the design. Estimate units by affected seams or deliverables, not elapsed time.
- A rigor level based on blast radius, reversibility, and uncertainty. State the extra gate required by each material risk. Do not add process that catches no named failure.
- Explicit bounds for the unattended run: maximum units, retries, fanout, and elapsed time or another clear stopping condition.

If no concrete unknown remains and a focused workflow fits, stop using this skill and route to that workflow.

## Build the experiment sequence

Map the affected seams before ordering work. Divide the run into units that produce inspectable evidence and can be kept or discarded without obscuring later results.

Order units by information value. Test the assumption most likely to invalidate the approach before broad implementation. Capture a pre-change baseline when comparison against it is part of the done predicate. Parallelize only units with separate state and independent verdicts.

For each unit, record in the working plan:

1. the hypothesis and the observation that would disprove it;
2. the smallest change or investigation that tests it;
3. the exact check and expected result;
4. the next branch for a pass, failure, or inconclusive result.

This plan is the only required run artifact. Add a durable decision record only when the user asks for one or when a later reviewer cannot reconstruct a high-cost, irreversible choice from the diff and tests.

## Run adaptive loops

Execute one unit, inspect its real artifact, and assign one verdict: `verified`, `not verified`, or `inconclusive`. Delegate reports identify evidence to inspect; they do not determine the verdict.

Keep a result only when it advances the done predicate or resolves a named unknown. After a failed or inconclusive test, change the hypothesis, observation method, or design before another attempt. Do not repeat a change with different wording. If the evidence invalidates the workflow, revise the remaining sequence rather than preserving the original plan.

Run the relevant check after each unit. At the end, test the integrated result against the original done predicate. Report the designed sequence, material revisions caused by evidence, the final verdict, and any predicate clauses that remain unverified.
