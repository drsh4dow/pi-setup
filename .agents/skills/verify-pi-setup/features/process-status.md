# Process status

Process status shows the user what background terminals the session owns, and gives the model a `session_usage` tool that reports cumulative tokens and cost.

## Sub-features

- `ps-active` prints `[ps] idle` or one line per running terminal with `/ps`.
- `ps-tracked` expands the latest `[ps]` entry to every tracked terminal with Ctrl-O.
- `ps-detail` shows one terminal's details with `/ps <id>`.
- `ps-usage` returns `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, and `usd` as JSON from the `session_usage` tool.

## How to get to it (user POV)

- Type `/ps`, or `/ps bt-1` for one terminal.
- Press Ctrl-O after a `/ps` entry.
- Ask the model for the session's token usage.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor.
- For `ps-active` with a job, `ps-tracked`, and `ps-detail`, the session has a running terminal. Start one with the first two steps of [background terminals](./background-terminals.md).

- **Idle.** Run `$CP send RUN /ps` and `$CP wait RUN '\[ps\] idle' 15`. The pane shows `[ps] idle`.
- **Running job.** With `bt-1` running, run `$CP send RUN /ps` and `$CP wait RUN '\[ps\] bt-1 \[running\]' 15`. The line reads `[ps] bt-1 [running] <title> · running · <seconds>s`.
- **Tracked view.** Run `$CP keys RUN C-o`. The `[ps]` entry expands and the footer still renders. Run `$CP doctor RUN` to confirm Pi did not crash.
- **Detail.** Run `$CP send RUN '/ps bt-1'` and wait for `bt-1` in a new `[ps]` entry.
- **Usage tool.** Run `$CP send RUN 'Call the session_usage tool once and reply with its JSON result only. Call no other tool.'` and `$CP wait RUN 'totalTokens' 120`. The reply holds the six fields, and `usd` is a number or `null`.
- **Proof.** Snap after each step.

## Gotchas

- `/ps` shows only terminals still running. A job that finished before the command shows `[ps] idle`.
- Ctrl-O also toggles tool-output expansion for the whole transcript. Snap before and after to show what changed.
- The usage numbers cover completed provider responses only, so the turn that calls the tool is not counted yet.
