---
name: verify-terminal-delivery
description: Model-check with TLA+ that a background terminal's end and its emit-to-pi notifications reach the model of the Pi session that started it, under any order of process events, tool calls, and Pi run phases. Use after changing agent/extensions/background-terminals/ or upgrading Pi, before reporting the change as working, and when `vp run verify` fails on `verify:terminal-delivery-citations`.
---

# Verify background terminal delivery

`bg_start` promises that a terminal's completion wakes the agent with its real exit, and that `emit-to-pi` sends the agent intermediate events. Three parties share that promise: the terminal manager (`manager.ts`, `session.ts`), the delivery queue (`delivery.ts`, `index.ts`), and Pi's run loop (`agent-session.js`, `agent-loop.js`). [`TerminalDelivery.tla`](TerminalDelivery.tla) models every order in which their callbacks run, and TLC checks all of them.

- **Properties.** A terminal that settles on its own reaches the model with its final state (`CompletionWakesAgent`). A terminal that `bg_kill` ends reaches the model through the kill's result (`KillReachesAgent`). When the user can abort, every terminal's end still reaches Pi's queue or the transcript for the model's next request, including the end of a terminal whose `bg_kill` wait the user aborted (`EndReachesPi`). A notification reaches the model on its own or inside the report of its terminal's end, which is the results message or the `bg_kill` result, unless the session ends first (`NotificationReachesAgent`). No end and no notification reaches the model in two messages, and a `bg_kill` result that reports an end or a notification counts as one (`NoDoubleWake`). An unattended run shuts down with a terminal still running only after the model read three still-running notices without calling a tool (`UnattendedRunOutwaitsTerminals`).
- **Harm.** The system prompt tells agents to end their turn and wait for the wake. A lost wake leaves a TUI session idle while the user waits for an answer, and makes a subagent report a pending status as its result. A double wake makes the agent act on one result twice.

"Reaches the model" means a later model request contains it. "Unattended" means a print or JSON run, or a subagent's TUI session. Both end when the run settles, so the `agent_before_settle` handler waits for running terminals.

## What the check covers

Run the check after any change to these files, or to the Pi version in `bun.lock`. Each `\* code:` citation in the spec names one of these functions, tools, or event handlers. Every model config runs the same spec, so they all cover the same code.

| File under `agent/extensions/background-terminals/` | Functions                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `delivery.ts`                                       | `queue`, `flush`, `drain`, `batch`, `enqueueNotification`, `takePending`, `takeNotifications`, `waitForDelivery`               |
| `index.ts`                                          | tools `bg_start`, `bg_status`, `bg_kill`; handlers `agent_before_settle`, `agent_settled`, `turn_end`; `MAX_IDLE_SETTLE_WAITS` |
| `manager.ts`                                        | `settle`, `terminate`, `appendNotification`                                                                                    |
| `session.ts`                                        | `join` (with its `kill`, `consume`, and `abandonKill`), `leave`                                                                |

The spec also cites Pi under `node_modules/`, as installed from `bun.lock`. In `pi-coding-agent`'s `agent-session.js`, it cites `sendCustomMessage`, `_startRun`, `_handlePostAgentRun`, `_runBeforeSettleBoundary`, `_emitAgentSettled`, `isIdle`, `isCompacting`, `abort`, and `_clearManualCompactionState`. In `pi-agent-core`'s `agent-loop.js`, it cites `runLoop`. The sync commit below has both packages at 1.2.0.

In sync at `5e34079ec0fd2fa4976b249a81866e3533bf50d7`. Move this commit forward only after you confirm that the model describes the code above at the new commit.

A change needs a model update when it adds, removes, or reorders a step that touches shared state. Shared state is `delivery.pending`, the settle waiter, a terminal's entry in the manager, Pi's steering queue and deferred actions, and whether Pi is running, settling, idle, or compacting. A change to rendering, output tails, or message text touches none of it.

## Run the check

From the checkout root:

```bash
.agents/skills/verify-terminal-delivery/scripts/check
```

It needs Java 11 or newer on `PATH`, or in `JAVA`. The first run downloads TLC 1.7.4 to `${XDG_CACHE_HOME:-~/.cache}/pi-setup/` and checks its sha256. A run takes about 20 s.

The script does three things:

