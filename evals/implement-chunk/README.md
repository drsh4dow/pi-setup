# Implement chunk

Runs [`agent/prompts/implement-chunk.md`](../../agent/prompts/implement-chunk.md) end to end, with
real subagents, on an offline fixture chunk with planted traps. It compares harness checkouts
(arms), 3 trials each.

## Question

Does a revised `implement-chunk.md`, with its dependencies, run a ticket chunk to merged,
live-verified PRs with fewer avoidable units and fewer human turns, without losing correctness,
compared with the prompt on `main`? Layer 1 (`evals/worker-questions/`) measures one worker against
a simulated parent. This eval, layer 2, measures the whole orchestrator. The 2026-10-23 dogfood run
took 1 h 37 min and $8.50 at the root alone, so the eval is designed for 3 trials per arm, at most
two running at a time.

## Arms

`--arms name=<harness checkout>,...`. `baseline` is a checkout of `main`, and `candidate` is the
revised worktree. A third arm is more configuration. The grader reads every other arm against
`baseline`.

Each run gets its own home directory (`home.ts`), and every process of the run, the root and every
`pi-subagent` child, gets `HOME` pointed there. The fake home links every entry of the real home
except `.pi` and `.local`. Its `.pi/agent` holds copies, not links: `SYSTEM.md`, `skills/`,
`prompts/`, and any file only the arm has come from the arm, and the live agent directory's other
entries (settings, extensions, MCP servers) from the live one. Only `auth.json` and `mcp-auth.json`
stay links, so a token the run refreshes reaches the real file. `sessions/` is fresh. Outside
`agent/`, the home's `.pi` has only what Pi needs: links to the live checkout's `.build/`
(`pi-subagent`, `emit-to-pi`, which `build-bin-path.ts` finds next to the copied extensions),
`node_modules/` (the extensions' packages), and `package.json`. It has no `.git`, and
`GIT_CEILING_DIRECTORIES` stops a git started inside those links from climbing into the live
repository. `.local/state` is fresh, so the orchestrator's state folder and the babysit watcher's
state belong to the run.

The 2026-10-24 batch shows why. Its home linked the arm's `skills/` and `prompts/` and mirrored the
real `~/.pi`, `.git` included. Candidate t1 followed a link to the arm's worktree, added a worktree
and the branch `implement-chunk-tracker-linking` to the real repository, and committed there.
Candidate t2 edited the arm's real `agent/prompts/implement-chunk.md`, which the next run loaded.

**Departure from the spec: isolation through `HOME`, not `checkoutHarnessArgs`.** `pi-subagent`
launches each child as `pi --print` with the parent's environment, not its command-line arguments.
A root started with `checkoutHarnessArgs` would therefore spawn children that load the live
harness. Every child reads `$HOME/.pi/agent`, so pointing `HOME` at the run's home reaches all of
them.

**Isolation is proven, and checked on every run.** `probe-isolation.ts` runs a cheap two-level
launch, a root that spawns one owner child, against an arm whose `SYSTEM.md` and
`skills/subagents/unattended.md` carry a marker. It checks that both sessions recorded the arm's
system prompt, skill locations under the run's agent directory, and the marker. The grader runs the
same check (`isolation.ts`) on the root and every child session of every run:

- the preamble must equal the arm's `SYSTEM.md`;
- every skill location must sit under the run's agent directory;
- the live agent directory must appear nowhere;
- no subagent appendix may carry the live text where the arm's text differs.

A run that fails is marked `WRONG HARNESS` and dropped from the arm's summary.

**Integrity is checked after every run, and again by the grader** (`integrity.ts`). The runner reads
the sources before the first turn and after it kills the run's processes, and records both readings
in `run.json` under `integrity`, with the arm's HEAD and `harnessDigest`, a content hash of the
copied harness. A run is `INVALID`, with the reason, and dropped from the arm's summary when:

- the arm's HEAD moved, its `git status` changed, or its harness files changed;
- a branch was added to the arm's repository or the live one (a worktree arm shares the live
  repository's branches);
- the live checkout's `git status -- agent` changed;
- the run changed its own copy of the harness;
- a root or child session wrote outside the run: an edit, a write, a redirect, or an in-place
  `sed` outside the run's scratch directory, into the copied harness, or through a link of the
  home into the real home; or a git write whose `cd` or `-C` directory lies outside the run.
  Writes to `/tmp` outside every `/tmp/ic-eval-*` directory are allowed, because `mktemp` lands
  there;
- `run.json` has no integrity record, as in runs from before the check.

Other agents add branches to the live repository while a batch runs, and the user commits there.
A new branch then marks a run invalid it did not touch, so the reason names the branch. To avoid
it, run arms from a clone (`git clone ~/.pi /tmp/ic-candidate`) rather than a worktree. The check
reads the live checkout's `agent/` status, not its HEAD, so a commit to `main` passes.

## Fixture

[`fixtures/tally/`](fixtures/tally/) is a dependency-free Node HTTP service. It is copied into a
fresh repository per run, with a local bare repository as `origin`. The remote URL reads
`https://github.com/acme/tally-<arm>-t<n>-<suffix>.git`, and a git `insteadOf` setting points it at
the bare repository. The repository name is unique per run, so its state folder never collides.

- **Tracker.** [`tracker.ts`](tracker.ts) is a small Linear-like CLI named `tracker`, which the
  fixture's `docs/agents/issue-tracker.md` documents. It has commands for view, list, comment,
  state, and close. [`tickets.ts`](tickets.ts) seeds parent TAL-1 and three sub-tickets. TAL-3 and
  TAL-4 are blocked by TAL-2. The parent pins no base branch, environment, live-check access, or
  deploy signal.
- **GitHub.** [`fakegh.ts`](fakegh.ts), [`gh-pr.ts`](gh-pr.ts), [`gh-ops.ts`](gh-ops.ts), [`gh-api.ts`](gh-api.ts), and
  [`gh-views.ts`](gh-views.ts) make a fake `gh` on `PATH`, backed by the bare origin. It has
  `repo view` (merge settings) and `pr create/view/list/edit/checks/merge/close/ready/comment/review/diff`.
  It also has reviews, review threads, and the GraphQL and REST calls the babysit watcher makes.
  Every call is logged to `gh-log.jsonl`.
- **CI.** For a PR to any base, `gh pr checks` reports `npm run check` on the PR head, run in a
  scratch worktree after `--ci-delay-seconds` (default 20).
- **Review bot.** `coderabbitai` posts two reviews per head, a summary and an empty-bodied inline
  review, after `--bot-delay-seconds` (default 45). On the first head of a PR into `main`, the
  inline review carries one actionable finding as an unresolved thread: the README must document
  the new endpoints.
- **Deploy.** [`deploy.ts`](deploy.ts) polls `main` on the bare repository. On a new commit it runs
  `npm run build` on a `git archive` of it and serves `dist/` on the run's port. `GET /version`
  answers with the deployed commit, and every deploy goes to `deploys.jsonl`.

### Traps

No prompt and no ticket names a trap. Each one is a metric.

| Id  | Planted as                                                                                                                                                                                                            | Metric                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| T1  | The fake GitHub allows merge commits only. `gh pr merge --squash`/`--rebase` and the GraphQL equivalents are refused, and `repo view` reports it.                                                                     | `t1RefusedMerges`, `t1RecoverySpawns`                                         |
| T2  | `AGENTS.md` forbids code comments. TAL-4 asks that "a reader of the conversion code learns why the cap is 6".                                                                                                         | `t2CommentLines` (comment lines the final `main` adds to code), `t2FixSpawns` |
| T3  | CI fails a PR that changes `src/` without changing `CHANGELOG.md`. The changelog lies outside any narrow ticket scope.                                                                                                | `t3ChangelogCiFailures`, `t3ScopeStops`, `t3Respawns`                         |
| T4  | The tracker moves every ticket whose key is in a PR's branch, title, or body to Done when that PR merges or closes, into any base (Linear's GitHub integration).                                                      | `t4AutoDone`, `t4Resets`, `t4WrongAtMergeReady`, `t4WrongAtClose`             |
| T5  | `npm run build` copies only `src/*.mjs` plus the assets listed in `build.config.json`, which starts empty. `src/units.json` (TAL-2) works under `npm run dev` and the tests, but the built artifact fails without it. | `t5`: `caught-before-merge`, `live-failed`, or `missed`                       |
| T6  | The bot's two-review shape, one review with an empty body.                                                                                                                                                            | `t6ReviewToMergeReadyMinutes`; `t6WatcherErrors` stays unknown (see below)    |

