---
name: maintain-verification-skill
description: Maintain a verification skill for named features or perform a full source-and-live audit when requested.
disable-model-invocation: true
---

# Maintain a verification skill

Infer the target and scope from the request. A full audit covers the entire feature map; named-feature maintenance covers those features and affected shared harness behavior. Ask only when the target cannot be inferred. If no verification skill exists, report that and point to `/create-verification-skill`.

Edit only the verification skill, its feature map, and its owned harness scripts. Report product regressions separately; do not change documentation to conceal them.

## Inspect

Read the index and relevant feature files. Inspect their implementation entry points, identify concrete drift, and prepare live recipes. Combine overlapping recipes into as few app states as practical. For a full audit, also inspect recent changes for missing user-facing paths.

## Drive and repair

1. Follow the skill's launch and isolation model. Check instance identity and readiness before the first drive.
2. Exercise each feature in scope and capture its relevant observable result, even when source inspection found no drift.
3. After a surprising failure, check instance health. Reset or relaunch owned state when a healthy process still has a wedged UI. Clean failed-attempt residue without destroying earlier evidence.
4. Fix proven documentation or harness drift within scope. Restart only what the fix invalidates and re-drive the affected path.
5. If a path is unreachable, record the attempted route and concrete missing prerequisite. Add omitted prerequisites to the map; do not count unreachable behavior as verified.
6. Tear down owned instances after the last drive and confirm the evidence remains at its named location.

Keep helpers executable and document their invocation. Reuse successful verification unless a subsequent change invalidates it.

## Deliver

Report the scope, coverage, corrections, and outcome: `clean`, `changed`, or `blocked`. Keep concise evidence notes in scratch storage. Report partial coverage when blocked.

For changed work, review the diff. Publish at most one PR when publishing is part of the task; otherwise deliver the local changes. A clean audit needs no branch or PR.
