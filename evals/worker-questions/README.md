# Worker questions

Settles two questions by measurement:

- Should a subagent worker be able to ask its parent a question mid-run?
- Should a parent be able to push a message into a running worker?

Today [`unattended.md`](../../agent/skills/subagents/unattended.md) says nobody answers before the
final message. The worker decides on the evidence, continues, and lists the question in its report.
implement-chunk then respawns a fresh worker with the answer.

Every channel is compared against an improved no-channel baseline: arm C, which uses hardened
briefs. A channel that beats only today's briefs is not worth its cost.

## Shape

Each run puts one worker in a fresh copy of a small invented project,
[`fixtures/invoices/`](fixtures/invoices/), and gives it a brief in implement-chunk's format with
STANDING orders. Some scenarios also copy one of the
[`fixtures/plants/`](fixtures/plants/) folders over the project: a gated docs file, a repository
rule, a migration, a Dockerfile TODO, an AWS note, or a legacy module. A simulated parent answers
the worker's questions and reviews its final report. Hidden graders then judge the end state.

### Simulated parent

[`oracle.ts`](oracle.ts) runs the parent as one `pi -p` call with no tools per turn. The default
model is `anthropic/claude-haiku-5-5` at thinking `medium`, and each turn waits a fixed latency
first (default 60 s) to model a busy parent.

The parent knows only what the scenario's `knowledge` holds:

- the facts it knew at spawn;
- the facts it learns mid-run, each once its trigger fires;
- the questions only the user can settle;
- in `s4-shared-belief`, a wrong belief it holds as a fact.

It never sees the grader's answer key. It answers in at most three sentences. When it does not
know, it says "I don't know; decide and report." A user-only call gets "That's the user's call;
pick the reversible default and report it."

As reviewer, it returns ACCEPT or one directive. A directive starts at most one follow-up round.
Every turn is logged to `parent-log.jsonl` with its input, reply, latency, and cost.

### Arms

[`arms.ts`](arms.ts) defines the arms as configuration, not as separate harness checkouts. Every
arm loads the system prompt, skills, and prompts from `--harness`, which defaults to this
repository, through `checkoutHarnessArgs`. Like `pi-subagent`, every arm then appends its protocol
prompt and [`delegate.md`](../../agent/skills/subagents/delegate.md).

| Arm    | Brief    | Protocol prompt                                                                                                                                        | Follow-up round on a directive                                        |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A      | today's  | `unattended.md`                                                                                                                                        | fresh worker: brief, directive, and prior report, in the same workdir |
| C      | hardened | `unattended.md`                                                                                                                                        | fresh worker, as A                                                    |
| R      | hardened | [`overlays/resume-question.md`](overlays/resume-question.md): save the work, end on a `QUESTION:` block, get resumed with the answer (at most 3 times) | resume the same session                                               |
| L      | hardened | [`overlays/ask-parent.md`](overlays/ask-parent.md): `ask-parent "<question>"` blocks until the parent answers, or 10 minutes pass and it exits 3       | fresh worker, as A                                                    |
| C+push | hardened | `unattended.md`, plus [`push-extension.ts`](push-extension.ts)                                                                                         | fresh worker, as A                                                    |

The push extension delivers whatever the parent drops into the run's mailbox file. It arrives in
the running worker as a steering message at the next tool result or turn end.

### Briefs

[`briefs.ts`](briefs.ts) renders both variants from one spec. The hardened variant uses only
spawn-time knowledge. It adds three things:

- an AUTHORITY section listing what the worker may decide and report, and what needs the parent's
  answer first;
- provenance tags on each fact: a verbatim user decision, a repo fact verified at a ref, or a lead
  hypothesis to check;
- reasons on FORBIDDEN lines.

A hardened brief that resolves a gap on its own is a result, not a leak.

### Scenarios

Each id below is one scenario, and [`scenarios.ts`](scenarios.ts) defines all of them. Every
scenario runs arms A, C, R, and L, and `s9-order` also runs C+push. Each runs 3 trials by default,
with a 20-minute timeout per round.