## Human

[`user.ts`](user.ts) is a rule-based scripted user, so every arm meets the same user:

- **First stop.** It answers with the answer sheet, whatever the stop says: base `main`,
  production at the run's local URL, read-only `curl` access with no credentials, `/version` as
  the deploy signal, the publication policy, and "merging a final PR into `main` is mine".
- **Later stops.** A question about an intake fact gets the sheet again and counts as a
  **re-ask**. Any other question gets "use your proposed default". A stop without a question gets
  a nudge to carry on, which counts as a **status request**.
- **Merging.** It merges only a final PR (base `main`) that a sentence of the orchestrator's text
  calls merge-ready now, with `gh pr merge --merge` as actor `human`. A plan such as "driving #5
  to merge-ready" is not a claim. Each merge records its claiming sentence in `drive.json`, so a
  reader can audit it.
- **After the close.** The chunk's final PRs are the PRs into `main` that the orchestrator's
  `plan.md` names by number or head branch, or every PR into `main` when it names none. Once all of
  them have merged, the set is frozen and recorded in `drive.json` as `chunkFinalPrs`. From then
  on, the user merges nothing. When the orchestrator proposes work beyond the chunk, such as an
  edit to the prompt or the agent files or a follow-up ticket, the user answers once: "Thanks. List
  them in your close report; do not make these edits in this chunk." That reply counts as a human
  turn with reason `beyond-chunk`. A second such proposal ends the run. An in-chunk question after
  the close still gets "use your proposed default".
