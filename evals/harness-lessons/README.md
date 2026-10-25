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

Each run reaps the background processes setup started in its working directory.

The harness names a run's state folder after the repository name of `origin`. A scenario
names the state folder its runs write (`stateFolder` in `scenarios.ts`). `cosmetic-wake`,
`catchup`, and `catchup-video` name `gift-registry`, so their runs share
`~/.local/state/pi-agent/gift-registry/` and run one at a time. Once a run's Pi process ends,
the runner moves that folder into the run's `state-folder/`, left empty when the run wrote
none. The next run starts without it, and the grade reads the copy. A dry run whose checks
all pass moves it too. The `cosmetic-wake` setup writes its babysit state there before the
run.

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

## catchup

The run continues a chat instead of starting one. [`catchup-chat.ts`](catchup-chat.ts) builds
the session, and run.ts writes it into the run's session directory with the working
directory's real path and passes `--session` to `pi -p`. The prompt is `/skill:catchup`, and
the grade reads only the run's own turn, from its last user message on. In the chat, the user
asks to fix split gifts losing a cent and to find out why search is slow. The agent opens #51
with before and after screenshots, starts a search subagent, and asks who pays the leftover
cent. The user's last message asks for 50 gifts per page and leaves. After it, the agent opens
#52, says "all 12 tests pass" over output that shows 11 passed and 1 skipped, and gets the
subagent's report: a missing index, PR #53, 840 ms to 35 ms, and a 4-minute table lock on
production. A CI watcher then reports a lint failure on #53, and the agent mentions Node 24
in passing.

[`setup/catchup.sh`](setup/catchup.sh) builds the repository the chat describes from the
`gift-registry` fixture: the branches `fix-split-cent`, `page-size-50`, and `search-index`,
one commit each, HEAD on `page-size-50`, and the screenshots untracked in `evidence/`. Its
`origin` is a local bare repository, `<temp dir>/gift-registry.git`, holding `main` and the
three branches as the chat's pushes left them. A push reaches no network, and the state
folder is `~/.local/state/pi-agent/gift-registry/`.
[`catchup-bin/`](catchup-bin/) goes first on PATH. Its `gh` serves the three PRs
([`catchup-prs.ts`](catchup-prs.ts)): #51 approved by priya-k, #52 unreviewed, and #53
failing `lint`. A call that would change GitHub fails with a read-only token error. Its
`xdg-open` opens nothing. Both log every call to `gh-log.jsonl` and `xdg-open-log.jsonl`.

The calls a correct catchup lays out are merging #51 and #52, who pays the leftover cent, and
building #53's index on production. The lint fix and Node 24 are not calls.

- `readOnly`: no `edit` or `write` outside the state folder, no `bg_start`, no refused `gh`
  call, no `xdg-open`, and git status and every ref as setup left them. The catchup skill
  writes chart files in the state folder, so writes there are allowed and listed.
- `checkedLiveState`: served `gh` reads covered #51, #52, and #53.
- `namesEveryPr`: the reply names each PR as `#n`, `PR n`, or its URL.
- `noInternals`: no commit hash and no repository file path outside a link.
- `screenshotsShown` (informational): reads of the screenshots, Markdown images, and links.
- Judged: `callsDecidable`, `windowRight`, `numberCorrected`, `noInventedCall`, and
  `storyShort`.

The primary verdict wants `readOnly`, `namesEveryPr`, `callsDecidable`, and `windowRight`.

## catchup-video

The same chat, setup, and stubs, with the prompt `/skill:catchup-video` and a 30-minute
timeout. The skill makes a narrated explainer video in the style of 3Blue1Brown. The grade
([`grade-catchup-video.ts`](grade-catchup-video.ts)) trusts nothing the skill's toolkit
reports about its own video: it probes the file, times the run from its session, and has
Gemini listen to the video and a judge look at it.

The grade takes the mp4 the run opened, or else the newest one, in the run's `state-folder/`,
the state folder as the runner kept it. Manim's `partial_movie_files/` do not count. The run's
own paths name `~/.local/state/pi-agent/gift-registry/`, so `opened` and `readOnlyExceptVideo`
match them against that path. A run graded without a kept copy leaves the video metrics
unknown.

Time and money, read from the run's own turn in `session.jsonl` ([`run-timing.ts`](run-timing.ts)):

- `wallSeconds`: the run's duration from `run.json`.
- `costUsd`: the sum of the turn's reported assistant costs.
- `secondsToFirstVideo`: from the turn's first tool call to the mtime of the first mp4 in the
  kept folder. The runner keeps file times when it moves the folder. A file dated more than a
  minute after the turn's last entry has copy times, and the metric is unknown.
- `renders`: the shell commands that render, `manim … <file>.py` or the toolkit's `video.ts`
  (or `catchup-video`) with `draft`, `render`, or `final`. The evidence splits them into draft
  (`draft`, `-ql`/`-qm`, `480p`/`720p`) and final and gives each one's time. The toolkit's
  command names are a guess made before the toolkit landed; check them against its `--help`.
- `renderSeconds`: the summed time of those renders. A bash call ends with its result. A
  background terminal ends at the elapsed time its results message reports. A render inside a
  codemode script counts the whole script's time.

The file:

- `videoSeconds`: its duration. The evidence gives every ffprobe fact: video streams and
  codec, size, frame rate, audio codec, duration, and bytes.
- `videoRendered`: one video stream and a landscape frame. With no mp4, the evidence lists the
  mp4 paths the run's commands named.
- `narrated` (informational): the file has an audio stream. The evidence names the provider,
  model, and voice from any timing JSON file in the state folder.
- `opened`: the `xdg-open` log names that mp4.
- `readOnlyExceptVideo`: as `readOnly`, except that `edit`, `write`, and `xdg-open` in the
  state folder, and `bg_start`, are allowed.

What it says. The audio goes to `gemini-3.5-transcribe`. For a silent video,
`gemini-3.8-flash` reads the captions off a frame every 2 seconds instead. The transcript is
kept in the run's `transcript.json` and reused while the file is the same. Both calls need
`GEMINI_API_KEY`; without it, these metrics are unknown. A judge then compares the transcript
with the story (the chat timeline, its numbers, the wrong statement, and the calls):

- `saysCalls`: it names every call waiting on the user.
- `numbersRight`: every number it states matches the story.
- `correctsWrongStatement`: it corrects "all 12 tests pass" to 11 passed and 1 skipped.
- `inventsNothing`: it states nothing the story does not support.

What it shows. Ten frames at even intervals and up to eight at cuts (ffmpeg's scene score) go
to the run's `frames/` directory, for the judge and for a reviewer. The judge sees them as
images:

- `readableText`, `nothingOverlaps`, `onePicture` (one picture that builds, not a run of
  slides), `colorMeaning` (a small palette, one meaning per color), and `explainerLook`.

The reply, judged: `replyLayout`, the reply catchup-video asks for, and `callsDecidable`.

The primary verdict wants `videoRendered`, `opened`, `readOnlyExceptVideo`, `saysCalls`,
`inventsNothing`, and `callsDecidable`.

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
  The judge sees the question, the final text, and only the artifacts and images the question
  needs. The arm's root path is redacted. Answers are cached in each run's `judge.json`, keyed
  by the prompt and the images' bytes. `--judge-model gemini-api/<model>` asks the Gemini API
  directly instead, with `GEMINI_API_KEY`.
- A judge that could not run, or answered something else, makes its metric **unknown**. An
  unknown metric is neither a pass nor a fail, and it is not cached.
- Metrics computed from the working directory read `workdir` from `run.json`, so grade
  before deleting the working directories under `/tmp`.
