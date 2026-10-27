---
name: verify-pi-setup
description: Drive this repository's Pi configuration (extensions, skills, prompts, SYSTEM.md, keybindings) in an isolated Pi TUI under tmux and capture proof. Use before reporting a change to an extension, a setting, or resource loading as working, and to reproduce a TUI bug in this repo.
---

# Verify pi-setup

The product is Pi as this checkout configures it. A user touches the Pi TUI: slash commands, keybindings, the header and footer, and the tools the model calls. `scripts/control-pi` starts that TUI in tmux against a scratch agent directory, so a run never reads or writes the live `~/.pi/agent` beyond one credential refresh. Run every command from the checkout root:

```bash
CP=.agents/skills/verify-pi-setup/scripts/control-pi
```

The helper drives the checkout it lives in, so a git worktree verifies its own branch. Read [`features/README.md`](features/README.md) before driving, then follow the matching feature file.

## Launch

1. Run `vp install` once per checkout. Extensions load from the checkout and need its `node_modules` and `.build/bin`.
2. Run `$CP launch [RUN_ID]`. It prints `run=`, `scratch=`, `evidence=`, and an `attach=` command for a human. Ready means the footer context gauge (`0.0%/1.0M`) has rendered, at which point the header, banner, and every extension have loaded.

Launch builds the scratch state from the checkout every time:

- `settings.json` is `agent/default.settings.json` plus an `extensions` entry pointing at the checkout's `agent/extensions`. The live `agent/settings.json` is never read.
- `SYSTEM.md`, `keybindings.json`, `skills/`, `prompts/`, and `themes/` are copies. Edit the checkout and relaunch to pick up a change. Extensions load in place, but Pi reads them at startup, so relaunch after editing them too.
- Pi runs with `--no-skills --skill <scratch>/agent/skills`, which keeps out `~/.agents/skills` and any project skills.
- `auth.json` is a copy of the live one. Launch first refreshes each OAuth token with less than 30 minutes left, in the live directory under Pi's lock, so the scratch copy does not refresh and rotate a token the live session still holds.
- `PI_*` and `HERDR_*` variables from the caller are dropped, and `HERDR_ENV=0` keeps the instance out of Herdr.

Runs are isolated by run ID and can run side by side. A run ID uses only letters, digits, `_`, and `-`, because tmux reads `.` and `:` in a target as separators. Each uses its own tmux session `vps-<RUN_ID>` on the dedicated tmux socket `verify-pi-setup`. Drive only runs you launched. Never attach to or send keys to the user's own Pi.

## Doctor

Run `$CP doctor RUN_ID` before the first drive and again after anything surprising. It is read-only and exits non-zero on any `FAIL` line. It checks that the scratch directory exists, the tmux pane is alive, the `pi` process uses the scratch agent directory with `HERDR_ENV=0`, extensions point at this checkout, the stderr log has no errors, and the footer is rendered. Its `info` lines give the checkout commit (and whether `agent/` has uncommitted changes), the Pi version, and the minutes left on each OAuth token.

A `FAIL` on stderr usually means an extension failed to load. Read `$($CP path RUN_ID scratch)/pi.stderr.log`, then stop the run and relaunch after the fix.

## Drive

| Command                                              | Effect                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$CP send RUN_ID 'TEXT'`                             | Type `TEXT` literally into the editor, then press Enter. Use it for prompts, slash commands, and `!` shell commands. It records the session file's length, which `wait-turn` scans from. |
| `$CP keys RUN_ID KEY...`                             | Send tmux key names, such as `C-o`, `Escape`, `Enter`, `Down`, `C-u`, or `C-M-m` for Ctrl-Alt-M. `-l TEXT` types without Enter.                                                          |
| `$CP wait-turn RUN_ID [SECS]`                        | Wait until the turn of the prompt last sent with `send` ends, even when it ended before the wait started (60 s default).                                                                 |
| `$CP wait-idle RUN_ID [SECS]`                        | Wait until no turn runs, no sent prompt is unread, no background job or subagent of the run is left, and the session file has not changed, all for 2 s (60 s default).                   |
| `$CP wait RUN_ID 'ERE' [SECS]`                       | Poll the visible pane until it matches the extended regex (60 s default).                                                                                                                |
| `$CP capture RUN_ID`                                 | Print the visible pane.                                                                                                                                                                  |
| `$CP snap RUN_ID NAME`                               | Save the visible pane to `EVIDENCE/NAME.txt` and print the path.                                                                                                                         |
| `$CP path RUN_ID scratch\|agent\|evidence\|sessions` | Print a run directory, such as the scratch `agent/` that holds `settings.json`, or `sessions`, which holds the run's session `.jsonl` files.                                             |
| `$CP list`                                           | List runs that still have scratch state.                                                                                                                                                 |

After a prompt, wait on its turn end with `wait-turn`. The previous turn's footer, such as `TPS`, stays on screen while the next turn runs, so a `wait` on footer text returns at once. Use `wait-idle` when the turn starts a background job or a subagent and the drive must wait through the turn that the job's result starts. Use `wait` for a string an action puts on screen, such as a notice. Never wait on a fixed sleep.

`wait-turn` follows the `send` that was last when the wait started, so send the next prompt only after the wait returns. After a `send` that starts no turn, such as `/fast`, it times out with `no turn started since the last send`, and `wait-idle` waits out its timeout too, so follow such a send with `wait` on the notice it shows. Every wait fails at once on a run that does not exist, or that has scratch state but no tmux session, because it is still launching or its session was killed (wait for `launch` to print `run=`, or stop and relaunch it). A wait fails with Pi's stderr when Pi exits.

The TUI is fullscreen, so `capture` shows only the visible screen. Snap each state before the next action pushes it away.

A prompt to the model is a real request on the user's subscription. Keep prompts short, name the exact tool calls, and forbid others, as the feature files do.

## Evidence

Evidence lives in `~/.local/state/pi-agent/verify-pi-setup/<RUN_ID>/` and survives `stop`. A proof holds:

- A snap of the state before the action, and a snap after it.
- The side effect read from its real location, copied into the evidence directory. Examples are `settings.json` in the scratch `agent/`, a scratch `SKILL.md`, or a process listing.
- The doctor output from the start of the run.
- `pi.stderr.log`, which `stop` copies in.

Drive the user path, meaning keys, slash commands, and model prompts. Do not call extension functions or edit scratch files to fake a state. A notice alone is not proof when the feature has a side effect, so read the side effect too.

## Cleanup

Run `$CP stop RUN_ID` after the last drive, and after every failed launch or drive. It is idempotent. It copies the stderr log into the evidence directory, kills the tmux session, kills every process that carries the run's `VERIFY_PI_SETUP_RUN` marker (background jobs included), and deletes the scratch directory. It never touches the evidence directory or another run. If it warns that the run refreshed a credential, tell the user, because the live session may need `/login`.

A failed launch saves `launch-failure.pane.txt` and `launch-failure.stderr.log` to the evidence directory and stops itself.