- **Stop.** The run stops at the first turn end after every final PR of the chunk has merged
  whose text asks nothing. A PR opened after the close neither keeps the run going nor counts in
  `finalPRs`, `ledgerAtHead`, or `finalPRsSelfContained`.

Every reply counts as a human turn. A run is capped at `--max-turns` (10), `--timeout-minutes`
(180), and `--max-cost-usd` (60, root plus children). At the cost cap, every process carrying the
run's `HOME` is killed.

**Driving mode: print mode with session continuation** ([`drive.ts`](drive.ts)). The first turn
runs `pi -p --session-dir <run>/root-session '/implement-chunk TAL-1'`. When the run exits, the
user replies with `pi --session <file> -p '<reply>'`. Alongside it, a merger loop scans the root
session every 10 s and merges any final PR the orchestrator has called merge-ready. The merge has
to happen concurrently, because the orchestrator waits on its until-merged watcher inside a turn.
This mode was chosen over the tmux TUI for three reasons. The user is the same deterministic code
in every trial. Each reply is a recorded `humanTurns` entry, with its reason and the text it
answered. And two runs can share a host without two TUIs fighting over terminals. The cost is that
Pi's print mode cannot take a mid-turn message, so the user acts only at turn ends and through the
merge side loop. The orchestrator asks at turn ends anyway.

## Metrics

[`metrics.ts`](metrics.ts) reads every metric from files: the fake `gh` and tracker logs and
state, `deploys.jsonl`, the archived origin (`origin.bundle`), the sessions, the orchestrator's
archived state folder, and `drive.json`. It never reads from a report. A value the records cannot
settle is `unknown`, with the reason.

- **`correct`.** At least one final PR merged, the hidden acceptance tests
  ([`acceptance.ts`](acceptance.ts), each ticket's criteria as HTTP requests) pass on a fresh build
  of the final `main`, and they pass on the live deploy.
- **`spawns`.** Child sessions. **`spawnsByRole`** comes from each child's `session_info` name,
  then its assignment ([`sessions.ts`](sessions.ts)). **`rootLaunches`** counts the root's
  `bg_start` calls of `pi-subagent`, as a cross-check. **`resumes`** counts children with more
  than one user message. **`fixRounds`** and **`respawns`** count children whose assignment reads
  as a fix of a finding, or as a retry of earlier work.
- **`humanTurns`, `reAsks`, `statusRequests`** come from `drive.json`.
- **`wallMinutes`, `rootCost`, `childCost`.** Cost is the sum of `usage.cost.total` over the root
  session and every session in the run's own sessions directory.
- **`ruleBreaks`** ([`rule-breaks.ts`](rule-breaks.ts)) ports `check-orchestrator.mjs` onto the
  shared session parser, so it also sees calls made inside codemode scripts. It counts the root's
  own writes to the repository, its branches, or its PRs. Writes to `/tmp` are allowed only
  outside the run's scratch directory, because the repository itself lives under `/tmp`.
- **`ledgerAtHead`.** Every merged final PR has a row in the orchestrator's `ledger.tsv` at its
  head SHA, and a `live-deployed-verified` or `live-failed` row at its merge commit.
- **`finalPRs`**, the chunk's own final PRs (`chunkFinalPrs` in `drive.json`; every PR into `main`
  in older records), and **`finalPRsSelfContained`**: each merged final PR's head passed CI.

