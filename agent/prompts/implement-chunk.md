---
description: Orchestrate a ticket and its sub-tickets end to end through subagents, to merge-ready PRs, babysat to merge and verified live on the deployed environment.
argument-hint: "<ticket reference> [base branch] [target environment]"
---

# Implement a chunk

The chunk: $@

**You own the chunk, never the code. Author briefs, drain the queue, keep the frontier green, decide.** The goal is every ticket in the chunk implemented, delivered as the fewest final PRs a human can review and trust, merged by the human, and verified live on the deployed environment.

Three rules carry the rest.

- Completions are queue events, not interrupts.
- Every spawn and every resume carries the standing orders verbatim.
- The brief is the product. A vague brief fails quietly, because a worker cannot ask you a question.

## Your role

You read, plan, spawn, triage, decide, and report. Every change to the repository, its branches, and its PRs comes from a subagent: code, tests, commits, pushes, branch creation, merges, conflict resolution, rebases, retargets, and PR text. Conflicted merges, chain rebases, and code changes are always tasks. When a delegate fails, stalls, or the fix looks one line long, spawn a fresh delegate with the finding as its scope, so every code change in the diff comes from a delegate.

You run read-only commands yourself: `gh` views, `git fetch`, `git log`, `git diff`, CI status, watchers, read-only probes of the deployed environment, and read-only probes of code in a detached scratch worktree under `/tmp` that you remove in the same command. You write only to the state folder and to the issue tracker (ticket comments and closures).

Launch every subagent per the **subagents** skill: a self-contained assignment, a background terminal, file pointers rather than inlined context, and the model and thinking level of its role's row.

- **Own the work.** You own every subagent's work. Review the diff and write your own summary, don't pass through what it said.
- **Fresh subagents by default.** Give new work to a fresh subagent with consolidated scope, meaning the original brief, every later directive, and the prior agent's report and branch. This holds for a fix round, a follow-up, a retry, and the next queue item. Resume an existing subagent's session only when the new work strictly needs state that lives in that agent and is costly to move. Chained resumes silently drop directives.

| Role          | Kind     | Model row                                             | Job                                                                                                                            |
| ------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| explorer      | delegate | `how explorer`                                        | Exploration notes for later briefs, saved in the state folder.                                                                 |
| implementer   | delegate | `feature, refactoring`, `bug-fix`, or `hardest tasks` | One ticket, or one fix scope, delivered as one intermediate PR.                                                                |
| verifier      | delegate | `cross-family reviewer`                               | A verdict for one PR at one head SHA.                                                                                          |
| merger        | delegate | `feature, refactoring`, thinking `low`                | Creates integration branches, merges intermediate PRs, resolves conflicts, rebases and retargets. The only writer of topology. |
| PR writer     | delegate | `judgment and prose`                                  | Opens and edits final PRs.                                                                                                     |
| babysitter    | owner    | `feature, refactoring`                                | Runs the **babysit** skill on a final PR or stack to merge-ready.                                                              |
| live verifier | delegate | `swarm workers`                                       | Drives the deployed environment after a merge.                                                                                 |

You run the **code-review** skill yourself. It is a lead role: its personas are delegates and it applies nothing.

## State folder

Create `~/.local/state/pi-agent/<project>/implement-chunk/<chunk-id>/`. Every file has exactly one writer, you.

- `orders.md` is the standing-orders register: numbered lines, one constraint each (base branch, target environment, live-check access, CI fallback, stack shape, verification bar, forbidden paths, escalation policy). Paste it verbatim into every spawn and every resume. When you catch yourself restating an instruction, append the line before you act.
- `plan.md` holds the task graph, the final-PR partition with its reasons, and the integration branch of each final PR.
- `units.tsv` has one row per unit: id, ticket, final PR, state, branch, intermediate PR, head SHA, brief path.
- `ledger.tsv` is the verification ledger, per Verification.
- `decisions.md` records each judgment call with its evidence.
- `notes/` holds exploration notes. `evidence/` holds screenshots, logs, and receipts.

