---
name: create-verification-skill
description: Use to create project-local app verification skills.
disable-model-invocation: false
user-invokable: false
---

# Create a verification skill

Build `.pi/skills/verify-<app>/` for the next agent to use cold. The result must drive the real app through a user-facing interface. Keep the generated skill specific to the repository and use model-only metadata.

## Inspect the repository

Read the repository before asking the user. Establish:

- the primary user surface and any secondary surfaces
- the documented local start command, dependencies, environment, auth, seed data, ports, and ready signal
- the best existing drive mechanism, preferring repository harnesses over a new one
- evidence available through screenshots, accessibility snapshots, transcripts, response bodies, logs, exit codes, or persisted state
- whether ports, profiles, and data directories let verification runs coexist safely

For browser or Electron surfaces, load `agent-browser` and its current core or Electron instructions before choosing commands. For a CLI or TUI, use an existing PTY or terminal harness. For a service, prefer its public HTTP interface. Use stable labels, prompt text, routes, and command flags instead of coordinates or tab order.

Run the repository's documented build or startup check. If the base checkout cannot start, report the exact blocker and stop. Do not encode guessed instructions around a broken base. Ask only for facts the repository cannot reveal, such as credentials or which of several products is primary.

Inspection is complete when every generated command, readiness check, drive handle, isolation boundary, and evidence type has a repository source or has been observed directly.

## Write the project-local skill

Create `.pi/skills/verify-<app>/SKILL.md` with this frontmatter:

```yaml
---
name: verify-<app>
description: <app-specific surface and verification triggers>
disable-model-invocation: false
user-invokable: false
---
```

The description must distinguish verification from ordinary tests and exploratory browsing. Ground the body in observed commands and handles. Leave no placeholders. Include these sections:

### Launch

Give the exact launch command, isolated ports or state directories, readiness signal, and teardown command. Track the process or background terminal created by the run. A short-lived CLI instead gives its one-time build step and starts each drive in an isolated terminal session. State when concurrent instances are unsafe.

### Doctor

Provide one read-only command sequence that identifies whether the intended instance is healthy and safe to drive. Check the relevant build or version, endpoint, auth, process ownership, and isolated state. The verifier runs doctor before driving and whenever behavior looks wrong.

### Drive

Give literal commands and stable handles from this repository. Use `agent-browser` for browser and Electron interaction when it is the selected harness. Name preconditions and expected observations. Exercise public user paths rather than internal setters or test-only endpoints.

### Evidence

Name a run-specific artifact directory inside the project, such as `.pi/verification/<run-id>/`, and keep it after cleanup. Capture the action and resulting state, not only the final view. Pair visible proof with a second user-facing or read-only check of side effects. Record commands, stdout, stderr, and exit codes for terminal paths. For dry-run or test modes, observe which files, network calls, browser windows, or refs they actually affect. Use mocks only at an existing production boundary.

### Cleanup

Stop only process IDs, sessions, containers, or resources created by this run. Remove scratch state and restore fixtures without deleting evidence. Never kill by process name or disturb a user-owned instance.

Document every shipped helper's invocation and make executable helpers executable. Prefer repository commands and direct harness calls over helpers that only rename one command.

## Seed a small feature map

Create `features/README.md` and files for the three to five highest-value user-facing features found in routes, menus, commands, or product docs. If the product has fewer, map all of them. Use [the feature map contract](references/feature-map.md).

The README names baseline preconditions, drive conventions, proof rules, and links every mapped feature. Each feature file identifies all known user entry points. Verification through one entry point does not prove another.

## Prove the result

Follow the generated skill once from a clean state:

1. Launch an isolated instance and observe readiness.
2. Run doctor successfully.
3. Drive one mapped feature through a real user entry point.
4. Capture the action, result, and side-effect evidence.
5. Run cleanup, including after every failed attempt.
6. Confirm the instance and scratch state are gone while evidence remains readable.

Fix generated instructions that fail and repeat the affected sequence. Finish only when the generated skill and feature map match the commands that completed this proof. Report the generated paths, exercised feature, commands run, evidence location, and any concurrency or coverage limits.
