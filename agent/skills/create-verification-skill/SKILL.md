---
name: create-verification-skill
description: Generate and smoke-test a project-local skill for driving the app through a useful verification path.
disable-model-invocation: true
---

# Create a verification skill

Build the smallest useful project-local skill at `.agents/skills/verify-<app>/`. Reuse existing launch commands and harnesses; introduce helpers only when they simplify repeatable work.

## Discover

Read the repository to identify the requested surface, launch command, prerequisites, existing automation, observable results, and isolation model. Ask only about facts or choices that cannot be established and materially affect the result.

If startup is blocked, report the concrete prerequisite and continue drafting what the evidence supports. Repair product code only when authorized. Mark unexecuted instructions as unverified.

## Generate

Write `SKILL.md` with YAML frontmatter (`name`, `description`) identifying the app and when verification is useful. Ground these sections in the actual app:

- **Launch:** the command, readiness signal, and isolated ports, profiles, or data directories. Reuse a long-lived instance for servers; use fresh isolated sessions where short-lived CLI/TUI drives require them.
- **Doctor:** a focused check of instance identity, readiness, and necessary access, used before driving and after surprising failures.
- **Drive:** the relevant user path using existing automation. Prefer accessible names, stable selectors, and commands over coordinates or timing guesses.
- **Evidence:** the action and observable result that establish the behavior. Check persistence or external effects when they are part of the contract. State the limits of substitutes or dry-run modes rather than treating their names as proof.
- **Cleanup:** stop owned processes and remove owned scratch state, preserving evidence at a named location. Never kill by process name or terminate another session's instance.

Any helper should be executable, small, and documented with its invocation.

## Seed and prove one path

Create `features/README.md` and a representative feature recipe. Add further features only when the requested scope or demonstrated need warrants them. Use [the feature-map example](references/feature-map-example/) for the index and recipe shape.

Distinguish an ordinary changed-feature check from a full-map audit. The existence of a map does not require driving every entry on every change.

Run the generated launch, doctor, representative drive, evidence capture, and cleanup once. Clean up failed attempts too. Confirm evidence survives teardown. Correct and re-run instructions invalidated by a failure; report any remaining unverified path honestly.

Deliver the skill and the observed result. Mention `/maintain-verification-skill` when explaining how to update the map later.
