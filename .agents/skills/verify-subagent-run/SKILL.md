---
name: verify-subagent-run
description: Model-check the pi-subagent run lifecycle with TLA+, so that no process of a run outlives its launcher under any order of kills. Use after changing agent/extensions/subagents/ or upgrading Pi or Effect, before reporting the change as working, and when `scripts/check` fails or `vp run verify` fails on `verify:subagent-run-citations`.
---

# Verify the subagent run lifecycle

`pi-subagent` runs a child Pi in a herdr pane. Four processes share one run directory: the launcher (`bin/pi-subagent.ts`), the pane child (`bin/pane-child.ts`), pi, and possibly a descendant Pi that an extension starts before pi's `session_start`. When the `pi` command is a wrapper that forks Pi, such as a Volta shim, the wrapper is a fifth. [`SubagentRun.tla`](SubagentRun.tla) models every order in which their steps and the kills can happen, and TLC checks all of them.

- **Properties.** Once the launcher has exited, by any path including SIGKILL, the pane child, pi, and the descendant all exit too (`NoProcessOutlivesLauncher`). Once any kill arrives, the launcher exits (`KillEndsRun`). Once all of them have exited, the run directory and the pane are gone (`NoRunLeftBehind`). Pi never leaves the run to another Pi, and the descendant never claims it (`OnlyPiTakesTheTask`).
- **Harm.** A subagent that outlives its launcher keeps running its task, spending tokens and editing the worktree, after its parent thinks it is dead. A launcher that a kill does not end leaves its caller waiting forever. A run directory left behind keeps `launch.json`, which holds the launcher's environment, and a pane left behind clutters the parent's workspace. A descendant that takes the task runs it without the launcher's arguments, such as its model, and pi never ends the run. A pi that leaves the run to another Pi fails it after 60 s.

## What the check covers

Run the check after any change to these files, or to the Pi or Effect version in `bun.lock`. Each `\* code:` citation in the spec names one of these functions. Every model config runs the same spec, so they all cover the same code.

