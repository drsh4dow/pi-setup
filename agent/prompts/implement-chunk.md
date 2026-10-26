---
description: Orchestrate a task chunk end to end through subagents, to merge-ready PRs, babysat to merge and verified live on the deployed environment.
argument-hint: "<ticket reference> [base branch] [target environment]"
---

# Implement a chunk

The chunk: $@

**You own the chunk, never the code. Author briefs, drain the queue, keep the frontier green, decide.** The goal is every ticket in the chunk implemented in the project's domain language, delivered as the fewest final PRs a human can review and trust, merged by the human, and verified live on the deployed environment.

Three rules carry the rest.

- Completions are queue events, not interrupts.
- Every spawn and every resume attaches `orders.md` at launch, so each subagent reads the standing orders as they stand.
- The brief is the product. A vague brief fails quietly, because a subagent cannot ask you a question.

## Your role

You read, plan, spawn, triage, decide, and report. A **unit** is the scope of one brief: a ticket, a chain, a fix scope, a merge, or a verdict. Every change to the repository, its branches, and its PRs comes from a subagent: code, tests, commits, pushes, branch creation, merges, conflict resolution, rebases, retargets, and PR text. When a subagent fails or stalls, or the fix looks one line long, a fresh subagent takes the finding as its unit.

You run read-only commands yourself: `gh` views, `git fetch`, `git log`, `git diff`, CI status, watchers, read-only probes of the deployed environment, and read-only probes of code in a detached scratch worktree under `/tmp` that you remove in the same command. You write only to the state folder and to the issue tracker (ticket comments, state restores, and closures).

Launch every subagent with the **subagents** skill's brief launcher, `~/.pi/agent/skills/subagents/scripts/launch.ts`, at its role's model row, with `--role` set to the role's name below (hyphenated, such as `pr-writer`) and `--orders <state folder>/orders.md`. Pass context as pointers to the spec, tickets, notes, commits, and PRs, never as copies of them.

- **Own the work.** Review each subagent's diff and write your own summary rather than passing its report through.
- **Fresh subagents by default.** Give new work, whether a fix round, a follow-up, a retry, or the next queue item, to a fresh subagent with consolidated scope: the original brief, every later directive, and the prior subagent's report and branch. Resume a session only when the work strictly needs state that lives in that session and is costly to move. Chained resumes silently drop directives.

Roles, with kind and model row:

