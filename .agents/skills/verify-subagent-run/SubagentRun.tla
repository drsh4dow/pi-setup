---------------------------- MODULE SubagentRun ----------------------------
(***************************************************************************)
(* The lifecycle of one pi-subagent run in herdr. Four processes share the *)
(* run directory: the launcher (bin/pi-subagent.ts runInPane), the pane    *)
(* child (bin/pane-child.ts runPaneChild), pi, and a descendant Pi that an *)
(* extension starts before pi's session_start, which inherits              *)
(* PI_SUBAGENT_RUN. When the pi command is a wrapper that forks Pi, such  *)
(* as a Volta shim, the wrapper is a fifth process. Kills arrive in any    *)
(* order.                                                                  *)
(*                                                                         *)
(* Each action is one step that touches state another process can see,    *)
(* and the comment above it cites the code as                              *)
(*   \* code: <file> <function> "<snippet>"                                *)
(* scripts/check fails when a cited snippet is no longer in its file.      *)
(***************************************************************************)
EXTENDS Naturals

\* TRUE: a session_shutdown handler may never return, so pi's graceful shutdown never ends.
CONSTANT ShutdownCanHang

\* The kills the environment may send, a subset of Kills.
CONSTANT EnabledKills

\* TRUE: an extension may start a Pi before pi's session_start, and that Pi inherits the run.
CONSTANT DescendantStarts

\* TRUE: the pi command is a wrapper that forks Pi, so the pane child spawns and awaits the wrapper.
CONSTANT PiForks

Pis == {"pi", "descendant"}

VARIABLES
    files,            \* entries of the run directory; "dir" is the directory itself
    pane,             \* "none", "open", or "closed"
    paneRun,          \* herdr has been told to exec the pane child in the pane
    deadline,         \* SESSION_OPEN_TIMEOUT_MS has passed
    launcher,         \* the launcher's program counter
    interrupted,      \* the launcher's SIGTERM handler has interrupted its fiber
    sawPaneDead,      \* observeChild found the pane child's pid dead in this poll
    child,            \* the pane child's program counter
    childInterrupted, \* the pane child's SIGTERM or SIGHUP handler has interrupted its fiber
    launcherWatch,
    sweep,
    wrapper,          \* "none", "alive", or "gone"
    phase,            \* each Pi's phase, from index.ts Phase plus process life
    trapsSignals,     \* each Pi has registered its SIGTERM and SIGHUP handlers
    kills             \* environment kills already sent, each at most once

vars == <<files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead,
          child, childInterrupted, launcherWatch, sweep, wrapper, phase, trapsSignals, kills>>

LauncherPcs == {"makeRun", "openPane", "paneRun", "readStarted", "checkPanePid",
                "readExit", "checkDeadline", "readClaim", "report",
                "stopReadStarted", "stopCheckGroup", "stopTerm", "stopTermGrace",
                "stopKill", "removeRunDirectory", "closePane", "exit", "gone"}

AwaitChild == {"readStarted", "checkPanePid", "readExit", "checkDeadline", "readClaim"}

\* Effect interrupts the fiber at the next step outside acquireRelease's acquire and release.
LauncherInterruptible == {"makeRun", "openPane", "paneRun", "report"} \cup AwaitChild

ChildPcs == {"unstarted", "writeStarted", "readLaunch", "removeLaunch", "spawnPi",
             "openStderr", "awaitExitCode", "writeExit", "releasePi", "awaitPi",
             "endGroup", "endGroupTerm", "endGroupGrace", "endGroupKill", "exiting", "gone"}

LauncherWatchPcs == {"off", "watching", "abandonRemove", "abandonTerm", "abandonKill"}

ChildPreSpawn == {"writeStarted", "readLaunch", "removeLaunch", "spawnPi"}

\* The scope release that stops pi is uninterruptible.
ChildInterruptible == ChildPreSpawn \cup {"openStderr", "awaitExitCode", "writeExit"}

Phases == {"unborn", "starting", "awaitingDelivery", "inherited", "claimFailed",
           "running", "shutdown", "gone"}

Kills == {"launcherTerm", "launcherKill", "paneClose", "childKill"}

TypeOK ==
    /\ files \subseteq {"dir", "task", "launch", "started", "claim", "exit"}
    /\ pane \in {"none", "open", "closed"}
    /\ paneRun \in BOOLEAN
    /\ deadline \in BOOLEAN
    /\ launcher \in LauncherPcs
    /\ interrupted \in BOOLEAN
    /\ sawPaneDead \in BOOLEAN
    /\ child \in ChildPcs
    /\ childInterrupted \in BOOLEAN
    /\ launcherWatch \in LauncherWatchPcs
    /\ sweep \in {"idle", "removing", "done"}
    /\ wrapper \in {"none", "alive", "gone"}
    /\ phase \in [Pis -> Phases]
    /\ trapsSignals \in [Pis -> BOOLEAN]
    /\ kills \subseteq Kills

DirExists == "dir" \in files

WriteFile(f) == IF DirExists THEN files \cup {f} ELSE files

ChildAlive == child \notin {"unstarted", "gone"}

Alive(p) == phase[p] \notin {"unborn", "gone"}

WrapperAlive == wrapper = "alive"

\* The process the pane child spawned, which its handle signals and awaits.
HandleAlive == IF PiForks THEN WrapperAlive ELSE Alive("pi")

\* pi and the descendant run in the pane child's process group, whose id is in `started`.
GroupAlive == ChildAlive \/ WrapperAlive \/ \E p \in Pis : Alive(p)

RunProcessesGone == ~ChildAlive /\ ~WrapperAlive /\ \A p \in Pis : ~Alive(p)

\* The processes of the group other than the pane child.
OthersInGroup == WrapperAlive \/ \E p \in Pis : Alive(p)

\* Once its handlers are registered, Pi handles SIGTERM and SIGHUP alike with a graceful
\* shutdown. Before that, either signal ends it.
Term(p) ==
    CASE phase[p] \in {"unborn", "gone"} -> phase[p]
      [] trapsSignals[p] -> "shutdown"
      [] OTHER -> "gone"

Kill(ph) == IF ph = "unborn" THEN ph ELSE "gone"

\* The wrapper handles neither SIGTERM nor SIGHUP, so either ends it and leaves Pi running.
EndWrapper == wrapper' = IF WrapperAlive THEN "gone" ELSE wrapper

TermGroup == phase' = [p \in Pis |-> Term(p)] /\ EndWrapper

KillGroup == phase' = [p \in Pis |-> Kill(phase[p])] /\ EndWrapper

\* The pane child is the controlling process of the pane's terminal. When it exits, the kernel
\* sends SIGHUP to the foreground process group, which holds pi, and herdr removes the pane.
ChildDies ==
    /\ child' = "gone"
    /\ TermGroup
    /\ pane' = IF pane = "open" THEN "closed" ELSE pane

\* Leaving runPi closes its scope, which interrupts the launcher watch. The interruption waits for
\* an abandonRun in progress, which ends with the group's SIGKILL.
\* code: agent/extensions/subagents/bin/pane-child.ts runPi "}, Effect.scoped);"
LeaveRunPi ==
    /\ launcherWatch \in {"off", "watching"}
    /\ launcherWatch' = "off"

\* Closing the pane hangs up its terminal, which sends SIGHUP to the session leader.
HangUpPane ==
    /\ pane' = "closed"
    /\ childInterrupted' = (childInterrupted \/ ChildAlive)

Init ==
    /\ files = {}
    /\ pane = "none"
    /\ paneRun = FALSE
    /\ deadline = FALSE
    /\ launcher = "makeRun"
    /\ interrupted = FALSE
    /\ sawPaneDead = FALSE
    /\ child = "unstarted"
    /\ childInterrupted = FALSE
    /\ launcherWatch = "off"
    /\ sweep = "idle"
    /\ wrapper = "none"
    /\ phase = [p \in Pis |-> "unborn"]
    /\ trapsSignals = [p \in Pis |-> FALSE]
    /\ kills = {}

-----------------------------------------------------------------------------
(* The launcher. Nothing outside the launcher knows the run directory until *)
(* the pane exists, so the directory and its first files are one step.      *)

\* code: agent/extensions/subagents/bin/pi-subagent.ts runInPane "yield* fs.writeFileString(files.launch, launch, { mode: 0o600 });"
LMakeRun ==
    /\ launcher = "makeRun"
    /\ files' = {"dir", "task", "launch"}
    /\ launcher' = "openPane"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts runInPane "openPane(placement, workspace, runDirectory, name),"
LOpenPane ==
    /\ launcher = "openPane"
    /\ pane' = "open"
    /\ launcher' = "paneRun"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts runInPane "`exec ${[...invocation.relaunchCommand, PANE_CHILD, runDirectory].map(shellQuote).join(" ")}`,"
LPaneRun ==
    /\ launcher = "paneRun"
    /\ paneRun' = TRUE
    /\ launcher' = "readStarted"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "const panePid = (yield* fs.exists(files.started))"
LReadStarted ==
    /\ launcher = "readStarted"
    /\ sawPaneDead' = FALSE
    /\ launcher' = IF "started" \in files THEN "checkPanePid" ELSE "readExit"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "const deadPanePid = Option.filter(panePid, (pid) => !isAlive(pid));"
LCheckPanePid ==
    /\ launcher = "checkPanePid"
    /\ sawPaneDead' = ~ChildAlive
    /\ launcher' = "readExit"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "if (yield* fs.exists(files.exit)) {"
LReadExit ==
    /\ launcher = "readExit"
    /\ launcher' = IF "exit" \in files \/ sawPaneDead THEN "report" ELSE "checkDeadline"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "if (now < deadline || (yield* fs.exists(files.claim))) return Option.none<ChildEnd>();"
LCheckDeadline ==
    /\ launcher = "checkDeadline"
    /\ launcher' = IF deadline THEN "readClaim" ELSE "readStarted"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "if (now < deadline || (yield* fs.exists(files.claim))) return Option.none<ChildEnd>();"
LReadClaim ==
    /\ launcher = "readClaim"
    /\ launcher' = IF "claim" \in files THEN "readStarted" ELSE "report"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* Forwarding stderr and printing the outcome touch nothing another process reads.
\* code: agent/extensions/subagents/bin/pi-subagent.ts runInPane "const result = yield* readResult(files.outcome, end.exitCode);"
LReport ==
    /\ launcher = "report"
    /\ launcher' = "stopReadStarted"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* The release of the pane runs stopPiGroup, forwardOnce, removeRunDirectory, then closePane.
\* The exit file it also reads sets only a grace period, and the model has no clock.
\* code: agent/extensions/subagents/bin/pi-subagent.ts stopPiGroup "if (!(yield* fs.exists(files.started))) return;"
LStopReadStarted ==
    /\ launcher = "stopReadStarted"
    /\ launcher' = IF "started" \in files THEN "stopCheckGroup" ELSE "removeRunDirectory"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/process-group.ts stopProcessGroup "return yield* stopGroup(group, exitGrace, Effect.sync(() => isAlive(-group)));"
\* code: agent/extensions/subagents/process-group.ts stopGroup "if (!(yield* alive) || (yield* awaitGroupExit(alive, exitGrace))) return "exited" as const;"
LStopCheckGroup ==
    /\ launcher = "stopCheckGroup"
    /\ launcher' = IF GroupAlive THEN "stopTerm" ELSE "removeRunDirectory"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/process-group.ts stopGroup "yield* signalGroup(group, "SIGTERM");"
LStopTerm ==
    /\ launcher = "stopTerm"
    /\ TermGroup
    /\ childInterrupted' = (childInterrupted \/ ChildAlive)
    /\ launcher' = "stopTermGrace"
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, trapsSignals, kills>>

\* code: agent/extensions/subagents/process-group.ts stopGroup "if (yield* awaitGroupExit(alive, TERM_GRACE)) return "SIGTERM" as const;"
LStopTermGrace ==
    /\ launcher = "stopTermGrace"
    /\ launcher' = IF GroupAlive THEN "stopKill" ELSE "removeRunDirectory"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/process-group.ts stopGroup "yield* signalGroup(group, "SIGKILL");"
LStopKill ==
    /\ launcher = "stopKill"
    /\ KillGroup
    /\ child' = IF ChildAlive THEN "gone" ELSE child
    /\ pane' = IF ChildAlive /\ pane = "open" THEN "closed" ELSE pane
    /\ launcher' = "removeRunDirectory"
    /\ UNCHANGED <<sweep, launcherWatch, files, paneRun, deadline, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts runInPane ".remove(runDirectory, { recursive: true, force: true })"
LRemoveRunDirectory ==
    /\ launcher = "removeRunDirectory"
    /\ files' = {}
    /\ launcher' = "closePane"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts closePane "? [["tab", "close", child.tab], `tab ${child.tab}`]"
LClosePane ==
    /\ launcher = "closePane"
    /\ IF pane = "open"
         THEN HangUpPane
         ELSE UNCHANGED <<wrapper, sweep, launcherWatch, pane, childInterrupted, trapsSignals>>
    /\ launcher' = "exit"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, paneRun, deadline, interrupted, sawPaneDead, child, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts addObserver "process.exit(Exit.isSuccess(exit) ? exit.value : 1);"
LExit ==
    /\ launcher = "exit"
    /\ launcher' = "gone"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* Before the pane opens, only the finalizer that removes the run directory is registered.
\* code: agent/extensions/subagents/bin/pi-subagent.ts SIGNAL_EXIT_CODES "Effect.runFork(Fiber.interrupt(fiber));"
LInterrupt ==
    /\ interrupted
    /\ launcher \in LauncherInterruptible
    /\ launcher' = CASE launcher = "makeRun" -> "exit"
                     [] launcher = "openPane" -> "removeRunDirectory"
                     [] OTHER -> "stopReadStarted"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

LauncherStep ==
    \/ LMakeRun \/ LOpenPane \/ LPaneRun
    \/ LReadStarted \/ LCheckPanePid \/ LReadExit \/ LCheckDeadline \/ LReadClaim
    \/ LReport \/ LStopReadStarted \/ LStopCheckGroup \/ LStopTerm \/ LStopTermGrace
    \/ LStopKill \/ LRemoveRunDirectory \/ LClosePane \/ LExit

-----------------------------------------------------------------------------
(* The pane child. It shares pi's process group and leads it.              *)

\* code: agent/extensions/subagents/bin/pi-subagent.ts main "return yield* runPaneChild(second, invocation.env);"
CStart ==
    /\ child = "unstarted"
    /\ paneRun
    /\ pane = "open"
    /\ child' = "writeStarted"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* writeAtomically's rename makes `started` appear in one step. A failure is not caught.
\* code: agent/extensions/subagents/bin/pane-child.ts runPaneChild "yield* writeAtomically(files.started, String(process.pid));"
CWriteStarted ==
    /\ child = "writeStarted"
    /\ files' = WriteFile("started")
    /\ child' = IF DirExists THEN "readLaunch" ELSE "endGroup"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* A failure in runPi is caught, and the pane child records exit code 1.
\* code: agent/extensions/subagents/bin/pane-child.ts runPi "const launch = yield* fs.readFileString(files.launch).pipe(Effect.flatMap(decodeLaunch));"
CReadLaunch ==
    /\ child = "readLaunch"
    /\ child' = IF "launch" \in files THEN "removeLaunch" ELSE "writeExit"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts runPi "yield* watchLauncher(launch.launcherPid, runDirectory);"
CRemoveLaunch ==
    /\ child = "removeLaunch"
    /\ files' = files \ {"launch"}
    /\ child' = IF "launch" \in files THEN "spawnPi" ELSE "writeExit"
    /\ launcherWatch' = IF "launch" \in files THEN "watching" ELSE launcherWatch
    /\ UNCHANGED <<wrapper, sweep, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts runPi "ChildProcess.make("pi", [runFlag(runDirectory), ...launch.args], {"
CSpawnPi ==
    /\ child = "spawnPi"
    /\ phase' = [phase EXCEPT !["pi"] = "starting"]
    /\ wrapper' = IF PiForks THEN "alive" ELSE wrapper
    /\ child' = "openStderr"
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* A failure here closes runPi's scope while pi runs, which releases pi.
\* code: agent/extensions/subagents/bin/pane-child.ts runPi "const stderrFile = yield* fs.open(files.stderr, { flag: "a" });"
COpenStderr ==
    /\ child = "openStderr"
    /\ child' = IF DirExists THEN "awaitExitCode" ELSE "releasePi"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts runPi "const exitCode = yield* handle.exitCode;"
CPiExited ==
    /\ child = "awaitExitCode"
    /\ ~HandleAlive
    /\ LeaveRunPi
    /\ child' = "writeExit"
    /\ UNCHANGED <<wrapper, sweep, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts runPaneChild "yield* writeAtomically(files.exit, String(exitCode));"
CWriteExit ==
    /\ child = "writeExit"
    /\ files' = WriteFile("exit")
    /\ child' = "endGroup"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* The spawner's scope release signals pi alone, because pi does not lead a process group.
\* code: node_modules/@effect/platform-node-shared/src/NodeChildProcessSpawner.ts terminateProcessGroup "yield* signalGroup(options?.killSignal ?? "SIGTERM")"
CReleasePi ==
    /\ child = "releasePi"
    /\ IF PiForks
         THEN EndWrapper /\ UNCHANGED phase
         ELSE phase' = [phase EXCEPT !["pi"] = Term("pi")] /\ UNCHANGED wrapper
    /\ child' = "awaitPi"
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* code: node_modules/@effect/platform-node-shared/src/NodeChildProcessSpawner.ts terminateProcessGroup "yield* Deferred.await(exitSignal)"
CAwaitPi ==
    /\ child = "awaitPi"
    /\ ~HandleAlive
    /\ LeaveRunPi
    /\ child' = IF childInterrupted THEN "endGroup" ELSE "writeExit"
    /\ UNCHANGED <<wrapper, sweep, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts runPi "forceKillAfter: TERM_GRACE,"
\* code: node_modules/@effect/platform-node-shared/src/NodeChildProcessSpawner.ts terminateProcessGroup "yield* signalGroup("SIGKILL")"
CForceKillPi ==
    /\ child = "awaitPi"
    /\ HandleAlive
    /\ IF PiForks
         THEN wrapper' = "gone" /\ UNCHANGED phase
         ELSE phase' = [phase EXCEPT !["pi"] = "gone"] /\ UNCHANGED wrapper
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts watchLauncher "Effect.andThen(abandonRun(runDirectory)),"
CLauncherGone ==
    /\ ChildAlive
    /\ launcherWatch = "watching"
    /\ launcher = "gone"
    /\ launcherWatch' = "abandonRemove"
    /\ UNCHANGED <<wrapper, sweep, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pane-child.ts abandonRun ".remove(runDirectory, { recursive: true, force: true })"
CAbandonRemove ==
    /\ ChildAlive
    /\ launcherWatch = "abandonRemove"
    /\ files' = {}
    /\ launcherWatch' = "abandonTerm"
    /\ UNCHANGED <<wrapper, sweep, child, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* The group's SIGTERM reaches the pane child too. It interrupts the main fiber, and abandonRun
\* ignores it.
\* code: agent/extensions/subagents/bin/pane-child.ts abandonRun "const stopped = yield* stopProcessGroup(process.pid, "0 millis");"
CAbandonTerm ==
    /\ ChildAlive
    /\ launcherWatch = "abandonTerm"
    /\ TermGroup
    /\ childInterrupted' = TRUE
    /\ launcherWatch' = "abandonKill"
    /\ UNCHANGED <<sweep, child, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, trapsSignals, kills>>

\* The group holds the pane child, so it outlives TERM_GRACE and the group gets SIGKILL.
\* code: agent/extensions/subagents/process-group.ts stopGroup "yield* signalGroup(group, "SIGKILL");"
CAbandonKill ==
    /\ ChildAlive
    /\ launcherWatch = "abandonKill"
    /\ KillGroup
    /\ child' = "gone"
    /\ pane' = IF pane = "open" THEN "closed" ELSE pane
    /\ UNCHANGED <<sweep, launcherWatch, files, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* runPaneChild's finalizer stops the rest of the group on every way out, and an interrupt cannot
\* stop a finalizer. One ps listing decides whether another process is in the group.
\* code: agent/extensions/subagents/bin/pane-child.ts runPaneChild "}, Effect.ensuring(endGroup));"
\* code: agent/extensions/subagents/bin/pane-child.ts endGroup "const endGroup = stopRestOfGroup().pipe("
\* code: agent/extensions/subagents/process-group.ts stopGroup "if (!(yield* alive) || (yield* awaitGroupExit(alive, exitGrace))) return "exited" as const;"
CEndGroup ==
    /\ child = "endGroup"
    /\ child' = IF OthersInGroup THEN "endGroupTerm" ELSE "exiting"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* The group's SIGTERM reaches the pane child too, and the finalizer holds off its interrupt.
\* code: agent/extensions/subagents/process-group.ts stopRestOfGroup "return yield* stopGroup(process.pid, "0 millis", othersInGroup(process.pid));"
CEndGroupTerm ==
    /\ child = "endGroupTerm"
    /\ TermGroup
    /\ childInterrupted' = TRUE
    /\ child' = "endGroupGrace"
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, trapsSignals, kills>>

\* code: agent/extensions/subagents/process-group.ts stopGroup "if (yield* awaitGroupExit(alive, TERM_GRACE)) return "SIGTERM" as const;"
CEndGroupGrace ==
    /\ child = "endGroupGrace"
    /\ child' = IF OthersInGroup THEN "endGroupKill" ELSE "exiting"
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

\* The group's SIGKILL ends the pane child with the rest.
\* code: agent/extensions/subagents/process-group.ts stopGroup "yield* signalGroup(group, "SIGKILL");"
CEndGroupKill ==
    /\ child = "endGroupKill"
    /\ KillGroup
    /\ child' = "gone"
    /\ pane' = IF pane = "open" THEN "closed" ELSE pane
    /\ UNCHANGED <<sweep, launcherWatch, files, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts addObserver "process.exit(Exit.isSuccess(exit) ? exit.value : 1);"
CExit ==
    /\ child = "exiting"
    /\ ChildDies
    /\ UNCHANGED <<sweep, launcherWatch, files, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals, kills>>

\* An interrupt before pi spawns ends the pane child. After, the scope release stops pi first.
\* code: agent/extensions/subagents/bin/pi-subagent.ts SIGNAL_EXIT_CODES "Effect.runFork(Fiber.interrupt(fiber));"
CInterrupt ==
    /\ childInterrupted
    /\ child \in ChildInterruptible
    /\ IF child \notin ChildPreSpawn /\ HandleAlive
         THEN child' = "releasePi" /\ UNCHANGED launcherWatch
         ELSE child' = "endGroup" /\ LeaveRunPi
    /\ UNCHANGED <<wrapper, sweep, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, phase, trapsSignals, kills>>

ChildStep ==
    \/ CStart \/ CWriteStarted \/ CReadLaunch \/ CRemoveLaunch \/ CSpawnPi
    \/ COpenStderr \/ CPiExited \/ CLauncherGone \/ CWriteExit \/ CReleasePi
    \/ CForceKillPi \/ CAwaitPi \/ CAbandonRemove \/ CAbandonTerm \/ CAbandonKill
    \/ CEndGroup \/ CEndGroupTerm \/ CEndGroupGrace \/ CEndGroupKill \/ CExit

-----------------------------------------------------------------------------
(* Pi and the descendant. Their own progress is never assumed: either may  *)
(* stop at any step, such as a startup prompt or a long task.              *)

\* The descendant inherits PI_SUBAGENT_RUN only before pi's session_start removes it.
\* code: agent/extensions/subagents/index.ts stopChildrenInheritingRun "delete process.env.PI_SUBAGENT_RUN;"
PSpawnDescendant ==
    /\ DescendantStarts
    /\ phase["pi"] = "starting"
    /\ phase["descendant"] = "unborn"
    /\ phase' = [phase EXCEPT !["descendant"] = "starting"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* The pane child gives pi the run flag, and a wrapper passes it on. A descendant has the arguments
\* that its extension gives it.
\* code: agent/extensions/subagents/bin/pane-child.ts runPi "ChildProcess.make("pi", [runFlag(runDirectory), ...launch.args], {"
CarriesRunFlag(p) == p = "pi"

\* code: agent/extensions/subagents/index.ts claimRun "if (!carriesRunFlag) return false;"
PClaim(p) ==
    /\ phase[p] = "starting"
    /\ files' = IF CarriesRunFlag(p) THEN WriteFile("claim") ELSE files
    /\ phase' = [phase EXCEPT ![p] = CASE ~CarriesRunFlag(p) -> "inherited"
                                       [] ~DirExists -> "claimFailed"
                                       [] OTHER -> "awaitingDelivery"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* A task that cannot be read, or that must run in pi --print, ends the run at once.
\* code: agent/extensions/subagents/index.ts deliverTask "pi.sendUserMessage(task.value, { expandPromptTemplates: true, deliverAs: "followUp" });"
PDeliver(p) ==
    /\ phase[p] = "awaitingDelivery"
    /\ trapsSignals[p]
    /\ \/ "task" \in files /\ phase' = [phase EXCEPT ![p] = "running"]
       \/ phase' = [phase EXCEPT ![p] = "shutdown"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* finish writes outcome.json, which only the launcher's report reads, then shuts pi down.
\* code: agent/extensions/subagents/index.ts finish "yield* Effect.sync(() => ctx.shutdown());"
PSettle(p) ==
    /\ phase[p] = "running"
    /\ phase' = [phase EXCEPT ![p] = "shutdown"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* Pi resolves project trust, where the run can be claimed, before InteractiveMode.init.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js init "this.registerSignalHandlers();"
PTrapSignals(p) ==
    /\ Alive(p)
    /\ ~trapsSignals[p]
    /\ trapsSignals' = [trapsSignals EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, phase, kills>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js shutdown "await this.runtimeHost.dispose();"
PShutdownDone(p) ==
    /\ phase[p] = "shutdown"
    /\ phase' = [phase EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

\* A crash: Pi exits without a report.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js uncaughtCrash "process.exit(1);"
PCrash(p) ==
    /\ Alive(p)
    /\ phase[p] /= "shutdown"
    /\ phase' = [phase EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, trapsSignals, kills>>

PiStep ==
    \/ PSpawnDescendant
    \/ \E p \in Pis : PTrapSignals(p) \/ PClaim(p) \/ PDeliver(p) \/ PSettle(p) \/ PShutdownDone(p) \/ PCrash(p)

-----------------------------------------------------------------------------
(* The environment. Each kill arrives at most once, at any moment.         *)

\* bg_kill, Ctrl-C, or a hangup of the caller's terminal.
\* code: agent/extensions/subagents/bin/pi-subagent.ts SIGNAL_EXIT_CODES "const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;"
SigtermLauncher ==
    /\ "launcherTerm" \in EnabledKills \ kills
    /\ launcher /= "gone"
    /\ interrupted' = TRUE
    /\ kills' = kills \cup {"launcherTerm"}
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, launcher, sawPaneDead, child, childInterrupted, phase, trapsSignals>>

\* An OOM kill, timeout -s KILL, or bg_kill's escalation.
\* code: agent/extensions/subagents/bin/pane-child.ts launcherExit "A launcher killed by SIGKILL cleans up nothing, so the pane child watches it."
SigkillLauncher ==
    /\ "launcherKill" \in EnabledKills
    /\ launcher /= "gone"
    /\ launcher' = "gone"
    /\ kills' = kills \cup {"launcherKill"}
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, deadline, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals>>

\* The user closes the tab, or herdr stops its session.
\* code: agent/extensions/subagents/herdr.ts sweepAbandonedRuns "Herdr also saves a session"
ClosePaneExternally ==
    /\ "paneClose" \in EnabledKills \ kills
    /\ pane = "open"
    /\ HangUpPane
    /\ kills' = kills \cup {"paneClose"}
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, paneRun, deadline, launcher, interrupted, sawPaneDead, child, phase, trapsSignals>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts observeChild "reason: `The pane child (pid ${deadPanePid.value}) died without recording how pi exited.`,"
SigkillChild ==
    /\ "childKill" \in EnabledKills \ kills
    /\ ChildAlive
    /\ ChildDies
    /\ kills' = kills \cup {"childKill"}
    /\ UNCHANGED <<sweep, launcherWatch, files, paneRun, deadline, launcher, interrupted, sawPaneDead, childInterrupted, trapsSignals>>

\* code: agent/extensions/subagents/bin/pi-subagent.ts awaitChild "const deadline = (yield* Clock.currentTimeMillis) + SESSION_OPEN_TIMEOUT_MS;"
Tick ==
    /\ ~deadline
    /\ launcher \in AwaitChild
    /\ deadline' = TRUE
    /\ UNCHANGED <<wrapper, sweep, launcherWatch, files, pane, paneRun, launcher, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

EnvStep == SigtermLauncher \/ SigkillLauncher \/ ClosePaneExternally \/ SigkillChild \/ Tick

-----------------------------------------------------------------------------

\* code: agent/extensions/subagents/herdr.ts runOwnerAlive "return Option.exists(paneChild, isAlive);"
SweepCheck ==
    /\ sweep = "idle"
    /\ DirExists
    /\ launcher = "gone"
    /\ "started" \notin files \/ ~ChildAlive
    /\ sweep' = "removing"
    /\ UNCHANGED <<wrapper, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, launcherWatch, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/herdr.ts removeAbandonedRun "yield* fs.remove(runDirectory, { recursive: true, force: true });"
SweepRemove ==
    /\ sweep = "removing"
    /\ files' = {}
    /\ sweep' = "done"
    /\ UNCHANGED <<wrapper, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, launcherWatch, phase, trapsSignals, kills>>

\* code: agent/extensions/subagents/herdr.ts sweepAbandonedRuns "yield* Effect.forEach(abandoned, (pane) => herdr(["pane", "close", pane.pane_id]));"
SweepClosePane ==
    /\ ~DirExists
    /\ pane = "open"
    /\ HangUpPane
    /\ UNCHANGED <<wrapper, sweep, files, paneRun, deadline, launcher, interrupted, sawPaneDead, child, launcherWatch, phase, trapsSignals, kills>>

SweepStep == SweepCheck \/ SweepRemove \/ SweepClosePane

\* A Volta shim runs Pi with Command.status(), which waits for Pi to exit.
WExit ==
    /\ WrapperAlive
    /\ ~Alive("pi")
    /\ wrapper' = "gone"
    /\ UNCHANGED <<sweep, launcherWatch, files, pane, paneRun, deadline, launcher, interrupted, sawPaneDead, child, childInterrupted, phase, trapsSignals, kills>>

-----------------------------------------------------------------------------

Next == LauncherStep \/ LInterrupt \/ ChildStep \/ CInterrupt \/ PiStep \/ EnvStep \/ SweepStep \/ WExit

Fairness ==
    /\ WF_vars(LauncherStep)
    /\ WF_vars(LInterrupt)
    /\ WF_vars(ChildStep)
    /\ WF_vars(CInterrupt)
    /\ WF_vars(Tick)
    /\ WF_vars(SweepStep)
    /\ WF_vars(WExit)
    /\ IF ShutdownCanHang THEN TRUE ELSE \A p \in Pis : WF_vars(PShutdownDone(p))

Spec == Init /\ [][Next]_vars /\ Fairness

\* Once the launcher has exited, by any path, the pane child, pi, and the descendant all exit.
NoProcessOutlivesLauncher == [](launcher = "gone" => <>[]RunProcessesGone)

KillEndsRun == kills /= {} ~> launcher = "gone"

OnlyPiTakesTheTask == phase["pi"] /= "inherited" /\ phase["descendant"] \notin {"awaitingDelivery", "running"}

NoRunLeftBehind == <>[](launcher = "gone" /\ RunProcessesGone) => <>[](files = {} /\ pane /= "open")

=============================================================================