| File under `agent/extensions/subagents/` | Functions                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/pi-subagent.ts`                     | `main`, `runInPane`, `observeChild`, `addObserver`, `awaitChild`, `stopPiGroup`, `closePane`, `SIGNAL_EXIT_CODES`                     |
| `bin/pane-child.ts`                      | `runPaneChild`, `runPi`, `watchLauncher`, `launcherExit`, `abandonRun`                                                                |
| `process-group.ts`                       | `stopProcessGroup`                                                                                                                    |
| `herdr.ts`                               | `sweepAbandonedRuns`, `removeAbandonedRun`, `runOwnerAlive`                                                                           |
| `index.ts`                               | `claimRun`, `deliverTask`, `finish`, `stopChildrenInheritingRun`                                                                      |
| `launch.ts`                              | `runFiles`, `runDirectoryPrefix`, `parseRunDirectoryName`, `runFlag`, modeled as the run directory's files and name, with no citation |

The spec also cites Pi's `interactive-mode.js` (`init`, `shutdown`, `uncaughtCrash`) and Effect's `NodeChildProcessSpawner.ts` (`terminateProcessGroup`) under `node_modules/`, as installed from `bun.lock`. The sync commit below has `@earendil-works/pi-coding-agent` 1.2.0 and `effect` 4.0.4.

In sync at `5e34079ec0fd2fa4976b249a81866e3533bf50d7`. Move this commit forward only after you confirm that the model describes the code above at the new commit.

A change needs a model update when it adds, removes, or reorders a step that touches shared state. Shared state is the run directory and its files (`started`, `launch.json`, `claim`, `exit`), the pane, a signal, or whether a process is alive. A change to logging, report text, or stdout touches none of it.

## Run the check

From the checkout root:

```bash
.agents/skills/verify-subagent-run/scripts/check
```

It needs Java 11 or newer on `PATH`, or in `JAVA`. The first run downloads TLC 1.7.4 to `${XDG_CACHE_HOME:-~/.cache}/pi-setup/` and checks its sha256. A run takes about 50 s.

The script does three things:

1. It checks that every `\* code:` citation in the spec still matches the code. If one does not, it stops before any model runs, because a model that no longer matches the code proves nothing. A citation names a file, a function, and a line copied from that function's body. The body includes the comment block directly above the definition. A definition whose first line ends in `;` is that one line, and a top-level statement whose first line names the function, such as `fiber.addObserver((exit) => {`, is part of its body through the line that closes it. `vp run verify` runs this step alone, as `scripts/check --citations`.
2. It runs three models that must hold. [`SubagentRun.cfg`](SubagentRun.cfg) is the main model. [`ShutdownHangs.cfg`](ShutdownHangs.cfg) lets pi's graceful shutdown hang. [`ForkingPi.cfg`](ForkingPi.cfg) is the main model with a `pi` command that forks Pi.
3. It runs [`DescendantShutdownHangs.cfg`](DescendantShutdownHangs.cfg) and [`ForkingPiShutdownHangs.cfg`](ForkingPiShutdownHangs.cfg), which reproduce known findings and must be violated. See [Known findings](#known-findings).

Exit 0 means every citation is current and each model matched the `\* expect:` line at the top of its config. For a violated model, the script prints the broken property, such as `Invariant OnlyPiTakesTheTask is violated` or `Temporal properties were violated`, then the counterexample as numbered steps. Each step names the action, the file and function it models, and the variables that changed. The full TLC output is in `${TMPDIR:-/tmp}/verify-subagent-run/`.

## Update the model for an intended change

1. List the changed hunks with `git diff` from the sync commit on the files in [What the check covers](#what-the-check-covers).
2. For each hunk, find the actions whose citation sits in it, or whose behavior it changes. Search the spec for the function name.
3. Edit each action to do what the new code does. Keep one action per step that another process can observe, and fold purely local work into the neighboring step. Name a new action after the code, prefix it with `L` (launcher), `C` (pane child), or `P` (Pi), add it to `LauncherStep`, `ChildStep`, or `PiStep`, and put a `\* code:` citation above it. Add a newly cited function to the table in [What the check covers](#what-the-check-covers).
4. Run the check.

The update is done when the check exits 0, or when it fails only on a finding you report. If the property fails after a faithful update, the change broke it. Report the counterexample. The properties, the fairness conditions, and `EnabledKills` stay as they are.

## Read a failure

- **`stale citation`.** The cited line changed. Open the action above the citation and compare it with the new code. If the behavior is the same, copy the new line into the citation. If the behavior changed, update the action first.
- **`model error (TypeOK)`.** The spec gives a variable a value outside its type. Fix the spec.
- **`TLC error`.** TLC could not parse or evaluate the spec. The script prints the error lines.
- **`violated, expected holds`.** Walk the counterexample and open the cited code for each step. Then classify it:
  - **Modeling error.** A step does something the code cannot do, such as reading a file the code reads later. Fix that action to match the code.
  - **Timing artifact.** The model has no clock, so a trace can need a step to finish faster than the code can. An example is pi registering its signal handlers microseconds after it spawns. Report the durations involved instead of calling it a bug.
  - **Real bug.** Every step is possible in the code, in that order. Report it as steps in the code's terms, such as "the launcher reads no `started`, then the pane child writes `started`".
- **`holds, expected violated`.** The known finding no longer reproduces. Confirm which change fixed it, then update [Known findings](#known-findings) and the config's `\* expect:` line.

## What the model assumes

- **Process group.** Pi and the descendant stay in the pane child's process group, the group whose id is in `started`. A process that leaves it, such as a background terminal's job, is outside the model.
- **Hangups.** The pane child is the controlling process of the pane's terminal. Closing the pane sends it SIGHUP. When it exits, the kernel sends SIGHUP to the group and herdr removes the pane.
- **Pi's signals.** Before `InteractiveMode.init` registers its handlers, SIGTERM or SIGHUP ends Pi. After that, either signal starts a graceful shutdown. `SubagentRun.cfg` assumes every graceful shutdown finishes. The configs whose names end in `ShutdownHangs` let one never finish.
- **Run flag.** The pane child passes `--subagent-run=<run directory>` to the `pi` command, and a wrapper passes its arguments on to Pi. A descendant has only the arguments that its extension gives it.
- **Wrapper.** With `PiForks`, the pane child spawns a wrapper that forks Pi into the same process group and waits for it, as a Volta shim does. The wrapper handles neither SIGTERM nor SIGHUP, as the shim in the review's reproduction does not, so a signal to the wrapper alone leaves Pi running.
- **Pi's progress.** Nothing else Pi does is assumed. It can stop at a startup prompt, work forever, or crash at any step.
- **Kills.** SIGKILL ends a process at once. Each kill arrives at most once and at any moment. The kills are SIGTERM to the launcher (SIGINT and SIGHUP behave the same), SIGKILL to the launcher, an external close of the pane, and SIGKILL to the pane child.
- **herdr.** Every herdr call succeeds. Once told to run the pane child in an open pane, herdr eventually starts it.
- **Sweeps.** Some later sweep runs, because each `pi-subagent` run and each Pi that starts in herdr runs one. A sweep reads the launcher's pid from the run directory's name and the pane child's pid from `started`, so its reading can be stale when it acts.
- **Time.** The 60 s session deadline is one boolean that turns true. Grace periods, poll intervals, and bg_kill's 2 s escalation are orderings only.
- **Scope.** One run, one descendant at most, and no pid reuse. The comment on `launcherExit` in `pane-child.ts` argues against pid reuse.

`SubagentRun.cfg` explores 85,086 distinct states to depth 30. The check leaves out what the launcher reports and its exit code, stderr forwarding, the `pi --print` fallback, input locking and dialogs, and `herdr-agent-state.ts`, which only reports pane state to herdr. It models a sweep only as it acts on this run's directory and pane.

## Known findings

`DescendantShutdownHangs.cfg` shows a descendant outliving the launcher when the descendant's graceful shutdown never ends. A `session_shutdown` handler that never returns makes that happen, because Pi awaits `runtimeHost.dispose()` with no timeout. The script prints one trace. Every trace has these steps:

1. The pane child leaves `runPi`, because pi exited or a signal interrupted it. That ends `watchLauncher`, the fiber that polls the launcher's pid, and its last look finds the launcher alive.
2. The launcher exits without stopping pi's process group. SIGKILL ends it, or its release ran before the pane child wrote `started`.
3. The pane child exits. The kernel sends SIGHUP to the group, and the descendant starts a graceful shutdown that never ends.
4. Nothing is left to send SIGKILL, so the descendant runs on.

The launcher's release waits `EXITED_PI_GROUP_GRACE` (1 s) and then `TERM_GRACE` (1.5 s) before its SIGKILL, so bg_kill's SIGKILL 2 s after SIGTERM can land in step 2. Closing the gap would need the pane child to outlive every other process in its group. `kill(-group, 0)` cannot show whether the group holds any other process, because the pane child is in it.

`ShutdownHangs.cfg` was violated until `watchLauncher` outlasted the release of pi and the spawn of pi set `forceKillAfter`. Before that, a SIGTERM to the launcher reached the pane child through the group and interrupted `runPi`, which also ended the watch. The release then waited for pi without a limit, so a SIGKILL to the launcher during its `TERM_GRACE` left pi and the pane child running. When herdr closed the pane while pi's shutdown hung, the pane child waited for pi and the launcher polled forever. `KillEndsRun` catches that path.

`ForkingPiShutdownHangs.cfg` shows the same finding for pi itself when the `pi` command forks Pi. The pane child's handle is the wrapper, so the release's SIGTERM and its `forceKillAfter` SIGKILL reach only the wrapper. Pi gets only the kernel's SIGHUP when the pane child exits, as a descendant does.
