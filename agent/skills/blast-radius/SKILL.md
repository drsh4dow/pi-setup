---
name: blast-radius
description: Use for hidden blast-radius analysis.
disable-model-invocation: false
user-invokable: false
---

# Blast radius

Find breakage that symbol search misses. Caller lists are inputs, not the result. The result rests on one or two safety facts proved by executing the real code.

## Proof scale

Grade each fact that the change's safety depends on. Report where the evidence stops.

1. Claim only. This is not evidence.
2. Source evidence. Cite an exact `file:line`, dependency source, pinned version, or local patch.
3. Failure-path evidence. Walk the bad case through the code and show where it becomes impossible.
4. Executable proof. Run a focused script or test against the same code and dependency version the project ships. Make it fail loudly when the fact is false.
5. Application proof. Reproduce the behavior in the running application.

Treat every safety fact below level 4 as unproven. Never round source reading or a delegated report up to executable proof.

## Workflow

1. Read the change and its immediate context. Inspect the diff, changed and deleted symbols, tests, commits when available, and the behavior that changed even when the diff does not state it. Define the boundary of the review.
2. Identify the one or two facts that make the change safe. Prefer a fact that eliminates several speculative risks at once. Write each as a falsifiable statement before expanding the search.
3. Follow effects beyond symbols. Inspect dependency source at the pinned version and local patches. Trace timing, cleanup, persistence, serialized data, database columns, wire formats, feature flags, generated code, and consumers in other languages or processes when the change reaches them. Record meaningful searches with no matches.
4. Separate confirmed risks from cleared risks. For each confirmed risk, name the failure path, exact evidence, likelihood, impact, and cheapest check. Do not invent callers, contracts, or APIs.
5. Prove the central safety fact. Prefer an existing focused test. Otherwise write the smallest temporary script or test that imports the shipped implementation and exercises the exact behavior. Use isolated fixtures and avoid production services or durable state. Run it, retain the command and output needed to establish the result, then remove temporary artifacts. If execution would be destructive, require credentials, or cause an outward action, stop at the strongest safe evidence and mark the fact unproven unless the user approves it.
6. For a genuinely wide change, use a small bounded set of `delegate_run` reviews with the same question and explicit search areas. Inspect their cited evidence and rerun decisive checks yourself. Do not delegate a narrow change merely to multiply opinions.
7. Re-read the final evidence against each falsifiable statement. A fact is proven only when the observed result rules out its failure case.

## Report

- **What changed.** Include behavior not obvious from the diff and the review boundary.
- **Safety fact.** State each fact, its proof level, the exact command and observed result. Label anything below level 4 `unproven`.
- **Confirmed risks.** For each, give the failure path, `file:line`, likelihood, impact, and cheapest check.
- **Cleared risks.** State what was checked and the evidence that cleared it.
- **Before merge.** Give the cheapest test or reproduction that catches the material bug. Include durable test code when the review added it.

Cite real code. Strip secrets and personal data from commands, output, and any public-facing text. Apply `unslop` to the report.
