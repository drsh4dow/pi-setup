# Harness lessons

Checks whether a set of harness edits changes agent behavior in the situation each edit
targets. Every scenario runs against two harness checkouts, a **baseline** and a
**candidate**, and the grade compares them. Each run loads its arm's `agent/SYSTEM.md`,
skills, and prompts through `checkoutHarnessArgs`. A run in a clone also passes
`--skill <workdir>/.agents/skills`, because `--no-skills` drops the clone's own project
skills, such as `.agents/skills/verify-pi-setup`, which Pi would otherwise load from the working
directory. Both arms get the argument; only an arm whose checkout has the skill loads it.

[`scenarios.ts`](scenarios.ts) lists the scenarios. Each one names its project, an optional
[`setup/`](setup/) script, a prompt that reads like a real request, a timeout, and a trial
count. A project is one of two kinds:

- a small invented project under [`fixtures/`](fixtures/), copied into a fresh git repository;
- a copy of the arm's checkout at its committed HEAD, in a fresh `/tmp/pi-setup-XXXXXX`, built
  with `git archive` into a new repository with one commit and without
  `evals/harness-lessons/`. A `git clone --local` would keep every object of the shared
  repository, so a run could read the other arm's commits by hash. The copy has no remote,
  so each run's state folder is named after its own directory, and its git identity is
  `Sam Rivera <sam@example.com>`.

## Run

```sh
node evals/harness-lessons/run.ts --out evals/harness-lessons/results/<name> \
  --baseline <harness checkout> --candidate <harness checkout> \
  [--arms baseline,candidate] [--only live-reader-rebase,...] [--trials 3] \
  [--models anthropic/claude-opus-5-5] [--thinking high] [--concurrency 4] [--timeout-minutes 20]
node evals/harness-lessons/grade.ts evals/harness-lessons/results/<name>
```

Results go to `<out>/<scenario>/<arm>/<model>/t<n>/`. Rerunning with the same `--out`
skips finished runs, so an interrupted batch resumes. Without `--trials`, each scenario
runs its own trial count. Without `--timeout-minutes`, each runs to its own timeout.
Without `--only`, every scenario runs except `cosmetic-wake`, which runs only when `--only`
names it (see [cosmetic-wake](#cosmetic-wake)).

`--dry-run` prepares every planned working directory and prints its `pi` command, then
checks the setup state the metrics depend on, without launching a model. It also waits for
the user commit of `concurrent-main` (with no agent, it fires on its 20-second fallback) and
drives the babysit watcher of
`cosmetic-wake` through one wake and its acknowledgement. Every run checks its setup before
it launches Pi. A run whose setup check fails is recorded with the problems and is not
launched.

Each run reaps the background processes setup started in its working directory. The
`cosmetic-wake` runs share the babysit state directory
`~/.local/state/pi-agent/gift-registry/`, so they run one at a time, and each setup
recreates that directory.

## concurrent-main

Setup starts the user's commit in the background: it adds one line to `README.md` on `main`.
It polls every second and fires on the agent's first sign of work: a new branch, a new
worktree, or a change to `docs/development.md` in the clone's main working tree. With none
within 20 seconds, it fires anyway. It commits in the worktree that has `main` checked out
when that worktree's `README.md` is clean, and otherwise writes the commit with plumbing, so
it lands on `main` without touching the agent's uncommitted changes. Its record,
`user-commit.json`, names the trigger. `changeLanded` accepts any line added to
`docs/development.md` on `main` that mentions `results` and says git ignores them ("Git
ignores", "ignored by git", "gitignored").

## hand-edits-use-edit

The prompt asks for three distinct hand edits in the `http-client` fixture: the default
`retryCount` in `src/config.ts` goes from 3 to 5, a negative `retryCount` throws
`RangeError("retryCount must be >= 0")` from `src/client.ts`, and the README's options table
gives the new default and says negative values throw. `correct` checks those three outcomes
in a copy of the working directory: a probe imports the project's modules, and the README
row is read from the table. It also requires the fixture's tests to pass, so a run must
update the test that expects three retries by default. `CHANGELOG.md` counts for nothing.
`scriptedEdits` counts shell commands that rewrote files in place; the primary verdict wants
`correct` and no scripted edit.

## cosmetic-wake

Not in the default set. The edit it targets says a cosmetic wake item gets no message to the
operator, but every print-mode run ends on a final message, so a run cannot show that
behavior. It stays reachable through `--only cosmetic-wake`.

A fake `gh` ([`bin/gh`](bin/gh), [`fakegh.ts`](fakegh.ts)) serves one PR, #42 in
`acme/gift-registry`. The PR is open and green, it is approved, and every thread on it is
resolved. The fake answers the watcher's GraphQL reads and the common calls an agent makes,
and it logs every call to the run's `gh-log.jsonl`. Setup drives a copy of the arm's own
`watch-pr`:

1. The first arm delivers the PR's history and merge-ready. Setup acknowledges both and
   writes run notes to the state directory saying merge-ready was reported.
2. The bot edits its comment on a resolved thread to read "Thanks for addressing this!".
3. The watcher wakes with that one item, and setup leaves the wake unacknowledged for the
   run.

An armed watcher keeps a print-mode run alive until the timeout. A timed-out
`cosmetic-wake` run whose last stop reason is `stop` therefore counts as valid.

## What the grade counts

`grade.ts` writes `grades.json` and `report.md` in the results directory and prints the
report. Each grade records:

- every metric, with its evidence;
- the primary verdict;
- each run's final text and its judge answers.

The report has one table per scenario and one row per arm. A row gives the valid runs out of
the total, the primary pass rate over decided runs, and each metric's rate. It then lists:

- runs where a judged metric disagrees with its mechanical cross-check;
- metrics that could not be decided;
- invalid runs.

The grade follows these rules:

- A run is **invalid**, and left out of the rates, when setup failed, it timed out, it
  exited non-zero, it left no session, or it ended on a stop reason other than `stop`.
- A metric that needs judgment asks one `pi -p --no-tools --no-skills --no-session` call
  (`anthropic/claude-opus-5-5`, thinking `low`). The call answers `{"pass": bool, "why": "..."}`.
  The judge sees the question, the final text, and only the artifacts the question needs.
  The arm's root path is redacted. Answers are cached in each run's `judge.json`.
- A judge that could not run, or answered something else, makes its metric **unknown**. An
  unknown metric is neither a pass nor a fail, and it is not cached.
- Metrics computed from the working directory read `workdir` from `run.json`, so grade
  before deleting the working directories under `/tmp`.