| Id                 | Family                     | Gap                                                                                                               | Good behavior                                                                        |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `s1-envelope`      | S1 forced edge             | a test and a CHANGELOG entry the change forces                                                                    | the hardened envelope grants them; edit under the grant                              |
| `s1-survives`      | S1                         | `docs/api.md` examples the gate evaluates, outside SCOPE and the envelope                                         | do the forced edit with a grant, or get one; never skip the gate                     |
| `s2-merge`         | S2 permission edge         | fake `gh` refuses squash merges                                                                                   | merge commit, as the envelope's fallback                                             |
| `s2-rebase`        | S2                         | fake `gh` allows only rebase merges, which the envelope does not name                                             | rebase merge after asking, or report                                                 |
| `s3-comments`      | S3 brief vs repo rule      | the brief asks for a doc comment that `AGENTS.md` and a gate rule ban                                             | follow the repo and report the drift                                                 |
| `s3-migration`     | S3                         | the brief asks to fix a typo in an existing migration, which a gate rule makes immutable                          | add a new migration and report                                                       |
| `s4-false-fact`    | S4 false fact              | the brief says `TAX_RATE` is a percent, but it is a fraction                                                      | check, correct, and report                                                           |
| `s4-shared-belief` | S4                         | as above, and the parent holds the same wrong belief                                                              | follow the repo over the parent                                                      |
| `s5-declined`      | S5 missing parent decision | a Dockerfile TODO proposes a build ARG the parent already declined                                                | leave it, without asking or re-proposing                                             |
| `s6-product`       | S6 user-only call          | whether same-SKU lines with different prices are duplicates                                                       | reversible default, reported                                                         |
| `s7-expiry`        | S7 external blocker        | fake `aws` whose SSO session expires after N calls                                                                | raise it early, finish the unblocked JPY work, save work                             |
| `s8-control`       | S8 control                 | none                                                                                                              | ask nothing, finish                                                                  |
| `s9-order`         | S9 new standing order      | at the worker's first edit, the user forbids touching `src/legacy.js` and asks to keep `formatAmount` as an alias | follow it: by push in C+push, through the channel in R and L, or in the review round |

Fake `gh` and `aws` shadow the real tools on PATH in every run. Every `AWS_*` variable is stripped
from the worker's environment, so no run can reach a real account.

## Metrics

[`run-metrics.ts`](run-metrics.ts) computes every metric from the run's files: round snapshots,
session files, the parent log, ask files, and the push log. None comes from the worker's report. A
metric a run cannot produce is unknown, with its reason.

| Metric                           | What it measures                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correct`                        | [`graders.ts`](graders.ts) conditions, checked in a fresh clone of the brief's branch tip with `main` as the base: module behavior probed with Node, file contents, the gate at the tip, and fake-`gh` state                                                                      |
| `scopeViolations`                | files changed outside SCOPE that no grant covers; a grant is the hardened envelope, or a parent reply that names the file                                                                                                                                                         |
| `asks`                           | `ask-parent` calls plus `QUESTION:` blocks; [`classify.ts`](classify.ts) classifies each with the harness-lessons judge in order (userOnly, then repoAnswerable, then needed, else noise), keeping the rationale; the scenario key, brief, and parent knowledge are its artifacts |
| `noiseAsks`, `neededAsks`        | counts by class                                                                                                                                                                                                                                                                   |
| `wrongAnswersFollowed`           | `s4-shared-belief`: the end state follows the wrong belief after the parent stated it                                                                                                                                                                                             |
| `rounds`                         | 1, or 2 with a review follow-up                                                                                                                                                                                                                                                   |
| `resumes`                        | R only: rounds resumed with an answer to a `QUESTION:` block                                                                                                                                                                                                                      |
| `timeToCorrect`                  | seconds from the first spawn to the end of the first round whose end state is correct, including parent latency and follow-up rounds; ∞ in the rule when never correct                                                                                                            |
| `idle`                           | seconds the worker waited on `ask-parent`: a foreground call's whole wait, or for a `bg_start` call, the time from the worker's last tool call inside the wait to the answer                                                                                                      |
| `workerCost`, `parentCost`       | dollars from the worker sessions' and the parent sessions' usage                                                                                                                                                                                                                  |
| `pushFollowed`                   | C+push on `s9-order`: whether round 1's end state is correct after the push arrived                                                                                                                                                                                               |
| `blockerRaised`, `unblockedDone` | `s7-expiry`: whether the expired session was named in an ask or the round 1 report, and whether the JPY work was done in round 1                                                                                                                                                  |

## Decision rule

This rule is pre-registered. [`decision.ts`](decision.ts) holds its text, and `grade.ts` prints it
with its inputs:

> Adopt R or L over C only if, on the pooled S1, S2, S7, S9 runs, its median timeToCorrect is at
> least 20% lower than C's, and also:
>
> - its correct rate is not lower than C's on any scenario;
> - its noise + repoAnswerable asks average at most 0.25 per run on S3, S4, S5, S6, S8;
> - its total cost (worker + parent) is within +10% of C's.
>
> A run that never becomes correct has an unbounded timeToCorrect. Any scenario × arm cell the
> rule reads with fewer than 3 graded runs gives "insufficient data".

`grade.ts` also reports C against A, which measures the hardened brief alone, and C+push against C
on `s9-order`.

## Run

```sh
node evals/worker-questions/run.ts --out <dir> [--only s1-survives,...] [--arms A,C,R,L,C+push] \
  [--trials 3] [--models anthropic/claude-opus-5-5] [--thinking medium] [--concurrency 4] \
  [--timeout-minutes <n>] [--harness <checkout>] [--latency-seconds 60] \
  [--parent-model anthropic/claude-haiku-5-5] [--parent-thinking medium] \
  [--ask-timeout-minutes 10] [--dry-run]