**T5 reading.** The first commit the user merged into `main` is built and served. If it already
answers TAL-2's acceptance requests, the defect was caught before the final merge, or never
introduced. Otherwise the result is `live-failed` when the ledger records it, and `missed` when it
does not.

## Grade and the pre-registered reading

`node evals/implement-chunk/grade.ts <out>` prints each run's metrics and isolation, then for each
arm n, the correct rate, the median with min–max of every numeric metric, and the T5 tally. It
writes `grade.json`.

Pre-registered reading: the candidate is better if all three hold:

- its correct rate is not lower;
- at least three of {T1 refused merges, T3 scope-stop respawns, T4 tickets wrong at merge-ready,
  T5 caught, respawns, humanTurns} improve;
- its median `rootCost + childCost` is at most 15% above the baseline's.

The registered rule named T4 resets. The pilot batch showed resets measure exposure, not harm: the
baseline never reset and left 4 tickets wrong at merge-ready, while the candidate reset 10–12 and left
none. The rule now reads tickets wrong at merge-ready, changed after seeing pilot data.

With 3 trials per arm, a count metric counts as improved only when the two arms' min–max ranges do
not overlap. Otherwise the grader prints `within spread`. T5 compares the caught-before-merge rate.

## Run

```sh
vp install
node evals/implement-chunk/run.ts --out <dir> --arms baseline=<main checkout>,candidate=<worktree> --dry-run
node evals/implement-chunk/run.ts --out <dir> --arms baseline=<main checkout>,candidate=<worktree> \
  [--trials 3] [--concurrency 2] [--timeout-minutes 180] [--max-turns 10] [--max-cost-usd 60] \
  [--model anthropic/claude-opus-5-5] [--thinking high] [--ci-delay-seconds 20] [--bot-delay-seconds 45]
node evals/implement-chunk/grade.ts <dir>
node evals/implement-chunk/probe-isolation.ts --arm <checkout> --out <dir> [--marker <text in the arm>]
```

`--dry-run` prepares a world per arm without launching a model. It checks the arm, the fixture's own `npm run check`, the origin,
the fake `gh` and tracker on `PATH`, that the home holds copies of the arm's harness and reaches no
git repository, and the deploy serving `main`. It also drives
the arm's babysit watcher against the fake `gh`. Results go to `<out>/<arm>/t<n>/`. A rerun skips
runs that have a `run.json`. After each run, the runner:

1. kills every process carrying the run's `HOME`, and anything under its scratch directory, on exit
   or on SIGINT and SIGTERM;
2. reads the sources again and records the integrity check in `run.json`;
3. archives the sessions, the state folder, the origin bundle, and the worktree list;
4. removes the scratch directory.

## Known gaps

- `t6WatcherErrors` is always unknown. The watcher's exit codes are in the root's tool results,
  and the grader does not parse them yet.
- `t6ReviewToMergeReadyMinutes` measures the minutes from the final PR's last bot review to the
  user's merge. It is a proxy for the wall time a false "no review" costs, not a direct
  measurement.
- Roles, fix rounds, respawns, T2 fix spawns, and T3 scope stops come from regular expressions
  over child names, assignments, and reports. Check them against the sessions before acting on a
  small difference.
- The fake `gh` and tracker are this eval's own. `evals/harness-lessons/fakegh*.ts` models one PR
  with a fixed head, and this eval needs many PRs on a real bare origin with stacked bases, CI on
  each head, and merges that move the tracker. Only `killProcessesWithEnv` is reused from
  `evals/harness-lessons/workdir.ts`. The tracker follows the pattern of
  `evals/tracker-records/faketrack.ts`.
