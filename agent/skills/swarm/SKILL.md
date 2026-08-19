---
name: swarm
description: Use for bounded parallel delegation.
disable-model-invocation: false
user-invokable: false
---

# Swarm

Run one bounded wave of independent `delegate_run` children, drain every child, inspect their evidence, and return one consolidated result. The parent owns framing, integration, and final verification.

## Frame the wave

1. Write a done predicate that names the required coverage and final artifact.
2. Choose the shape before launching:
   - **Partition** when slices are independent and every slice must finish.
   - **Race** when several approaches to the same problem would reduce uncertainty. Choose `first pass`, `rank all`, or `best of` before launch.
   - **Mixed** when partitioned slices each benefit from a small race. State the selection rule for each raced slice.
3. Set a finite worker count from the real slices or race arms. Honor a user-specified count when safe. Otherwise use the smallest count that covers the plan, capped by the amount of independent work. Keep work in the parent when briefing and reviewing a child costs as much as doing it.
4. Define each child's exact ownership. Concurrent children may read shared files, but writes require disjoint owned paths. If build outputs or source ownership overlap, create one worktree per writer as described by `delegate-worktrees` and pass its path as `cwd`.
5. Reserve parent work: integration, evidence review, unresolved cross-slice decisions, and the final project check.

The frame is complete when every required slice maps to a worker, each race has a declared selection rule, and concurrent writes cannot collide.

## Launch

Issue one `delegate_run` call per child in the same parallel tool block. Use blocking calls when the parent has no useful work during the wave. Use `background: true` only when the parent can continue useful work before it needs the results.

Each brief must stand alone and include:

- objective and done predicate;
- relevant files and supplied facts;
- exact slice or race arm;
- mutation authority and owned paths;
- constraints and commands the child should use for focused verification;
- a compact result contract: `PASS`, `ISSUES`, or `BLOCKED`, changed paths, evidence with file locations, exact checks and results, and remaining gaps.

Children cannot delegate further. Do not assign dependent steps to separate children in the same wave. Chain those steps after inspecting the prerequisite result.

## Drain

Account for every launched child by id. For background work, continue parent work until blocked, then call `delegate_session` with `action: "wait"` for all outstanding ids together. Use `status` to inspect a slow child and `send` only when new context can unblock it.

A race rule does not leave workers running:

- `first pass`: accept the first result that meets the predicate, cancel remaining children, then wait until all ids are settled.
- `rank all` and `best of`: wait for every arm unless a child reaches its execution limit or cannot proceed.

Record failures, cancellations, timeouts, and missing slices. A dropout may reduce race confidence. It leaves a partition incomplete unless the parent covers or reassigns that slice.

The wave is drained only when every id is settled and no temporary child process remains.

## Inspect and integrate

Treat child reports as leads. Read each claimed artifact, diff, citation, or check output that affects the result. Reject unsupported conclusions and resolve contradictory reports against primary evidence. For writes, inspect each patch before integrating it, remove temporary worktrees after integration, and run the final relevant checks from the integrated parent worktree.

For a race, apply the declared rule rather than choosing the most polished report. Record why the selected arm met the predicate and what useful evidence from other arms changed the result.

## Report

Return one report, not raw child transcripts. Include:

1. a compact table with worker or slice, terminal status, and inspected evidence;
2. the integrated outcome and exact parent-run verification;
3. the declared race rule and selected arm when applicable;
4. consolidated gaps, including uncovered slices, dropouts, conflicting evidence, unverified claims, and residual risks.

Completion requires full slice accounting, every child drained, material evidence inspected, integrated checks run where writes occurred, and all gaps stated once in the consolidated list.