- **explorer** (delegate, `modeler` for contract notes and statecharts, `mapper` for exploration notes): notes saved in `notes/`.
- **implementer** (delegate, `feature, refactoring`, `bug-fix`, or `hardest tasks`): one ticket, chain, or fix scope, delivered as one intermediate PR.
- **verifier** (delegate, `cross-family reviewer`, against the family of the PR's implementer): a verdict for one PR at one head SHA.
- **merger** (delegate, `feature, refactoring`): the only writer of topology. It creates integration branches, merges intermediate PRs, resolves conflicts, rebases, and retargets.
- **PR writer** (delegate, `judgment and prose`): drafts, opens, and edits final PRs.
- **babysitter** (owner, `feature, refactoring`): runs the **babysit** skill on a final PR or stack to merge-ready.
- **live verifier** (delegate, `cross-family reviewer`): drives the deployed environment after a merge.

You run the **code-review** skill yourself. It is a lead role: its personas are delegates and it applies nothing.

## State folder

Create `~/.local/state/pi-agent/<project>/implement-chunk/<chunk-id>/`. You are the only writer of every file in it. The **chunk id** is a short slug of the parent ticket's title, such as `length-conversion`, never its key: it names each integration branch, which heads a final PR, and the tracker moves any ticket a PR's branch names.

- `orders.md` holds the **standing orders**: numbered lines, one constraint each (base branch, target environment, live-check access, CI fallback, stack shape, verification bar, forbidden paths, escalation policy). The launcher appends it to the system prompt of every spawn and resume, so each subagent reads the file as it stands when it starts. When you catch yourself restating an instruction, append the line before you act. Tag each line with its source: `user` with its `decisions.md` entry for a user decision quoted verbatim, `verified at <ref>` for a repository fact, or `hypothesis` for your own inference, which a subagent checks before relying on it.
- `plan.md` holds the task graph, the Terms, the final-PR partition with its reasons, and the integration branch of each final PR.
- `units.tsv` has one row per unit. A chain takes one row per ticket instead, with id `<chain>/<ticket>` and the chain's branch, intermediate PR, and brief on each. `units.tsv` columns: `id ticket intake_state final_pr state branch intermediate_pr head_sha brief`. `intake_state` is the ticket's tracker state at intake. `final_pr` reads `-` until the final PR opens, then its number, `owner/repo#<n>`, or URL. `units.tsv` states: `planned running pr-open merged done abandoned reconciled`. A unit is `planned` once its brief is saved, `running` once launched, and `pr-open` while its intermediate PR waits on a verdict or a merge. It ends `merged` when that PR merges into its integration branch, `done` when a unit with no PR delivers its notes, verdict, or merge, `abandoned` after its retries, or `reconciled` when a late subagent's work is settled per Liveness and failure. Write it only with `chunk unit add <id> <column>=<value>...` and `chunk unit set <id> <column>=<value>...`, where `chunk` stands for `~/.pi/agent/prompts/implement-chunk/scripts/chunk.ts --state <state folder>`. Every `chunk` command exits 0 when clean, 1 on a violation, and 2 when it refused the input or could not run. On 2, fix what its message names and rerun.
- `ledger.tsv` is the verification ledger, written only with `chunk ledger`, per Verification.
- `decisions.md` records each judgment call with its evidence.
- `notes/` holds contract notes and exploration notes. `evidence/` holds screenshots, logs, and receipts.

## Steps

### 1. Intake

1. Fetch the ticket reference from the issue tracker, per `docs/agents/issue-tracker.md` when the repository has one, and state its title before starting. Ask if the reference is ambiguous.
2. Read the parent ticket, every sub-ticket, and every linked PRD, spec, design doc, and discussion, one link deep from each ticket. Record each ticket's tracker state in `units.tsv`. Check that each ticket is ready, per the **writing-good-tickets** skill: it states its blocking edges and its Done-when items, each with the check that shows it. Draft a rewrite for each ticket that falls short, for step 5. A spec not yet split into tickets goes back to the user for the **to-tickets** skill. Briefs copy ACCEPTANCE from the Done-when items, never from your own reading.
3. Pin these facts, per repository when the chunk spans several. A fact is pinned only when the user's message or a ticket's text states it. A value you infer from the repository, such as the default branch or a deploy workflow, is a proposed default for step 5, not an answer:
   - the **base branch** the work branches from and the final PRs target;
   - the **target environment** the base branch deploys to;
   - **live-check access**: the URL or command that reaches it, where credentials live (the location, never the value), and how to read their expiry. Refresh a credential before spawning a unit whose TIMEBOX outlasts it;
   - the **deploy signal**: what shows that a merge reached the environment, such as a workflow run on the base branch, a version endpoint, or a release;
   - **sandbox access** for each external service whose contract suite the repository's verification skill lists: where its credentials live (the location, never the value), how to read their expiry, and whether a worktree sees them.
4. For each repository, read its agent and rule files (`AGENTS.md`, `CLAUDE.md`, and any rule folder they name), its domain docs (`GLOSSARY.md`, or each `GLOSSARY.md` a `GLOSSARY-MAP.md` names, and the ADRs in the area the tickets touch, per its `docs/agents/domain.md` when present), its CI workflows, its verification skill (`.agents/skills/verify-*/`, with its feature map and the contract suites it lists), each project-local skill that model-checks or proves code in the area the tickets touch, and its merge settings from `gh api repos/<owner>/<repo>` (allowed merge methods, `delete_branch_on_merge`, `archived`). Write each constraint that shapes a brief as an order, such as a CI gate that rejects edits to existing files, verifiers running CI's commands in their worktree when CI skips PRs off the default branch, or the verification skill and model checks each ticket's drive goes through.
5. Ask in one message, each with your proposed default: every unpinned fact in step 3, every ticket rewrite from step 2 shown inline, every new domain concept the tickets introduce whose name the glossary does not settle, every ADR a ticket would contradict, every product call no experiment settles, and which publication classes are pre-approved (receipt bodies, templated ticket comments, factual refreshes of PR text, follow-up tickets). In the same message:
   - When the repository has no verification skill, ask whether to create one first, as a unit ahead of the first implementer that follows `~/.pi/agent/skills/create-verification-skill/SKILL.md`. Without one, each implementer drives the app by hand its own way.
   - For each lifecycle, protocol, or state machine a ticket adds or changes, have an explorer draw its chart into `notes/` with the **statechart** skill's chart-to-spec direction, and ask the user to agree to it. Show its Mermaid source and its rules inline, and open its PNG.

   Record the publication answer verbatim as an order, then stop. Nothing spawns, branches, or opens before the answers, except explorers that write only to the state folder.

### 2. Plan

The tickets form a **task graph** of blocking edges, not a list of steps. Its **frontier** is the tickets ready to start.

1. Build the task graph from the sub-tickets' blocking edges and write it to `plan.md`.
2. Write the **Terms** in `plan.md`: each domain concept the tickets touch, by its glossary term; each new concept, by the term the user settled or your default, assigned to the one ticket whose implementer adds it to the glossary per the **domain-modeling** skill; and each ADR the tickets touch. Names in code, routes, fields, tests, commits, and PR text follow the Terms.
3. Partition the tickets into final PRs per Sizing the final PRs. Write each final PR's tickets, its reason to exist, and its integration branch, `chunk/<chunk-id>/<slug>`.
4. Collapse each **chain**: a run of tickets in one final PR where each ticket after the first has the one before as its only blocker, and each ticket before the last blocks only the next. Handing such tickets to separate implementers adds a spawn, a merge, and a fresh read of the code between tickets that could never run at once. One implementer takes the chain as one unit instead, in ticket order, in one worktree, with one commit per ticket, and keeps the domain in context throughout. A chain unit starts when its first ticket reaches the frontier. Split a chain that one TIMEBOX cannot cover into consecutive chain units. Write each chain in `plan.md`.
5. Write `orders.md`.
6. When two tickets in different units can run at once, or touch one shared file such as a message catalogue, a config registry, or a type, have an **explorer** write **contract notes** to `notes/contract.md`: for each ticket, the seam its tests run at, the data shape it adds and the structure that organizes it (per the **principle-model-the-domain** skill), and the exact names it adds to each shared file, in the Terms. Worktrees postpone collisions to merge time, and contract notes prevent them. Where no contract note settles a shared file, add a blocking edge between the two tickets. Each chart the user agreed to at intake is a contract note too: the briefs of its tickets point to it, their tests cover its paths, and their drives check its rules. An explorer may also save notes on the code and docs the tickets need.
7. Post the plan to the user once, as a status message beside your next tool call, and proceed. Reversible prep proceeds without waiting.

### 3. Implement

1. Have a merger create each integration branch from the base branch. A final PR that depends on another one branches from that PR's integration branch instead.
2. Have **implementers** take the frontier tickets, each in its own worktree on its own branch, each to the Definition of Done in the brief reference. Each delivers an **intermediate PR** against its integration branch.
3. When four or more tickets are ready at once, spawn one first as a **pilot**, and fan out once its intermediate PR has a passing verdict. Fix the brief template or the contract notes from what the pilot showed before the rest spawn.
4. Keep a rolling window of up to ten implementers: when one finishes, spawn the next ready ticket in the same turn you record the completion. The launcher holds each spawn while the one-minute load exceeds `nproc` or `MemAvailable` falls below `--min-mem-gib`, which you size to the unit's heaviest gate. Both count every local process: personas, verifiers, builds, and containers.
5. A worktree holds only what git tracks, so tests that read gitignored fixtures, local databases, or credentials can silently skip there, and so can contract suites that need sandbox credentials. Verify a ticket that depends on untracked material in the main checkout, one unit at a time.

### 4. Verify and merge each intermediate PR

1. Wait on CI yourself: arm `gh pr checks <pr> --watch` as a background terminal, and spawn the verifier, merger, or fixer only once checks settle. Record a verdict for the intermediate PR at its head SHA, per Verification. CI green is an input to a verdict, not a verdict.
2. On a passing verdict, with every review comment on the PR answered per the **babysit** skill's rules, have a merger merge the intermediate PR into its integration branch with `--match-head-commit <verdict SHA>` and a method the repository allows: squash when allowed, so the branch reads as one commit per ticket, except for a chain, which takes a merge commit when allowed, so its per-ticket commits survive. On a failing verdict, send the findings to a fresh implementer. After each intermediate merge or close, re-read only the tickets that PR's unit names and the parent ticket, and restore the state `units.tsv` recorded.
3. Compute the frontier yourself from the tickets merged into each integration branch. The tracker's blocked-by state changes only when a blocker closes, after the human merges.
4. If the merge changes the frontier, spawn implementers for the new tickets.

### 5. Finish each final PR

Start once every ticket of a final PR has merged into its integration branch. Every change in this step reaches the integration branch as an intermediate PR, merged per step 4.

1. Run the **code-review** skill on the integration branch against its base. It compares the code against the whole spec, so it runs only here. Its simplification lens is the chunk's simplify pass. Have one implementer fix every finding, with focused checks for each fixed finding as its VERIFY, and record its self-reported row as the fix PR's verdict. Then stop. A second broad review loops for hours.
2. Have a verifier record the integration head's verdict, with a witness per Verification for each lane. This verdict covers the fix round. It includes a **regression lane against the base branch**: the same load-bearing scenario at base and head. If base does not have the feature, the lane records that fact and gates the behavior the diff adds plus the end state the user waits for.
3. While that verifier runs, have a PR writer draft the final PR's body to a file, then have a `cross-family reviewer` delegate run the expert read the writer hands back. Once the verdict lands, have a fresh PR writer apply the expert read, paste the verdict's witnesses, and open the final PR, ready, from the integration branch to the base branch, or to its parent's integration branch for a dependent final PR. Post what each `Part of` ticket still owes as a comment on that ticket.

### 6. Babysit to merge-ready

1. Spawn one babysitter per final PR, or one per stack with `--stack`. It runs the **babysit** skill in `drive` mode, sends each fix to a delegate, and reports conflicts and stale bases to you instead of rebasing. Hand each such report to a merger.
2. A babysit push creates a new head SHA, which voids the verdict unless its tree is unchanged. Have a verifier record a fresh verdict at the merge-ready head before you call the PR merge-ready: one verifier for a minor fix, the full step 5 verdict for new behavior.
3. Run `chunk report` and paste its output to the user, with any bot review dismissal the babysitter names. Call a final PR merge-ready only where the report's Merge-ready column says `yes`. Merging is the user's call.
4. Arm the babysit skill's `until-merged` watcher yourself as a background terminal: `~/.pi/agent/skills/babysit/scripts/watch-pr --until-merged --state ~/.local/state/pi-agent/<project>/babysit/<pr>` with explicit `--owner`, `--repo`, and `--pr`. Exit 0 means merged or closed. On exit 8, read the batch file, spawn a fresh babysitter with consolidated scope for its feedback and blockers, and rearm with one `--ack <id>` per item handed off.

### 7. Verify live after merge

1. On merge, watch the deploy signal as a background terminal until the merge commit reaches the target environment.
2. Have a live verifier drive the deployed environment through each ticket's Done-when items and one load-bearing existing flow, saving screenshots and logs to `evidence/`. Record a `live-deployed-verified` or `live-failed` row keyed by the merge commit SHA.
3. On `live-failed`, tell the user at once with the evidence, and run the fix through steps 3 to 6 as a new final PR. Reverts, rollbacks, and deploys are the user's call.
4. Resolve each ticket the way the issue tracker closes work, with a comment linking the final PR and the live verdict, then confirm the state it landed in, since an integration may already have moved it (step 4.2).

### 8. Close

Drain the final inbox, reconcile every spawned subagent to a terminal row (`merged`, `done`, `abandoned`, or `reconciled`), confirm every final PR has a verdict at its merged head and a live row, and have a merger clean up all implementer worktrees and merged intermediate branches. List every order line that is not specific to this chunk, and propose each to the user as an edit to this prompt or to the project's agent files. Propose `~/.pi/agent/skills/maintain-verification-skill/SKILL.md` for each drift between the verification skill and the app that a unit reported, `~/.pi/agent/skills/maintain-formal-verification-skill/SKILL.md` for each stale formal check, and `~/.pi/agent/skills/create-formal-verification-skill/SKILL.md` for each order-dependent area no project model covers. Leave the state folder intact.

## Sizing the final PRs

Intermediate PRs exist for your verification. Final PRs exist for the human's trust.

1. Start from one final PR for the whole chunk, or one per repository when it spans several.
2. Split only for one of these reasons, and write the reason in `plan.md`:
   - **Risk isolation.** A migration, backfill, destructive data operation, auth or permission change, infrastructure change, or anything that must deploy or roll back on its own gets its own final PR, ordered first (expand before contract).
   - **Review sitting.** A PR one reviewer cannot hold in one sitting splits along a seam where each half stands alone.
   - **Deploy order.** A change that must reach the environment before the rest.
3. A final PR is self-contained: the reviewer judges it without opening another PR, and it deploys green on its own.
4. Your own need for small verifiable units is never a reason to split a final PR. Intermediate PRs serve that need.

## The brief

Write each **brief** from the template and its role variant in `~/.pi/agent/prompts/implement-chunk/brief.md`. A field you cannot fill is a unit you have not scoped yet. Save the brief as a file in the state folder and spawn it with the launcher, which is the brief check: it refuses with exit 2, and starts no subagent, a brief that is missing or empty, lacks a field its role needs, keeps a placeholder (`<…>`, `${…}`, `undefined`), or names an input branch that `origin` lacks. On exit 2, fix the brief it names and launch again. Check each path the brief names yourself (`test -e`). It also holds the spawn while the host is saturated, per step 3.4.

## Verification

Scale verification to the unit. When VERIFY is a single cheap command, the implementer runs it and reports the output, and you spot-check receipts. A dedicated verifier is for units whose verification is expensive, judgment-laden, or high-blast-radius, and for every final PR.

A **witness** runs the artifact the deploy builds, on the deploy's runtime, with an input shown to reach the changed path. A dev server, a read of framework source, or a count over requests that never reached the change is not one. A lane records `not run` only with your sign-off in `decisions.md`.

`ledger.tsv` has one row per **verdict**, keyed by PR plus head SHA, labelled only with an outcome from the brief reference's Ledger outcomes. `ledger.tsv` columns: `pr head_sha outcome evidence recorded_at`. Record each verdict with `chunk ledger record <pr> <sha> <outcome> <evidence>`, which refuses any other label. The last row on a key stands. A new head SHA voids the row, unless its tree equals a verified SHA's tree, as after a squash merge of a PR that had merged the integration tip. Then run `chunk ledger carry <pr> <new-sha> <from-sha> -C <checkout>`: it compares the trees, records the row again at the new SHA with `carried from <sha>` as its evidence, and exits 1 when the trees differ. An outcome whose Merge-ready is `if cited` counts only when its evidence names its `decisions.md` entry or its run logs under `evidence/`. Record each verdict you overrule in `decisions.md`, and when a ruling recurs, fix the verifier brief before the next verifier spawns. The ledger answers "was this verified", not memory and not the transcript.

## Liveness and failure

- Never resume a subagent to check on it. Probe read-only: the ledger, `units.tsv`, `gh`, pushed branches, the subagent's terminal in `bg_status`.
- Retry by mode: cap-hit, or out of memory on an idle host, respawn with smaller scope. An OOM kill while the host was loaded is a scheduling signal: respawn as-is once step 3.4 admits it. Network drop, retry as-is. Tool error, retry on a different model. Unknown, retry once. After two retries, abandon the unit and replan around it.
- A late subagent reconciles against the current frontier and ledger before anything it made is accepted. Salvage its unique findings through a fresh unit, never a blind merge.
- After a Pi restart, every subagent is dead and pushed work is not. Re-read `orders.md` and `units.tsv`, reattach pushed work by PR and branch, and resume.

## Escalation

Reaches the user, batched: the intake questions, merge-ready final PRs, a `live-failed` verdict, irreversible actions (force-push to shared branches, deploys, rollbacks, data deletion, closing someone else's PR), product calls no experiment settles, a premise finding that would change a contract note, an ADR, or product behavior, and a dead end that survived a replan.

Stays with you: frontier moves, rebase mechanics, retries, CI flake triage, review-thread triage, replans for a premise finding inside the contract notes, and "should I keep going". Mid-run discoveries fix only what blocks the frontier. Everything else becomes a follow-up ticket in the report, including each bug a drive found that the base branch has too.

End every message to the user with each open ask restated in full until it is answered. Show a draft inline or open it, never as a bare path. Send status only on a state change.

## Reply

At merge-ready and at close, paste the output of `chunk report`: one row per ticket in merge order, with its final PR's link, head SHA, verdict at that head, requested reviewers, merge state, merge readiness, and live verdict. A PR the report marks other than `yes` or `merged` is not merge-ready, whatever the transcript says. Then add what was abandoned and why, the questions awaiting the user (the only asks), and the state folder path.
