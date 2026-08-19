---
name: show-me-your-work
description: Use for decision trails in long unattended or multi-phase work.
disable-model-invocation: false
user-invokable: false
---

# Show me your work

Keep one append-only decision trail when a reviewer will need to reconstruct a long run without rereading the whole session. This is for consequential choices and checkpoints, not an activity diary.

## Start the trail

Copy [`references/decision-log-template.tsv`](references/decision-log-template.tsv) to `decisions.tsv` in the work directory. When several efforts share a directory, use `.audit/<task-slug>.tsv` instead.

Keep the trail local and out of git by default. Commit it only when the user asks or when the deliverable explicitly requires a durable audit artifact. Committing, pushing, opening a PR, and other outward actions still follow the task's approval rules.

The columns are:

- `ts`: UTC ISO 8601 timestamp.
- `phase`: phase or workstream.
- `decision`: the choice or completed checkpoint.
- `why`: the concrete reason.
- `evidence`: a short pointer such as `file:line`, a check result, commit, issue, trace, or artifact path.
- `result`: the observed state, such as `tests pass`, `reverted`, `INCONCLUSIVE`, or `open`.

Use `scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>` to append a row. The helper keeps cells on one line and neutralizes spreadsheet formulas. Apply the same protection if another writer creates rows from generated or user-controlled text.

## What earns a row

Log a row when it changes how a later reviewer judges the work:

- a meaningful fork and why one path won;
- a phase gate and its verification result;
- a pivot, revert, or rejected delegated result and its trigger;
- a blocker or unresolved risk;
- one summary row for a bounded iteration.

Skip file reads, routine edits, ordinary commands, repeated passing checks, and facts already obvious from the diff. Evidence is a pointer, not a paragraph. Keep every cell to one line.

Append corrections as new rows. Preserve earlier rows so the trail shows the actual sequence, including wrong calls.

## Close the trail

Before handoff, audit the trail against the active Pi session and the produced artifacts.

Use the current session path when the runtime provides it. Otherwise, Pi stores sessions under `~/.pi/agent/sessions/<workspace-key>/*.jsonl`, where the workspace key encodes the working directory. Locate only the current workspace's directory, choose the active or newest matching session, and confirm its working directory and task before reading it. Do not scan session directories for other workspaces.

Check that:

- every row maps to an action or checkpoint in this run;
- every evidence pointer resolves and supports the claim;
- consequential forks, abandoned approaches, and open risks have rows;
- routine activity and aspirational claims have no rows.

Add a correcting row rather than rewriting history. If a wrong row contains sensitive text, remove or redact it and disclose that exception at handoff.

## Conditional fresh review

Use a bounded reviewer on a different model family only when one is available and the trail covers high-risk, hard-to-reverse, disputed, or materially uncertain work. Ask it to inspect the trail, the current session, and cited evidence for unsupported claims, skipped verification, risky choices, and missing pivots. Treat its report as evidence to verify, not proof.

Skip cross-model review for ordinary low-risk trails, when no different model family is available, or when the review would expose session data outside the local environment. Record whether review ran and any verified flags in the handoff. Do not turn this into a redo of the work.
