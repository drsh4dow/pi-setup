---
name: maintain-verification-skill
description: Use to maintain project-local app verification skills.
disable-model-invocation: false
user-invokable: false
---

# Maintain a verification skill

Keep an existing verification skill aligned with the app. Cover every mapped feature from source and through the live user path. The feature is the unit of coverage. Individual bullets do not each require a separate drive.

## Outcomes

Report exactly one outcome:

- `clean`: source and live coverage finished for every feature, with no correction worth shipping.
- `changed`: proven corrections were made inside the verification skill directory.
- `blocked`: coverage could not finish or a proven correction could not be made safely. Name the blocker and completed coverage.

A clean or blocked run makes no branch or PR. A changed run leaves reviewed local edits by default. Open a PR only after the user explicitly authorizes that outward action.

## Edit boundary

Once the target is selected, record its directory as the sole edit boundary. Edit only its skill file, feature map, and harness files it owns. Scratch notes belong outside the repository or in an ignored scratch location. Never change product code, tests, general tooling, or unrelated documentation during this pass.

Treat mismatches by cause:

- The map describes the user experience incorrectly or omits a prerequisite: documentation drift.
- The user path works but the owned harness cannot drive it: harness drift.
- The app fails its intended user path: product defect. Report it without changing the app or rewriting the map to make the defect look expected.

## Pass

### 1. Select the target

Search project-local skill locations for a skill that defines launch, doctor, drive, evidence, and cleanup instructions and has a feature map. If several qualify, ask the user to select one. If none qualify, stop and report that the project first needs a verification skill. Do not invent a target during maintenance.

Read the complete target skill and its feature-map index before acting. Record the target directory, launch model, evidence location, cleanup contract, and every indexed feature file. Selection is complete when exactly one target and its full edit boundary are known.

### 2. Repair index hygiene

Compare the feature-map index with sibling feature files. Within the edit boundary, correct missing, extra, duplicate, renamed, and dead entries. Keep the index hand-maintained rather than adding generated inventory.

Index hygiene is complete when each feature file appears exactly once and each index entry resolves to one live file.

### 3. Inspect every feature from source

Partition source reading selectively. Use the coordinator for a small map or tightly coupled source. For a larger map with separable source areas, group related features and run at most four read-only delegates concurrently with `delegate_run`. Each delegate must own a feature group, not an individual feature. Give each delegate an explicit feature-file list and require this result for every assigned feature:

- user-facing behavior summary
- source entry points with file citations
- likely map drift, or `none`
- one concise live verification recipe

Delegates inspect source only. They do not drive the app or edit files. The coordinator reads any unassigned features and checks returned citations before accepting drift. Delegated reports are leads, not proof.

Also inspect recent relevant churn for user-facing behavior absent from the map. Call a feature missing only when a concrete source path establishes it. This step is complete when every indexed feature has a source summary and recipe, and every drift claim selected for action has been checked in source.

### 4. Plan one bounded live pass

Merge overlapping recipes into as few app states as practical while retaining one live exercise per feature. Follow the target skill's launch model:

- Keep one health-checked instance and drive it serially for servers and UIs.
- Use a fresh isolated session per drive for short-lived CLIs.

Keep concise scratch notes listing source coverage, planned drives, unreachable prerequisites, confirmed drift, and evidence paths. The plan is complete when every feature maps to a live drive and evidence check.

### 5. Drive every feature

The coordinator owns all live driving. Apply these invariants throughout the pass:

1. Run the target's doctor check before the first drive, for each fresh session when sessions are the unit, and after any failed or surprising drive. If doctor cannot detect a wedged UI state, reset to known state or relaunch.
2. Check captured evidence at the target's named location before cleanup. Evidence gathered so far must survive all cleanup.
3. Remove processes and scratch state when their drive no longer needs them. After a failed drive, clean its residue whether the session is shared, stuck, or exited. In a shared instance, remove only the failed drive's residue unless relaunch is required.

If the doctor or harness fails because its instructions drifted, correct it inside the edit boundary, restart only what the correction invalidated, and retry once. Re-drive every harness correction before retaining it.

Mark a feature `verified-unreachable` only after recording the route attempted and the concrete missing prerequisite, such as authentication, entitlement, operating system, or external state. An undocumented prerequisite is documentation drift. Otherwise, an unexercised feature blocks completion.

After all drives and correction re-proofs, run final teardown. Confirm evidence remains at its named location. The live pass is complete only when every feature was exercised or has a supported `verified-unreachable` record, no run-owned process or scratch state remains, and all retained harness corrections passed a live re-drive.

### 6. Reconcile and finish

Correct proven documentation and harness drift inside the edit boundary. Record product defects separately for the user. Re-read every changed file and inspect the diff for edits outside the boundary, stale instructions, unsupported commands, and accidental evidence or scratch files.

For `changed`, run the target skill's applicable checks and leave one coherent local change set. If the user explicitly authorizes a PR, create at most one PR containing only these proven corrections. Never merge or push beyond that authorization.

Report the outcome, source and live coverage for every feature, unreachable prerequisites, product defects, changed paths, evidence locations, cleanup result, and checks run. Do not claim `clean` if either source or live coverage is incomplete.