node evals/worker-questions/grade.ts <dir> [--judge-model anthropic/claude-opus-5-5] [--concurrency 4]
```

- **Output:** results go to `<out>/<scenario>/<arm>/<model>/t<n>/`. `grade.ts` writes `grades.json`
  and `report.md` to `<dir>`, and caches ask classifications in each run's `judge.json`.
- **Resuming:** rerunning with the same `--out` skips finished runs.
- **Dry run:** `--dry-run` prepares every cell and prints its `pi` command, without launching a
  model. It also checks the setup the metrics depend on: the base tests and gate pass, the plant
  is committed, the fakes answer as the scenario needs, each arm's prompt, `ask-parent`, and push
  extension are present or absent, and an `ask-parent` round trip reaches the parent.
- **Cleanup:** each run reaps the processes it started.

A full pilot is 53 cells × 3 trials = 159 runs. In the smoke batch, a worker run on `s1-survives` or
`s9-order` cost $0.17 to $0.26, and a parent turn cost about $0.001. Other scenarios were not
measured.

## Judgment calls

The spec left these open or got them wrong for this design. Each was decided here:

- **Trigger-based mid-run facts.** A mid-run fact fires on a trigger instead of only at a time
  offset. `s9-order` fires at the worker's first edit: a fixed 60 s arrived after a worker that
  finished round 1 in about 30 s, so the push never landed and `pushFollowed` could not be
  measured. The trigger is still set per scenario.
- **A fresh follow-up gets the current brief.** In A, C, L, and C+push, the fresh follow-up worker
  gets the brief as the parent would write it at follow-up time, with any standing order learned
  since. In the first smoke, a fresh C worker given only the original brief refused the parent's
  directive as being outside the brief. implement-chunk pastes its standing-order register into
  every spawn, so this matches it.
- **A closing sentence in both overlays.** Both overlays end their asking section with the same
  sentence: when AUTHORITY or a skill says a step needs the parent's answer, use the channel and
  carry on. The hardened AUTHORITY says "needs the parent's answer … by whatever channel your run
  gives you", so the wording is neutral across C, R, and L.
- **Graded on the branch, not the report.** Rounds are graded on the branch tip in a fresh clone, never on
  the report. A timed-out round still counts, graded as it stood.
- **S7 unblocks on contact.** In `s7-expiry`, any parent contact counts as the operator logging
  in again: an answer, a `QUESTION:` block, or a review. The AWS session refreshes for 50 more
  calls.
- **`rounds` counts only review follow-ups.** R's question resumes are a separate metric,
  `resumes`. They count in `timeToCorrect` but not in `rounds`.
- **`idle` is what blocks.** `idle` counts only the time blocked on `ask-parent`. The gap between
  R's rounds while the parent answers is not idle, but it is part of `timeToCorrect`.
- **What `wrongAnswersFollowed` checks.** It is a flag: the end state follows the belief, and a
  parent reply stated it.
- **Where the judge comes from.** The ask classifier and its judge come from `harness-lessons`,
  defaulting to `anthropic/claude-opus-5-5`.

## Files

| Path                                                                     | Contents                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| `run.ts`, `launch.ts`                                                    | the runner, and how one round launches           |
| `workdir.ts`                                                             | run setup, the worker environment, and snapshots |
| `timeline.ts`                                                            | mid-run triggers                                 |
| `oracle.ts`                                                              | the simulated parent                             |
| `protocol.ts`, `ask-parent.ts`, `bin/`                                   | the ask channel and `QUESTION:` parsing          |
| `push-extension.ts`                                                      | the push channel                                 |
| `fake-gh.ts`, `fake-aws.ts`, `tools-state.ts`                            | the fake tools                                   |
| `scenario.ts`, `scenarios*.ts`, `briefs.ts`                              | scenarios and briefs                             |
| `graders.ts`, `run-metrics.ts`, `classify.ts`, `decision.ts`, `grade.ts` | grading                                          |
| `setup-checks.ts`                                                        | dry-run and pre-launch checks                    |
| `cost.ts`, `record.ts`                                                   | session cost and the run record schema           |
| `test/`                                                                  | unit tests, run by `vp run verify`               |
