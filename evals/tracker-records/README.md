# Tracker records

Checks that `to-spec` and `to-tickets` publish through whatever tracker a repository's config
record names, rather than assuming GitHub. The `giftshop` fixture commits an "Other" issue
tracker record for faketrack, a CLI in [`bin/`](bin/) that no model has seen. A skill that
follows the record leaves its work in faketrack. A skill that reaches for `gh` fails. faketrack
still has a `label` command the record omits, so a skill that labels out of habit is caught.

## Run

```sh
node evals/tracker-records/run.ts --out <results-dir> \
  [--models anthropic/claude-opus-5-5] [--trials 1] [--only to-spec,to-tickets] \
  [--concurrency 4] [--thinking high] [--timeout-minutes 30]
node evals/tracker-records/grade.ts <results-dir>
```

Each run copies the fixture into a fresh `/tmp/giftshop-XXXXXX` git repository and runs the
skill with this checkout's `SYSTEM.md`, skills, and prompts. faketrack's issues and call log stay
in the run's results directory, outside the working directory. `to-tickets` starts with a gift
card spec seeded as issue `#1`.

## What the grade counts

- `to-spec`: one issue, with no label, with the spec template's sections.
- `to-tickets`: `#1` fetched, at least two tickets nested under it with no label,
  at least one blocking edge, every blocker published before what it blocks, and `#1` left
  unchanged.
- Both: exit 0, and no repository file changed except `GLOSSARY.md`, where the domain docs ask
  for new terms to go.
