# setup-sh4dow-skills

Checks that the `setup-sh4dow-skills` skill writes a correct config record in different kinds of
repository, and that a rerun on an unchanged repository changes nothing. Each scenario in
[`scenarios.ts`](scenarios.ts) names a fixture under [`fixtures/`](fixtures/), its `origin`
remote, and what the record must contain.

| Fixture      | Shape                                                                   | Expected                                                              |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `storefront` | TypeScript, GitHub remote, `AGENTS.md` with its own tracker section, CI | GitHub record, glossary from the code, guardrails, old section folded |
| `ledger`     | pnpm monorepo, GitLab remote, `CLAUDE.md`                               | `CLAUDE.md` edited and no `AGENTS.md`, GitLab record                  |
| `greenfield` | README only, no remote                                                  | Local tracker in the state folder, no glossary                        |

## Run

```sh
node evals/setup-sh4dow-skills/run.ts --out <results-dir> \
  [--models anthropic/claude-opus-5-5] [--trials 1] [--only storefront,...] \
  [--concurrency 3] [--thinking high] [--timeout-minutes 30]
node evals/setup-sh4dow-skills/grade.ts <results-dir>
```

Each run copies its fixture into a fresh `/tmp/<fixture>-XXXXXX` git repository and runs the
skill twice there with this checkout's `SYSTEM.md`, skills, and prompts. The prompt tells the
candidate the user is away, so it takes every recommended answer. Remote owners are unregistered
names, so a stray `gh` or `glab` write fails instead of reaching a real project. Keep results in
the state folder, not in the repository.

## What the grade counts

Every check reads the working directory or its git state, never the transcript: the agent file
and its single `## Agent skills` block, each `docs/agents/` file, glossary terms that occur in
the code (from every `GLOSSARY.md`, so a multi-context layout counts), a clean tree after the first pass, and zero changes from the second.
