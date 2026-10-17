# Session chrome

Session chrome is what the user reads around the conversation. The header names the model and project, a timer shows how long the branch has run since the first message, and each response ends with its output-token throughput.

## Sub-features

- `chrome-header` shows `PI / <model id> / <project directory name>` centered on the top rule.
- `chrome-timer` shows `⏱ <duration>` under each response and in the footer, starting at the first user message.
- `chrome-tps` adds a `TPS <rate> tok/s.` line with token counts and elapsed seconds after each response.

## How to get to it (user POV)

- Start Pi and read the top line.
- Send any prompt and read the end of the response and the footer.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor, and no prompt has been sent yet.

- **Header at startup.** Run `$CP snap RUN chrome.startup`. The top line contains `PI / claude-opus-5-5 / workspace`, and the pane has no `⏱` and no `tok/s`.
- **First turn.** Run `$CP send RUN 'Reply with the single word ready. Do not use any tools.'` and `$CP wait RUN 'TPS [0-9.]+ tok/s\.' 120`.
- **Timer and throughput.** Run `$CP snap RUN chrome.after-turn`. Under the reply, `⏱ <n>s` is followed by `TPS <rate> tok/s. out <n>, in <n>, cache r/w <n>/<n>, total <n>, <s>s`. The footer's last line also shows `⏱ <n>s`.
- **Model switch.** Run `$CP keys RUN M-p` and snap. The header's model segment matches the new model in the footer.

## Gotchas

- The header shows the scratch `workspace` directory, not the checkout, because launch starts Pi there.
- The timer counts from the first user message on the current branch, so it resets after `/tree` moves to a branch with no messages.
- `agent/extensions/test/e2e.test.ts` still expects a `done – <n> tok/s` line. The tracker prints `TPS <rate> tok/s.` instead, so trust the pane over that test.
