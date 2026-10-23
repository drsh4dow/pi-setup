# Principle loading

Checks whether agents running this repository's Pi setup read each `principle-*` skill when
its trigger applies. Each principle has one scenario in [`scenarios.ts`](scenarios.ts): a
project under [`fixtures/`](fixtures/), an optional [`setup/`](setup/) script that adds git
history or generated files, and a prompt that reads like a real request.

## Run

```sh
node evals/principle-loading/run.ts --out evals/principle-loading/results/<name> \
  [--models anthropic/claude-opus-5-5,openai/gpt-6.1-sol] [--trials 3] \
  [--only principle-fix-root-causes,...] [--concurrency 6] [--thinking high] [--timeout-minutes 20]
node evals/principle-loading/grade.ts evals/principle-loading/results/<name>
```

Each run copies its fixture into a fresh `/tmp/<fixture>-XXXXXX` git repository and runs
`pi -p` there with the global Pi config. `PI_*` and `HERDR_*` are stripped from its
environment, and its session goes to a separate `/tmp/pi-sessions-XXXXXX` directory. The
candidate sees no path, file, or prompt that names the measurement. `run.ts` copies the
session and writes `run.json` next to it under `--out`. Rerunning with the same `--out`
skips finished runs, so an interrupted batch resumes.

## What the grade counts

- A principle is **loaded** when the session reads its `SKILL.md` successfully: through
  `read`, a codemode `tools.read`, or a bash `cat`/`head`/`sed`/`bat`/`less`. Listing or
  grepping the file does not count.
- **Early** means it was read before the first successful `edit` or `write`, or the run
  edited nothing. File changes made through bash are not seen as edits.
- A run is **invalid**, and is left out of the fractions, if it timed out, exited non-zero,
  left no session, or ended on a stop reason other than `stop`.
- Off-target loads count each principle's reads in the other scenarios. Over-loading shows
  up there.

The grade only shows which files each run read. Read the final answers in `grades.json`
(`finalText`) and the working directories (`workdir` in `run.json`) to confirm each run
actually did the task.
