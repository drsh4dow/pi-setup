# Architecture review

`/skill:improve-codebase-architecture` scans a project for shallow modules, writes an HTML report, and asks which candidate to explore. Grilling settles the chosen candidate one round at a time. Architect then designs the deepened module through arena, one sketch reviewer per model reviews the synthesized sketch, and the checkpoint grills the user on what the review left open before any implementation.

## Sub-features

- `review-autocomplete` shows `improve-codebase-architecture` and `grill-with-docs` in `/skill:` suggestions and hides `grilling`, `codebase-design`, and `domain-modeling`.
- `review-report` writes `architecture-review-<timestamp>.html` to the temp directory and ends the turn on `Which of these would you like to explore?`.
- `review-grilling` asks numbered rounds (`❓ **Q1**`) with a recommended answer each, and `yes` accepts them.
- `review-architect` reads the architect, arena, and codebase-design skills and launches arena runners under different design constraints, then a cross-judge.
- `review-sketch` reads architect's `references/sketch-reviewer-prompt.md` and launches one reviewer per model on the synthesized sketch.
- `review-checkpoint` stops on a grilling round about the sketch, with no implementation in the project.

## How to get to it (user POV)

- Type `/skill:improve-codebase-architecture` in a project, optionally followed by the area to scan.
- Answer the report's question with the candidate to explore, then answer each grilling round.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor, with OpenAI credentials good for the whole run, since arena and the sketch review seat a GPT model.
- The scratch `workspace` holds a project with shallow modules as a git repository. Copy `evals/principle-loading/fixtures/request-pipeline` into it, then `git init -q -b main && git add -A && git commit -qm "Initial commit"`.
- Run `$CP send RUN /fast` to turn Fast mode off. The run launches many subagents.

- **Autocomplete.** For each prefix `gril`, `codebase-d`, `domain-m`, and `improve`, run `$CP keys RUN -l '/skill:<prefix>'`, snap, and run `$CP keys RUN C-u`. Only `grill-with-docs` and `improve-codebase-architecture` appear.
- **Report.** Run `$CP send RUN "/skill:improve-codebase-architecture Don't open the report in a browser, just print its path."` and `$CP wait RUN 'like to explore' 1500`. The reply names the report path. Copy the report into the evidence directory.
- **Grilling.** Run `$CP send RUN 'Explore your top recommendation.'` and `$CP wait-turn RUN 1500`, then send `yes` after each round that ends the turn. Grilling ends on a summary that asks `Is this the shared understanding?`. Send `yes` to it as well, and the session reads `architect/SKILL.md`.
- **Architect and sketch review.** Wait on each turn's end with `$CP wait-turn RUN 1500`, and on the reviewers with `$CP wait-idle RUN 3600`. The session reads `arena/SKILL.md` and `architect/references/sketch-reviewer-prompt.md`, and `bg_start` launches `pi-subagent` runners named for the arena and the sketch reviewers.
- **Checkpoint.** After the reviewers report, a turn ends on a grilling round (`❓ **Q1**`) about the sketch, with the review's fixed findings listed above it. `git -C "$($CP path RUN scratch)/workspace" status --short` shows no change to the existing source files. Stop here, without answering.
- **Proof.** Copy the session file from `$($CP path RUN sessions)` into the evidence directory before `$CP stop RUN`.

## Gotchas

- The session's system prompt lists every model-visible skill with its `SKILL.md` path, so a grep of the session file for `arena/SKILL.md` matches before the skill is read. Count only tool-call arguments that name the path.
- While arena's runners or the sketch reviewers run, the parent can end a turn with a pending status. Answer only a turn whose last message asks a question, and let a completion start the next turn.
- The report step runs `xdg-open` unless the prompt says not to, which opens a browser on the operator's desktop.
- A run on the `request-pipeline` fixture took 40 minutes from the first prompt to the checkpoint and launched five subagents: two runners, the cross-judge, and two reviewers. Keep the fixture small.
- Answering the checkpoint round with `yes` starts the implementation. The proof ends at the checkpoint.
