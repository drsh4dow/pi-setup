# Recorded state rows of past chunks

`checks.test.ts` feeds these rows to the checks in `checks.ts`. Each row is copied from a past
chunk's state folder, at the line that `evals/coordinator-runs/grade.ts` (baseline graded at
ecfaba4) named in a finding of the check's class. Paths are relative to
`~/.local/state/pi-agent/`.

## `unterminated-subagent/units.tsv`

| Fixture line | Unit            | State   | Source                                                       | Coordinator session                  | Entry    |
| ------------ | --------------- | ------- | ------------------------------------------------------------ | ------------------------------------ | -------- |
| 2            | final-E/PE-6394 | pr-open | 3y-harness/implement-chunk/card-flow/units.tsv:11            | 01a1687f-8696-7677-88b6-ca2a490037e8 | -        |
| 3            | final-E/PE-6395 | pr-open | 3y-harness/implement-chunk/card-flow/units.tsv:12            | 01a1687f-8696-7677-88b6-ca2a490037e8 | -        |
| 4            | F-A6            | running | 3y-harness/implement-chunk/card-flow/units.tsv:23            | 01a1687f-8696-7677-88b6-ca2a490037e8 | -        |
| 5            | F-E6            | pr-open | 3y-harness/implement-chunk/card-flow/units.tsv:74            | 01a1687f-8696-7677-88b6-ca2a490037e8 | -        |
| 6            | hasura-C        | running | 3y-harness/implement-chunk/vob-summary-history/units.tsv:66  | 01a17925-8c19-71aa-99a9-081ff7b6d690 | 2c9f74cd |
| 7            | walk-C          | planned | 3y-harness/implement-chunk/vob-summary-history/units.tsv:70  | 01a17925-8c19-71aa-99a9-081ff7b6d690 | e46c981d |
| 8            | watch-DAB-5     | running | 3y-harness/implement-chunk/vob-summary-history/units.tsv:138 | 01a17925-8c19-71aa-99a9-081ff7b6d690 | 042a9d06 |

The source line of `watch-DAB-5` reads `done` today. The fixture keeps the state the graded run
recorded, `running`.

## `report-only-merge/`

`ledger.tsv` holds each merged final PR's ledger row that the finding names, and
`final-prs.tsv` holds the PR's merged head as GitHub reported it, with the finding's session,
entry, and source row. `monorepo#5961` merged at `041e425`, a head no ledger row names; its
row is its last one, at `f7ca576`.