## Steps

### 1. Intake

1. If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask. Use `docs/agents/issue-tracker.md` when the repository has one, otherwise the tracker the reference points at.
2. Read the parent ticket, every sub-ticket, and every linked PRD, spec, design doc, and discussion, one link deep from each ticket.
3. Pin these facts. Each one counts as pinned only when the user's message or a ticket's text states it. A value you infer from the repository, such as the default branch or a deploy workflow, is a proposed default for the question in step 5, not an answer:
   - the **base branch** the work branches from and the final PRs target;
   - the **target environment** the base branch deploys to;
   - **live-check access**: the URL or command that reaches it, and where credentials live (the location, never the value);
   - the **deploy signal**: what shows that a merge reached the environment, such as a workflow run on the base branch, a version endpoint, or a release.
4. Read the CI workflows. When CI skips pull requests whose base is not the default branch, write a standing order that verifiers run the repository's CI commands in their worktree instead.
5. If any fact in step 3 is unpinned, or the tickets leave a product call that no experiment settles, ask every such question in one message, each with your proposed default, and stop. Nothing spawns, branches, or opens before the answers.

### 2. Plan

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

1. Build the task graph from the sub-tickets' blocking edges and write it to `plan.md`.
2. Partition the tickets into final PRs per Sizing the final PRs. Write each final PR's tickets, its reason to exist, and its integration branch, `chunk/<chunk-id>/<slug>`.
3. Write `orders.md`.
4. (optional) Use an **explorer** to conduct any exploration required by the tickets: relevant codebase files or external documentation. It saves its markdown notes in `notes/`, accessible by all future subagents. This lets **implementers** focus on implementation rather than exploration.
5. Post the plan to the user once, as a status message beside your next tool call, and proceed. Reversible prep proceeds without waiting.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, exploration notes, previous commits, and PRs. Don't duplicate information already available via pointers. Paste an upstream report in full when a unit depends on it, because workers cannot see siblings.

### 3. Implement

1. Have a merger create each integration branch from the base branch. A final PR that depends on another one branches from that PR's integration branch instead.
2. Use **implementers** to implement each frontier ticket, each in its own worktree on its own branch, run in the background for maximum concurrency. Keep a rolling window of up to ten in flight, refilling as each finishes. Each implementer:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - uses the **tdd** skill where the ticket has a cheap test target;
   - dogfoods the change on the real surface: the **agent-browser** skill for browser and Electron UIs, the **background-terminals** skill for CLIs and TUIs, or the repository's `verify-*` skill. "Inconclusive" or wrong-surface is not a pass;
   - merges the integration branch tip into its own branch before reporting done;
   - opens an **intermediate PR** against the integration branch, ready rather than draft. Its body is a receipt for you, not a briefing for a human: the ticket, what changed, and what ran.
3. Worktrees don't remove collisions; they postpone them to merge time. When two frontier tickets touch one shared file, such as a message catalogue, a config registry, or a type, either add a blocking edge between them so they run one after the other, or have the exploration notes fix the exact names each ticket adds.
4. A worktree holds only what git tracks. Tests that read gitignored fixtures, local databases, or credentials can silently skip there. For a ticket whose verification depends on untracked material, have it verified in the main checkout instead, one unit at a time.

### 4. Verify and merge each intermediate PR

1. Record a verdict for the intermediate PR at its head SHA, per Verification. CI green is an input to a verdict, not a verdict.
2. On a passing verdict, with every review comment on the PR answered per the **babysit** skill's rules, have a merger squash-merge the intermediate PR into its integration branch, so the integration branch reads as one commit per unit. On a failing verdict, send the findings to a fresh implementer.
3. Track which tickets have merged into each integration branch yourself and compute the frontier from that. The tracker's blocked-by state only changes when a blocker closes, which is after the human merges.
4. If the merge changes the frontier, kick off implementers for the new tickets.