1. It checks that every `\* code:` citation in the spec still matches the code. If one does not, it stops before any model runs, because a model that no longer matches the code proves nothing. A citation names a file, a function, and a line copied from that function's body. For a tool, the function is its `name`. For an event handler, it is the event. `vp run verify` runs this step alone, as `scripts/check --citations`.
2. It runs seven models that must hold. `Session.cfg` is a TUI session where the user can compact. `SessionNotifications.cfg` is a TUI session without compaction. `Aborts.cfg` adds user aborts. `UnattendedRun.cfg`, `UnattendedCompletion.cfg`, and `UnattendedRunHoldsNotification.cfg` are unattended runs. `AbortedKillIsSilent.cfg` is a TUI session with one terminal and user aborts, and checks `EndReachesPi`.
3. It runs two models that reproduce known findings and must be violated. See [Known findings](#known-findings).

Exit 0 means every citation is current and each model matched the `\* expect:` line at the top of its config. For a violated model, the script prints the broken property, such as `Invariant NoDoubleWake is violated` or `Temporal properties were violated`, then the counterexample as numbered steps. Each step names the action, the file and function it models, and the variables that changed. The full TLC output is in `${TMPDIR:-/tmp}/verify-terminal-delivery/`.

## Update the model for an intended change

1. List the changed hunks with `git diff` from the sync commit on the files in [What the check covers](#what-the-check-covers).
2. For each hunk, find the actions whose citation sits in it, or whose behavior it changes. Search the spec for the function name. Then read the changed function's callers, because the effect of a change often shows only at the call site. For example, whether `takePending` consumes its batches decides what the `agent_before_settle` handler delivers.
3. Edit each action to do what the new code does. One action is one callback that runs to completion, or the part of an async function between two awaits that another callback can observe. Name a new action after the code. Prefix it with `T` for the terminal, `Tool` for a tool call, `BS` for the `agent_before_settle` handler, `P` for Pi, or `User`. Add it to `PiStep` or `Next`, and put a `\* code:` citation above it. The last citation above an action labels it in traces. Add a newly cited function to the table in [What the check covers](#what-the-check-covers).
4. Run the check.

The update is done when the check exits 0, or when it fails only on a finding you report. If a property fails after a faithful update, the change broke it. Report the counterexample. The properties and `Fairness` stay as they are.

## Read a failure

- **`stale citation`.** The cited line changed or was deleted. Open the action above the citation and compare it with the new code. If the behavior is the same, copy the new line into the citation. If the behavior changed, update the action first. Then cite the line of the same function that now does what the action models. If no line does, delete the citation, and keep at least one citation above the action so that traces still label it.
- **`model error (TypeOK)`.** The spec gives a variable a value outside its type. Fix the spec.
- **`TLC error`.** TLC could not parse or evaluate the spec. The script prints the error lines.
- **`violated, expected holds`.** Walk the counterexample and open the cited code for each step. Then classify it:
  - **Modeling error.** A step does something the code cannot do, such as steering a message while Pi is idle. Fix that action to match the code.
  - **Timing artifact.** The model has no clock, so `BSWake` can time out at any moment. If the trace needs a 10-minute wait to end before a step that takes milliseconds, report the durations instead of calling it a bug.
  - **Real bug.** Every step is possible in the code, in that order. Report it as steps in the code's terms, such as "the terminal settles while `agent_settled` handlers run, so Pi defers its completion".
- **`holds, expected violated`.** The known finding no longer reproduces. Confirm which change fixed it, then update [Known findings](#known-findings) and the config's `\* expect:` line.

## What the model assumes

- **One event loop.** Each action runs without interruption. `Effect.runFork` runs `delivery.flush` before `queue` returns. Between the model's answer and the next request, Pi awaits other extensions' `agent_end` and `agent_settled` handlers, so terminal events can land there. Only this extension handles `agent_before_settle`.
- **The model.** It calls at most one tool per answer, and now and then it answers without one. `NotificationReachesAgent` needs that, because a notification waits for the run to settle by design.
- **Terminals.** A terminal may run forever and may send one notification. Exit, pipe close, and the process-group poll are one step, and so is the automatic termination after the pipe grace. A kill always ends the terminal, because `terminate` escalates to SIGKILL and then settles it.
- **Pi.** `pi.sendMessage` steers while a run is active, defers while `agent_settled` handlers run, and starts a run while idle. Steering drains one message per poll. `ctx.signal` is undefined during `agent_before_settle`, so an abort does not end the settle wait.
- **The user.** A TUI user may prompt, compact, or abort at any time, or never act again. Unattended runs have no user.
- **Aborts.** After an abort, a completion that was steered into the aborted run waits in Pi's queue or the transcript for the user's next prompt. That is Pi's design for queued messages, so `Aborts.cfg` checks only `NoDoubleWake`, and `AbortedKillIsSilent.cfg` checks that each end reaches Pi rather than the model (`EndReachesPi`).
- **Left out.** The 32-item queue eviction and `bg_list`'s `deliveryProblem`, the 256 KiB batch limit and the oversized completion that sends its notifications after it, the `agent_before_settle` error outcome, several clients that share one session, several `bg_kill` calls that wait on one terminal at once, session switches, and rendering.
- **Bounds.** Two terminals, except one in `UnattendedCompletion.cfg`, where two terminals reproduce [Completion deferred behind a run](#completion-deferred-behind-a-run). With three terminals, every model that must hold still held, in 13 minutes. Raise `Terminals` in a config to rerun that bound.

## Known findings

Each finding is a config that must be violated. The script prints one trace for each.

### Compaction holds notification

`CompactionHoldsNotification.cfg`. In a TUI session, a notification that arrives during `/compact`, or `/tree` with a summary, waits for the next completion, prompt, or settle. `queue` holds it because Pi is compacting, and compaction does not emit `agent_settled`.

### Completion deferred behind a run

`CompletionDeferredBehindRun.cfg`. A terminal settles while `agent_settled` handlers run, after this extension's handler flushed another message. Pi defers both messages. It runs the first as a new run and sends the second only after that run settles. In an unattended run, that run lasts as long as another terminal runs and the model keeps checking it. The window is the time other extensions' `agent_settled` handlers spend on I/O.
