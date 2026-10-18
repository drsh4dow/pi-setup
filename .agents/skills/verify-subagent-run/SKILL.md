---
name: verify-subagent-run
description: Model-check the pi-subagent run lifecycle with TLA+, so that no process of a run outlives its launcher under any order of kills. Use after changing agent/extensions/subagents/ or upgrading Pi or Effect, before reporting the change as working, and when `scripts/check` fails.
---

# Verify the subagent run lifecycle

`pi-subagent` runs a child Pi in a herdr pane. Four processes share one run directory: the launcher (`bin/pi-subagent.ts`), the pane child (`bin/pane-child.ts`), pi, and possibly a descendant Pi that an extension starts before pi's `session_start`. [`SubagentRun.tla`](SubagentRun.tla) models every order in which their steps and the kills can happen, and TLC checks all of them.

- **Property.** Once the launcher has exited, by any path including SIGKILL, the pane child, pi, and the descendant all exit too.
- **Harm.** A subagent that outlives its launcher keeps running its task, spending tokens and editing the worktree, after its parent thinks it is dead.

## Run the check

From the checkout root:

```bash
.agents/skills/verify-subagent-run/scripts/check
```

It needs Java 11 or newer on `PATH`, or in `JAVA`. The first run downloads TLC 1.7.4 to `${XDG_CACHE_HOME:-~/.cache}/pi-setup/` and checks its sha256. A run takes about 6 s. `vp run verify` does not run it.

The script does three things:

