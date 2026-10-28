# pi-setup verification map

This directory is the maintained source for verifying what a user of this Pi configuration sees. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run commands from the checkout root with `CP=.agents/skills/verify-pi-setup/scripts/control-pi`. Shell variables do not survive between tool calls, so start every call that runs a `$CP` step with `CP=.agents/skills/verify-pi-setup/scripts/control-pi;`. Every feature file's `$CP` steps assume it.
- Launch with `$CP launch <RUN_ID>` and pass `$CP doctor <RUN_ID>` before the first drive.
- The instance starts from `agent/default.settings.json`, so Fast mode is on and the model is `anthropic/claude-opus-5-5` with `high` thinking.
- The instance's working directory is the empty scratch `workspace`, so the header shows `workspace` as the project.
- Never drive an instance that this run did not launch.

## Driving conventions

- Start each recipe from a fresh launch unless it says otherwise. Model turns add history that later recipes do not expect.
- Wait on the exact notice or line a step names with `$CP wait`, and on a prompt's turn end with `$CP wait-turn`, never on a fixed sleep.
- Treat quoted prompts and slash commands as literal.
- Read side effects from `$($CP path <RUN_ID> agent)`, never from the live `~/.pi/agent`.
- Restore nothing by hand. `$CP stop` deletes the scratch state and keeps the evidence.

## Proof and skip reporting

- Snap the pane before and after each user action with `$CP snap`.
- Copy each side-effect file into `$($CP path <RUN_ID> evidence)` next to the snaps.
- Record the feature file and the entry point with every artifact, for example `fast-mode.shortcut.after.txt`.
- Report an unreachable entry point with the command tried and the missing precondition.
- Report a skipped entry point as skipped, never as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on the user-visible behavior. It then has exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-pi` starts with `Preconditions:` and pairs each user action with an exact command and an observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

Keep implementation details out of the map. Name user paths, stable strings, required state, commands, and observable proof.

## Features

- [Fast mode](./fast-mode.md) covers `/fast`, Ctrl-Alt-M, the footer indicator, and the persisted setting. No model turn.
- [Skill visibility](./skill-visibility.md) covers `/skill-visibility` toggling and hidden `/skill:` autocomplete entries. No model turn.
- [Process status](./process-status.md) covers `/ps`, `/ps <id>`, Ctrl-O, and the `session_usage` tool.
- [Background terminals](./background-terminals.md) covers model-started jobs, the `bg` footer count, and the completion wake-up.
- [Session chrome](./session-chrome.md) covers the header, the session timer, and the per-response throughput line.
- [Architecture review](./architecture-review.md) covers `/skill:improve-codebase-architecture` from the scan through grilling, architect, arena, and the sketch review to the checkpoint.
- [Router](./router.md) covers general mode's `<router>`: a spec request routed to `to-spec` with its steps kept out of the reply and its skipped steps on the last line, a task no row matches, the model's skill table, and `/skill:to-spec` by hand.
- [Tool-call guards](./tool-call-guards.md) covers the host guard and `delegate-guard` refusing and allowing bash calls in a root and a delegate session.

Not yet mapped: the `pi-subagent` launcher and Herdr panes (`subagents`), `sacrifice-preference`, `prompt-context`, and the prompt templates (`/deslop`, `/handoff`, `/bro`, `/restate-sharpened`).