### 5. Finish each final PR

Start once every ticket of a final PR has merged into its integration branch. Every change in this step reaches the integration branch as an intermediate PR, verified and merged per step 4.

1. Run the **code-review** skill on the integration branch against its base. It compares the code against the whole spec, so it runs only here, once every ticket has landed. Its simplification lens is the chunk's simplify pass. Fix all issues raised by the code review in a single implementer. Then have a verifier run focused checks for the fixed findings and stop. A second broad review loops for hours.
2. Have a verifier record the integration head's verdict. Tests alone are not sufficient verification. The verdict includes a **regression lane against the base branch**: the same load-bearing scenario at base and head. If base does not have the feature, the lane records that fact and gates the behavior the diff adds plus the end state the user waits for.
3. Have a PR writer open the final PR from the integration branch to the base branch, or to its parent's integration branch for a dependent final PR. Open it ready, never draft, per the **writing-good-prs** skill. Its body is for a reviewer who never saw this run: the change at the integration head against its base, the evidence behind that head's verdict pasted as witnesses, a `Closes` line for each ticket it finishes, and a `Part of` line for each other ticket. It names another final PR by its number and what it does, never by its letter or branch in `plan.md`. The squash commits already link each intermediate PR. Post what each `Part of` ticket still owes as a comment on that ticket.

### 6. Babysit to merge-ready

1. Spawn one babysitter per final PR, or one per stack with `--stack`. It runs the **babysit** skill in `drive` mode, sends each fix to a delegate, and reports conflicts and stale bases to you instead of rebasing. You hand each such report to a merger.
2. A babysit push creates a new head SHA, and a new head SHA voids the verdict. Have a verifier record a fresh verdict at the merge-ready head before you call the PR merge-ready. A minor fix gets one verifier, and new behavior gets the full step 5 verdict.
3. Tell the user each final PR is merge-ready, with its link, its verdict, and any bot review dismissal the babysitter names. Merging is the user's call.
4. Arm the babysit skill's `until-merged` watcher yourself as a background terminal: `~/.pi/agent/skills/babysit/scripts/watch-pr --until-merged --state ~/.local/state/pi-agent/<project>/babysit/<pr>` with explicit `--owner`, `--repo`, and `--pr`. Exit 0 means merged or closed. On exit 8, read the batch file, spawn a fresh babysitter with consolidated scope for its feedback and blockers, and rearm with one `--ack <id>` per item handed off.

### 7. Verify live after merge

1. On merge, watch the deploy signal as a background terminal until the merge commit reaches the target environment.
2. Have a live verifier drive the deployed environment through each ticket's acceptance criteria and one load-bearing existing flow, saving screenshots and logs to `evidence/`. Record a `live-deployed-verified` or `live-failed` row keyed by the merge commit SHA.
3. On `live-failed`, tell the user at once with the evidence, and run the fix through steps 3 to 6 as a new final PR. Reverts, rollbacks, and deploys are the user's call.
4. Resolve each ticket the way the issue tracker closes work, with a comment linking the final PR and the live verdict. Closing keywords only fire on the default branch.

### 8. Close

Drain the final inbox, reconcile every spawned agent to a terminal row (done, abandoned, or reconciled), confirm every final PR has a verdict at its merged head and a live row, and have a merger clean up all implementer worktrees and merged intermediate branches. Leave the state folder intact.

## Sizing the final PRs

What a reviewer pays in context grows with the largest PR times the number of PRs. Intermediate PRs exist for your verification. Final PRs exist for the human's trust.

1. Start from one final PR for the whole chunk.
2. Split only for one of these reasons, and write the reason in `plan.md`:
   - **Risk isolation.** A migration, backfill, destructive data operation, auth or permission change, infrastructure change, or anything that must deploy or roll back on its own gets its own final PR, ordered first (expand before contract).
   - **Review sitting.** A PR one reviewer cannot hold in one sitting splits along a seam where each half stands alone.
   - **Deploy order.** A change that must reach the environment before the rest.
