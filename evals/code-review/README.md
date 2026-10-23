# code-review eval

Measures how many planted defects a review catches, and how much it flags on a clean change. It
compares two arms on the same branches: a plain review prompt and the code-review skill. Each run
loads skills from this checkout.

The retired `interrogate` skill was a third arm while code-review was built. On the three `-hard`
fixtures and the clean control, with an Opus lead and two trials each, it caught 87% of defects
against code-review's 98%, and flagged 0.7 blocking findings per clean-control run against 0.3.
Its diff review was then folded into code-review, and its design review into `architect`.

## Layout

- `fixtures/<name>/`: the base project, committed on `main`.
- `changes/<name>/`: the overlay committed on `feature`. Only the files the change adds or edits.
- `defects/<name>.json`: the commit message, the spec the reviewer gets, and the planted
  defects, one per lens, with file, lines, summary, and a proof for logic and security defects.
  It never enters the working directory. An empty `defects` array marks a clean control.

Fixtures, overlays, and defect files are excluded from formatting and lint: formatting would
move the recorded lines, and lint could flag the planted defects.

## Run

```bash
node evals/code-review/run.ts --out <results-dir> [--arms plain,code-review] \
  [--models anthropic/claude-opus-5-5] [--only orders,...] [--concurrency 4]
node evals/code-review/grade.ts <results-dir> [--judge anthropic/claude-opus-5-5]
```

`--models` sets the lead's model. The default is Opus alone, the model this setup runs as the main
agent. The personas' seats come from the subagents skill whatever the lead. Reruns with the same `--out` skip finished runs.

## Grading

A judge model reads the final review and the defect list, without the proofs, and gives each
defect one verdict: `blocking`, `advisory`, `dismissed`, or `missed`. It also counts must-fix
findings that match no defect. The report shows, per arm:

- the share of defects caught, and caught as blocking;
- the same two shares for consequential lenses (spec, standards, logic, security, tests), whose
  defects should block, and for judgment lenses, where advisory is right;
- the catch rate per lens;
- the blocking findings per clean-control run.

Verdicts are cached in `judge.json` beside each run. Read a sample of reviews beside their verdicts before
trusting a number.
