# Fast mode

Fast mode lets a user switch Anthropic's fast output mode on and off for the models listed under `fastMode` in settings. The footer shows `⚡︎ Fast` while it applies to the current model, and the choice persists in `settings.json`.

## Sub-features

- `fast-command` toggles with `/fast` and announces the new state.
- `fast-shortcut` toggles with Ctrl-Alt-M.
- `fast-indicator` shows `⚡︎ Fast` in the footer only while Fast mode is on for a listed model.
- `fast-persist` writes `fastMode.enabled` to the agent directory's `settings.json`.
- `fast-unlisted` warns instead of enabling when the current model is not listed.

## How to get to it (user POV)

- Type `/fast` and press Enter.
- Press Ctrl-Alt-M.
- Switch to an unlisted model with Alt-P, then use either entry point.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor. The footer shows `(anthropic) claude-opus-5-5` and `⚡︎ Fast`.
- `jq .fastMode.enabled "$($CP path RUN agent)/settings.json"` prints `true`.

- **Baseline.** Run `$CP snap RUN fast-mode.before`. The snap shows `⚡︎ Fast` on the last footer line.
- **Turn off with the command.** Run `$CP send RUN /fast` and `$CP wait RUN 'Fast mode disabled\.' 15`. The `⚡︎ Fast` line disappears from the footer. `jq .fastMode.enabled "$($CP path RUN agent)/settings.json"` prints `false`.
- **Turn on with the shortcut.** Run `$CP keys RUN C-M-m` and `$CP wait RUN 'Fast mode enabled \(speed: fast' 15`. The notice reads `Fast mode enabled (speed: fast, betas: ["fast-mode-2026-02-01"]).`, the footer shows `⚡︎ Fast` again, and the setting reads `true`.
- **Switch to an unlisted model.** Run `$CP keys RUN M-p`. The footer shows `(openai) gpt-6.1-sol` and drops `⚡︎ Fast`, though the setting is still `true`.
- **Toggle on an unlisted model.** Run `$CP send RUN /fast` and wait for `Fast mode disabled\.`. Run `$CP send RUN /fast` again and `$CP wait RUN 'is not listed in the fastMode setting' 15`. The notice reads `Warning: Fast mode enabled, but openai/gpt-6.1-sol is not listed in the fastMode setting.`, the footer still has no `⚡︎ Fast`, and the setting reads `true`.
- **Proof.** Run `$CP snap RUN fast-mode.after` and `cp "$($CP path RUN agent)/settings.json" "$($CP path RUN evidence)/fast-mode.settings.json"`. The snaps show both notices, and the copied file holds the final `fastMode.enabled` value.

## Gotchas

- A Pi session named `subagent: …` skips Fast mode for providers with `subagentsEnabled: false`. `control-pi` cannot name the session, so that path stays unverified here.
- The footer redraws after the notice. Wait for the indicator state separately from the notice.
- Alt-P follows `enabledModels` order from the current model. Read the footer after each press instead of counting presses.
- The setting lives in the scratch agent directory. The live `~/.pi/agent/settings.json` never changes, so reading it proves nothing.