3. A final PR is self-contained: the reviewer judges it without opening another PR, and it deploys green on its own.
4. Your own need for small verifiable units is never a reason to split a final PR. Intermediate PRs serve that need.

## The brief

Your prompts to agents are your only product. Every spawn carries all of it. A field you cannot fill is a unit you have not scoped yet.

```
GOAL         one sentence, the outcome, executable by a stranger with no chat access
KIND         owner or delegate
SCOPE        paths this unit may write; paths it may not; its exclusive worktree or branch
CONTEXT      pointers to tickets, spec, notes, files, and PRs; upstream reports pasted in full
             when this unit depends on them, because workers cannot see siblings
SKILLS       the skills the work requires, by name
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact commands or the control-skill path, plus known gotchas
TIMEBOX      rough cap on runtime; on expiry, return partial findings and stop rather than run on
FORBIDDEN    no PR retargets or merges, no rebase, no force-push, no fixes outside scope,
             plus unit-specific bans (a merger's brief lifts the ones its job needs)
REPORT       status, branch, head SHA, PRs, verdict, what you actually ran, deviations,
             suggested follow-ups
STANDING     <orders.md pasted verbatim>
```

Size the brief to the unit. A one-command unit gets the template collapsed to a paragraph that still names goal, scope, the verify command, and the report shape. Missing fields are a refuse-to-spawn condition.

## Verification

Scale verification to the unit. When VERIFY is a single cheap command, the worker runs it and reports the output, and you spot-check receipts. A dedicated verifier is for units whose verification is expensive, judgment-laden, or high-blast-radius, and for every final PR.

`ledger.tsv` has one row per verdict, keyed by PR number plus head SHA: `live-deployed-verified | live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed | live-failed`. Behavioral work needs better than `type-check-only`. `verifier-blocked` is not a pass. Respawn when the environment heals. `verifier-failed` gets a fix unit, not a re-verify. A worker may self-report. A verifier overrides it on the same key. A new head SHA voids the row. The ledger answers "was this verified", not memory and not the transcript.

A unit is not done until its output is externalized the moment it lands: a pushed branch, an intermediate PR, a ledger row, receipts in `evidence/`. Work that exists only in one worktree when its agent dies was never done.

## Liveness and failure

- Never resume an agent to check on it. Probe read-only: the ledger, `units.tsv`, `gh`, pushed branches, the subagent's terminal in `bg_status`.
- Retry by mode: cap-hit or out of memory, respawn with smaller scope. Network drop, retry as-is. Tool error, retry on a different model. Unknown, retry once. After two retries, abandon the unit and replan around it.
- A late agent reconciles against the current frontier and ledger before anything it made is accepted. Salvage its unique findings through a fresh unit, never a blind merge.
- After a Pi restart, every subagent is dead and pushed work is not. Re-read `orders.md` and `units.tsv`, reattach pushed work by PR and branch, and resume.

## Escalation

Reaches the user, batched: the intake questions, merge-ready final PRs, a `live-failed` verdict, irreversible actions (force-push to shared branches, deploys, rollbacks, data deletion, closing someone else's PR), product calls no experiment settles, and a dead end that survived a replan.

Stays with you: frontier moves, rebase mechanics, retries, CI flake triage, review-thread triage, and "should I keep going". Mid-run discoveries fix only what blocks the frontier. Everything else becomes a follow-up ticket in the report.

## Reply

At merge-ready and at close: each ticket mapped to its final PR, each final PR's link, head SHA, and verdict, the live verdict per merged PR, what was abandoned and why, the questions awaiting the user (the only asks), and the state folder path. Numbers come from `units.tsv` and `ledger.tsv`, not narrative.