1. It checks that every `\* code:` citation in the spec still matches its file. A citation names a file, a function, and a line copied from the code.
2. It runs [`SubagentRun.cfg`](SubagentRun.cfg), the main model, which must hold.
3. It runs [`ShutdownHangs.cfg`](ShutdownHangs.cfg), which reproduces a known finding and must be violated. See [Known findings](#known-findings).

Exit 0 means every citation is current and each model matched the `\* expect:` line at the top of its config. For a violated model, the script prints the counterexample as numbered steps. Each step names the action, the file and function it models, and the variables that changed. The full TLC output is in `${TMPDIR:-/tmp}/verify-subagent-run/`.

## When a change needs the check

Run it after any change to these files:

- `agent/extensions/subagents/bin/pi-subagent.ts`, `bin/pane-child.ts`, `process-group.ts`, `herdr.ts`, `index.ts`, and `launch.ts`.
- A Pi or Effect upgrade. The spec cites Pi's `interactive-mode.js` and Effect's `NodeChildProcessSpawner.ts` under `node_modules/`.

The change needs a model update when it adds, removes, or reorders a step that touches shared state. Shared state is the run directory and its files (`started`, `launch.json`, `claim`, `exit`), the pane, a signal, or whether a process is alive. A change to logging, report text, or stdout touches none of it.

## Update the model for an intended change

1. List the changed hunks with `git diff` on the files above.
2. For each hunk, find the actions whose citation sits in it, or whose behavior it changes. Search the spec for the function name.
3. Edit each action to do what the new code does. Keep one action per step that another process can observe, and fold purely local work into the neighboring step. Name a new action after the code, prefix it with `L` (launcher), `C` (pane child), or `P` (Pi), add it to `LauncherStep`, `ChildStep`, or `PiStep`, and put a `\* code:` citation above it.
4. Run the check.

The update is done when the check exits 0, or when it fails only on a finding you report. If the property fails after a faithful update, the change broke it. Report the counterexample. The property, the fairness conditions, and `EnabledKills` stay as they are.

## Read a failure

- **`stale citation`.** The cited line changed. Open the action above the citation and compare it with the new code. If the behavior is the same, copy the new line into the citation. If the behavior changed, update the action first.
- **`model error (TypeOK)`.** The spec gives a variable a value outside its type. Fix the spec.
- **`TLC error`.** TLC could not parse or evaluate the spec. The script prints the error lines.
- **`SubagentRun.cfg: violated`.** Walk the counterexample and open the cited code for each step. Then classify it:
  - **Modeling error.** A step does something the code cannot do, such as reading a file the code reads later. Fix that action to match the code.
  - **Timing artifact.** The model has no clock, so a trace can need a step to finish faster than the code can. An example is pi registering its signal handlers microseconds after it spawns. Report the durations involved instead of calling it a bug.
  - **Real bug.** Every step is possible in the code, in that order. Report it as steps in the code's terms, such as "the launcher reads no `started`, then the pane child writes `started`".
- **`ShutdownHangs.cfg: holds`.** The known finding no longer reproduces. Confirm which change fixed it, then update [Known findings](#known-findings) and the config's `\* expect:` line.

## What the model assumes

- **Process group.** Pi and the descendant stay in the pane child's process group, the group whose id is in `started`. A process that leaves it, such as a background terminal's job, is outside the model.
- **Hangups.** The pane child is the controlling process of the pane's terminal. Closing the pane sends it SIGHUP. When it exits, the kernel sends SIGHUP to the group and herdr removes the pane.
- **Pi's signals.** Before `InteractiveMode.init` registers its handlers, SIGTERM or SIGHUP ends Pi. After that, either signal starts a graceful shutdown. `SubagentRun.cfg` assumes every graceful shutdown finishes. `ShutdownHangs.cfg` lets one never finish.
- **Pi's progress.** Nothing else Pi does is assumed. It can stop at a startup prompt, work forever, or crash at any step.
- **Kills.** SIGKILL ends a process at once. Each kill arrives at most once and at any moment. The kills are SIGTERM to the launcher (SIGINT and SIGHUP behave the same), SIGKILL to the launcher, an external close of the pane, and SIGKILL to the pane child.
- **herdr.** Every herdr call succeeds. Once told to run the pane child in an open pane, herdr eventually starts it.
- **Time.** The 60 s session deadline is one boolean that turns true. Grace periods, poll intervals, and bg_kill's 2 s escalation are orderings only.
- **Scope.** One run, one descendant at most, and no pid reuse. The comment on `launcherExit` in `pane-child.ts` argues against pid reuse.

`SubagentRun.cfg` explores 62,310 distinct states to depth 29. The check leaves out what the launcher reports and its exit code, stderr forwarding, the `pi --print` fallback, input locking and dialogs, the sweep of abandoned panes, and `herdr-agent-state.ts`, which only reports pane state to herdr. It also leaves out cleanup of the run directory and the pane. A SIGKILL to the launcher after `openPane` and before herdr starts the pane child leaves both behind, including `launch.json`, which holds the launcher's environment.

## Known findings

`ShutdownHangs.cfg` shows pi outliving the launcher when pi's graceful shutdown never ends. A `session_shutdown` handler that never returns makes that happen, because Pi awaits `runtimeHost.dispose()` with no timeout. The script prints this trace:

1. The launcher gets SIGTERM. Its release finds `started` and sends SIGTERM to pi's process group.
2. Pi starts a graceful shutdown that never ends. The pane child's SIGTERM handler interrupts `runPi`, which stops the race with `launcherExit`.
3. The interrupted scope releases pi. Effect's spawner sends SIGTERM to pi alone and then waits for pi to exit, without a SIGKILL, because the spawn sets no `forceKillAfter`.
4. The launcher gets SIGKILL during its 1.5 s `TERM_GRACE`, before it sends SIGKILL to the group.
5. Nothing is left to send SIGKILL. Pi and the pane child run on, and the run directory and the pane stay.

bg_kill sends SIGKILL 2 s after SIGTERM, so step 4 needs the launcher to take more than 0.5 s to reach its group SIGTERM. A shorter escalation, such as `timeout -k 1`, makes it likelier. With `DescendantStarts = TRUE`, the same hang has a second path. When pi exits while the launcher is already dead, the pane child exits without stopping the group, and a descendant gets only the kernel's SIGHUP.
