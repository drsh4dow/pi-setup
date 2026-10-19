--------------------------- MODULE TerminalDelivery ---------------------------
(***************************************************************************)
(* How the end of a background terminal, and its emit-to-pi notification,  *)
(* reach the model of the Pi session that started it with bg_start.        *)
(* Three parties share the state: the terminal manager (manager.ts,        *)
(* session.ts), the delivery queue (delivery.ts, index.ts), and Pi's run   *)
(* loop (agent-session.js, agent-loop.js). The model, meaning the LLM,     *)
(* calls one tool per response.                                            *)
(*                                                                         *)
(* Pi runs on one event loop, so each action is one callback that runs to *)
(* completion, or the part of an async function between two awaits that   *)
(* another callback can observe. The comment above each action cites the   *)
(* code as                                                                 *)
(*   \* code: <file> <function> "<snippet>"                                *)
(* scripts/check fails when a cited snippet is no longer in its file.      *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANT Terminals

\* TRUE: a print or JSON run, or a subagent's TUI session, which waits at settle for
\* running terminals and ends when the run settles (index.ts sessionOutlivesRun is FALSE).
CONSTANT WaitsAtSettle

\* TRUE: each terminal may send one emit-to-pi notification while it runs.
CONSTANT Notifies

\* TRUE: the user may run /compact, or /tree with a summary, while the session is idle.
CONSTANT UserCanCompact

\* TRUE: the user may abort a run, as Escape does.
CONSTANT UserCanAbort

\* code: agent/extensions/background-terminals/index.ts MAX_IDLE_SETTLE_WAITS "const MAX_IDLE_SETTLE_WAITS = 3;"
MaxIdleSettleWaits == 3

Message == [completions : SUBSET Terminals, notifications : SUBSET Terminals]

NoMessage == [completions |-> {}, notifications |-> {}]

Merge(a, b) == [completions |-> a.completions \cup b.completions, notifications |-> a.notifications \cup b.notifications]

NoCall == [tool |-> "none", t |-> "none"]

Tools == {"bg_start", "bg_status", "bg_kill", "bg_kill_wait"}

\* Pi's _isAgentRunActive is TRUE in these phases, so pi.sendMessage steers.
RunPhases == {"request", "tools", "turnEnd", "agentEnd", "beforeSettle", "settleWait"}

Phases == RunPhases \cup {"settling", "settlingFlushed", "idle", "ended"}

VARIABLES
    term,         \* each terminal's manager entry: running covers executing, draining, reaping
    howSettled,   \* what onSettled did when the terminal settled
    noted,        \* terminals that have sent their notification
    pendingCompletions,  \* completions in delivery.pending
    pendingNotifications, \* notifications in delivery.pending
    waiter,       \* delivery.completionWaiter: "none", "waiting", or "woken"
    phase,        \* where Pi's run loop is
    call,         \* the tool call of the current assistant message, or NoCall
    madeCalls,    \* the current assistant message has a tool call
    steer,        \* Pi's agent steering queue, a sequence of Message
    deferred,     \* messages sent while agent_settled handlers run, which Pi defers
    ctx,          \* what the next model request adds to the model's context
    known,        \* what the model has read in a request
    sentCompletions,     \* how many messages have carried each terminal's end, capped at 2
    sentNotifications,    \* how many messages have carried each terminal's notification, capped at 2
    idleWaits,    \* index.ts idleSettleWaits, capped at MaxIdleSettleWaits + 1
    compacting,   \* Pi's isCompacting
    aborted       \* Pi's _agentRunAbortRequested for the current run

vars == <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
          madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits,
          compacting, aborted>>

piVars == <<phase, steer, deferred, ctx, aborted>>

TypeOK ==
    /\ term \in [Terminals -> {"unstarted", "running", "killing", "settled"}]
    /\ howSettled \in [Terminals -> {"none", "enqueued", "consumed", "unreported"}]
    /\ noted \subseteq Terminals
    /\ pendingCompletions \subseteq Terminals
    /\ pendingNotifications \subseteq Terminals
    /\ waiter \in {"none", "waiting", "woken"}
    /\ phase \in Phases
    /\ call \in [tool : Tools, t : Terminals] \cup {NoCall}
    /\ madeCalls \in BOOLEAN
    /\ \A i \in 1..Len(steer) : steer[i] \in Message
    /\ deferred \subseteq Message
    /\ ctx \in Message
    /\ known \in Message
    /\ sentCompletions \in [Terminals -> 0..2]
    /\ sentNotifications \in [Terminals -> 0..2]
    /\ idleWaits \in 0..(MaxIdleSettleWaits + 1)
    /\ compacting \in BOOLEAN
    /\ aborted \in BOOLEAN

Active(t) == term[t] \in {"running", "killing"}

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js isIdle "return !this._isAgentRunActive && !this.isCompacting;"
IsIdle == phase \in {"settling", "settlingFlushed", "idle"} /\ ~compacting

Min(a, b) == IF a < b THEN a ELSE b

Count(sent, items) ==
    [t \in Terminals |-> IF t \in items /\ sent[t] < 2 THEN sent[t] + 1 ELSE sent[t]]

PiState == [phase |-> phase, steer |-> steer, deferred |-> deferred, ctx |-> ctx, aborted |-> aborted]

ApplyPi(s) ==
    /\ phase' = s.phase
    /\ steer' = s.steer
    /\ deferred' = s.deferred
    /\ ctx' = s.ctx
    /\ aborted' = s.aborted

\* The loop's first poll takes one queued steering message.
\* code: node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js runLoop "let pendingMessages = (await config.getSteeringMessages?.()) || [];"
StartRun(s, msg) ==
    [s EXCEPT !.phase = "request",
              !.ctx = Merge(Merge(@, msg), IF s.steer = <<>> THEN NoMessage ELSE Head(s.steer)),
              !.steer = IF @ = <<>> THEN @ ELSE Tail(@),
              !.aborted = FALSE]

\* pi.sendMessage(msg, { deliverAs: "steer", triggerTurn: true }).
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js sendCustomMessage "else if (this.isStreaming && options?.triggerTurn !== false) {"
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js sendCustomMessage "this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));"
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js sendCustomMessage "await this._startRun({ messageType: \"custom\", message: appMessage });"
SendToPi(s, msg) ==
    CASE s.phase \in RunPhases -> [s EXCEPT !.steer = Append(@, msg)]
      [] s.phase \in {"settling", "settlingFlushed"} -> [s EXCEPT !.deferred = @ \cup {msg}]
      [] s.phase = "idle" -> StartRun(s, msg)

\* code: agent/extensions/background-terminals/delivery.ts flush "const batch = this.batch(\"notification\") ?? this.batch(\"completion\");"
\* code: agent/extensions/background-terminals/delivery.ts flush "this.consume(batch.details.ids);"
Sent(s, pe, pn) ==
    LET s1 == IF pn = {} THEN s ELSE SendToPi(s, [completions |-> {}, notifications |-> pn])
    IN IF pe = {} THEN s1 ELSE SendToPi(s1, [completions |-> pe, notifications |-> {}])

FlushFrom(s, pe, pn) ==
    /\ ApplyPi(Sent(s, pe, pn))
    /\ pendingCompletions' = {}
    /\ pendingNotifications' = {}
    /\ sentCompletions' = Count(sentCompletions, pe)
    /\ sentNotifications' = Count(sentNotifications, pn)

Flush(pe, pn) == FlushFrom(PiState, pe, pn)

Hold(pe, pn) ==
    /\ pendingCompletions' = pe
    /\ pendingNotifications' = pn
    /\ UNCHANGED <<phase, steer, deferred, ctx, aborted, sentCompletions, sentNotifications>>

-----------------------------------------------------------------------------

\* code: agent/extensions/background-terminals/session.ts join "client.delivery.terminalSettled(snapshot.id);"
\* code: agent/extensions/background-terminals/session.ts join "client.delivery.consume([snapshot.id]);"
\* code: agent/extensions/background-terminals/session.ts join "client.delivery.enqueue(snapshot);"
\* code: agent/extensions/background-terminals/delivery.ts queue "this.pending.set(item.id, item);"
\* code: agent/extensions/background-terminals/delivery.ts queue "if (item.kind === \"completion\" && this.completionWaiter) {"
\* code: agent/extensions/background-terminals/delivery.ts queue "if (item.kind === \"completion\" || this.context.isIdle())"
\* code: agent/extensions/background-terminals/manager.ts settle "if (this.lifecycle.kind === \"running\")"
\* code: agent/extensions/background-terminals/manager.ts settle "this.onSettled?.(snapshot, entry.kind === \"terminating\" && entry.intent === \"kill\");"
TEnd(t) ==
    /\ Active(t)
    /\ term' = [term EXCEPT ![t] = "settled"]
    /\ IF phase = "ended" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "unreported"]
         /\ UNCHANGED <<pendingCompletions, pendingNotifications, waiter, piVars, sentCompletions, sentNotifications>>
       ELSE IF term[t] = "killing" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "consumed"]
         /\ Hold(pendingCompletions \ {t}, pendingNotifications \ {t})
         /\ UNCHANGED waiter
       ELSE IF waiter # "none" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "enqueued"]
         /\ waiter' = "woken"
         /\ Hold(pendingCompletions \cup {t}, pendingNotifications \ {t})
       ELSE
         /\ howSettled' = [howSettled EXCEPT ![t] = "enqueued"]
         /\ Flush(pendingCompletions \cup {t}, pendingNotifications \ {t})
         /\ UNCHANGED waiter
    /\ UNCHANGED <<noted, call, madeCalls, known, idleWaits, compacting>>

\* code: agent/extensions/background-terminals/delivery.ts enqueueNotification "kind: \"notification\","
\* code: agent/extensions/background-terminals/manager.ts appendNotification "this.onNotification?.({"
TNotify(t) ==
    /\ Notifies
    /\ t \notin noted
    /\ Active(t)
    /\ phase # "ended"
    /\ noted' = noted \cup {t}
    /\ IF IsIdle
         THEN Flush(pendingCompletions, pendingNotifications \cup {t})
         ELSE Hold(pendingCompletions, pendingNotifications \cup {t})
    /\ UNCHANGED <<term, howSettled, waiter, call, madeCalls, known, idleWaits, compacting>>

-----------------------------------------------------------------------------

Callable ==
    {[tool |-> "bg_start", t |-> u] : u \in {v \in Terminals : term[v] = "unstarted"}}
    \cup {[tool |-> tl, t |-> u] : tl \in {"bg_status", "bg_kill"},
                                   u \in {v \in Terminals : term[v] # "unstarted"}}

\* code: node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js runLoop "const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);"
PRequest ==
    /\ phase = "request"
    /\ ~aborted
    /\ known' = Merge(known, ctx)
    /\ ctx' = NoMessage
    /\ \/ \E c \in Callable : call' = c /\ phase' = "tools" /\ madeCalls' = TRUE
       \/ call' = NoCall /\ phase' = "turnEnd" /\ madeCalls' = FALSE
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, steer, deferred,
                   sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* An aborted response ends the loop, and _handlePostAgentRun skips agent_before_settle.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _startRun "if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))"
PRequestAborted ==
    /\ phase = "request"
    /\ aborted
    /\ phase' = "settling"
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
                   steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

EndCall ==
    /\ call' = NoCall
    /\ phase' = "turnEnd"

\* code: agent/extensions/background-terminals/index.ts bg_start "return currentSession().start({"
ToolStart ==
    /\ phase = "tools"
    /\ call.tool = "bg_start"
    /\ term' = [term EXCEPT ![call.t] = "running"]
    /\ EndCall
    /\ UNCHANGED <<howSettled, noted, pendingCompletions, pendingNotifications, waiter, madeCalls, steer, deferred,
                   ctx, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* code: agent/extensions/background-terminals/index.ts bg_status "if (snapshot.state !== \"running\") terminalSession.consume([snapshot.id]);"
ToolStatus ==
    /\ phase = "tools"
    /\ call.tool = "bg_status"
    /\ IF term[call.t] = "settled"
         THEN /\ pendingCompletions' = pendingCompletions \ {call.t}
              /\ ctx' = [ctx EXCEPT !.completions = @ \cup {call.t}]
         ELSE UNCHANGED <<pendingCompletions, ctx>>
    /\ EndCall
    /\ UNCHANGED <<term, howSettled, noted, pendingNotifications, waiter, madeCalls, steer, deferred,
                   known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* code: agent/extensions/background-terminals/manager.ts terminate "yield* this.signalTree(id, false);"
ToolKillSignal ==
    /\ phase = "tools"
    /\ call.tool = "bg_kill"
    /\ term' = IF term[call.t] = "running" THEN [term EXCEPT ![call.t] = "killing"] ELSE term
    /\ call' = [call EXCEPT !.tool = "bg_kill_wait"]
    /\ UNCHANGED <<howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, madeCalls, steer,
                   deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* code: agent/extensions/background-terminals/index.ts bg_kill "terminalSession.consume(ids);"
ToolKillDone ==
    /\ phase = "tools"
    /\ call.tool = "bg_kill_wait"
    /\ term[call.t] = "settled"
    /\ pendingCompletions' = pendingCompletions \ {call.t}
    /\ ctx' = [ctx EXCEPT !.completions = @ \cup {call.t}]
    /\ EndCall
    /\ UNCHANGED <<term, howSettled, noted, pendingNotifications, waiter, madeCalls, steer, deferred,
                   known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* code: agent/extensions/background-terminals/index.ts bg_kill "throw new Error(\"Kill wait aborted; termination continues in the background.\");"
ToolKillAborted ==
    /\ phase = "tools"
    /\ call.tool = "bg_kill_wait"
    /\ aborted
    /\ EndCall
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, madeCalls, steer,
                   deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* After turn_end the loop polls one steering message.
\* code: agent/extensions/background-terminals/index.ts turn_end "idleSettleWaits = 0;"
\* code: node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js runLoop "pendingMessages = (await config.getSteeringMessages?.()) || [];"
PTurnEnd ==
    /\ phase = "turnEnd"
    /\ idleWaits' = IF madeCalls THEN 0 ELSE idleWaits
    /\ IF steer # <<>>
         THEN /\ ctx' = Merge(ctx, Head(steer))
              /\ steer' = Tail(steer)
              /\ phase' = IF aborted THEN "settling" ELSE "request"
         ELSE /\ UNCHANGED <<ctx, steer>>
              /\ phase' = IF aborted THEN "settling"
                           ELSE IF madeCalls THEN "request"
                           ELSE "agentEnd"
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
                   deferred, known, sentCompletions, sentNotifications, compacting, aborted>>

\* _handlePostAgentRun continues the run when a steering message arrived after the poll.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _handlePostAgentRun "return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();"
PAgentEnd ==
    /\ phase = "agentEnd"
    /\ IF aborted THEN
         /\ phase' = "settling"
         /\ UNCHANGED <<ctx, steer>>
       ELSE IF steer # <<>> THEN
         /\ phase' = "request"
         /\ ctx' = Merge(ctx, Head(steer))
         /\ steer' = Tail(steer)
       ELSE
         /\ phase' = "beforeSettle"
         /\ UNCHANGED <<ctx, steer>>
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
                   deferred, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _runBeforeSettleBoundary "const shouldContinue = result.continue || this.agent.hasQueuedMessages();"
Decide(cont, c) ==
    IF ~aborted /\ (cont \/ steer # <<>>)
      THEN /\ phase' = "request"
           /\ ctx' = Merge(c, IF steer = <<>> THEN NoMessage ELSE Head(steer))
           /\ steer' = IF steer = <<>> THEN steer ELSE Tail(steer)
      ELSE /\ phase' = "settling"
           /\ ctx' = c
           /\ UNCHANGED steer

\* The settle wait takes no abort, because ctx.signal is Pi's agent.signal, which is
\* undefined once the loop has ended.
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "if (runningTerminals(terminals).length === 0) return undefined;"
\* code: agent/extensions/background-terminals/delivery.ts waitForCompletion "this.completionWaiter = done;"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "yield* delivery.waitForCompletion(options.settleWaitMs ?? SETTLE_WAIT_MS, ctx.signal);"
BSStart ==
    /\ phase = "beforeSettle"
    /\ IF WaitsAtSettle /\ \E t \in Terminals : Active(t)
         THEN /\ waiter' = "waiting"
              /\ phase' = "settleWait"
              /\ UNCHANGED <<ctx, steer>>
         ELSE /\ UNCHANGED waiter
              /\ Decide(FALSE, ctx)
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, call, madeCalls, deferred,
                   known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* The wait ends when a completion woke it or SETTLE_WAIT_MS passed.
\* code: agent/extensions/background-terminals/delivery.ts takeCompletions "this.consume(batch.details.ids);"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "const results = delivery.takeCompletions();"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "if (idleSettleWaits > MAX_IDLE_SETTLE_WAITS) return undefined;"
BSWake ==
    /\ phase = "settleWait"
    /\ waiter' = "none"
    /\ pendingCompletions' = {}
    /\ sentCompletions' = Count(sentCompletions, pendingCompletions)
    /\ idleWaits' = IF pendingCompletions # {} THEN 0 ELSE Min(idleWaits + 1, MaxIdleSettleWaits + 1)
    /\ Decide(pendingCompletions # {} \/ idleWaits + 1 <= MaxIdleSettleWaits,
              [ctx EXCEPT !.completions = @ \cup pendingCompletions])
    /\ UNCHANGED <<term, howSettled, noted, pendingNotifications, call, madeCalls, deferred, known,
                   sentNotifications, compacting, aborted>>

\* Pi clears _isAgentRunActive and emits agent_settled. Other extensions' handlers await I/O,
\* so other callbacks can run before and after this extension's handler.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _emitAgentSettled "await this._extensionRunner.emit({ type: \"agent_settled\", aborted });"
\* code: agent/extensions/background-terminals/index.ts agent_settled "pi.on(\"agent_settled\", () => Effect.runPromise(delivery.flush));"
PSettledHandler ==
    /\ phase = "settling"
    /\ FlushFrom([PiState EXCEPT !.phase = "settlingFlushed"], pendingCompletions, pendingNotifications)
    /\ UNCHANGED <<term, howSettled, noted, waiter, call, madeCalls, known, idleWaits, compacting>>

\* code: agent/extensions/background-terminals/session.ts leave "for (const [joined] of clients) joined.delivery.clear();"
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _emitAgentSettled "const deferred = this._deferredSettledActions.splice(0);"
PSettleDone ==
    /\ phase = "settlingFlushed"
    /\ IF deferred # {}
         THEN /\ \E m \in deferred : ApplyPi(StartRun([PiState EXCEPT !.deferred = @ \ {m}], m))
              /\ UNCHANGED <<pendingCompletions, pendingNotifications>>
         ELSE /\ phase' = IF WaitsAtSettle THEN "ended" ELSE "idle"
              /\ pendingCompletions' = IF WaitsAtSettle THEN {} ELSE pendingCompletions
              /\ pendingNotifications' = IF WaitsAtSettle THEN {} ELSE pendingNotifications
              /\ UNCHANGED <<steer, deferred, ctx, aborted>>
    /\ UNCHANGED <<term, howSettled, noted, waiter, call, madeCalls, known, sentCompletions, sentNotifications,
                   idleWaits, compacting>>

-----------------------------------------------------------------------------

UserPrompt ==
    /\ ~WaitsAtSettle
    /\ phase = "idle"
    /\ ApplyPi(StartRun(PiState, NoMessage))
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
                   known, sentCompletions, sentNotifications, idleWaits, compacting>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js isCompacting "this._compactionAbortController !== undefined ||"
UserCompact ==
    /\ UserCanCompact
    /\ phase = "idle"
    /\ ~compacting
    /\ compacting' = TRUE
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, aborted>>

\* Compaction emits session_compact and compaction_end, and no agent_settled.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _clearManualCompactionState "this._compactionAbortController = undefined;"
CompactDone ==
    /\ compacting
    /\ compacting' = FALSE
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, aborted>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js abort "this._agentRunAbortRequested = true;"
Abort ==
    /\ UserCanAbort
    /\ phase \in RunPhases
    /\ ~aborted
    /\ aborted' = TRUE
    /\ UNCHANGED <<term, howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting>>

-----------------------------------------------------------------------------

Init ==
    /\ term = [t \in Terminals |-> "unstarted"]
    /\ howSettled = [t \in Terminals |-> "none"]
    /\ noted = {}
    /\ pendingCompletions = {}
    /\ pendingNotifications = {}
    /\ waiter = "none"
    /\ phase = "request"
    /\ call = NoCall
    /\ madeCalls = FALSE
    /\ steer = <<>>
    /\ deferred = {}
    /\ ctx = NoMessage
    /\ known = NoMessage
    /\ sentCompletions = [t \in Terminals |-> 0]
    /\ sentNotifications = [t \in Terminals |-> 0]
    /\ idleWaits = 0
    /\ compacting = FALSE
    /\ aborted = FALSE

PiStep ==
    \/ PRequest \/ PRequestAborted
    \/ ToolStart \/ ToolStatus \/ ToolKillSignal \/ ToolKillDone \/ ToolKillAborted
    \/ PTurnEnd \/ PAgentEnd \/ BSStart \/ BSWake \/ PSettledHandler \/ PSettleDone

Next ==
    \/ PiStep
    \/ \E t \in Terminals : TEnd(t) \/ TNotify(t)
    \/ UserPrompt \/ UserCompact \/ CompactDone \/ Abort

\* Pi and the model always take their next step, the model ends its turn without a tool call
\* now and then, and SETTLE_WAIT_MS always passes. A kill and a shutdown always end the
\* terminal, because terminate escalates to SIGKILL and then settles it even when stdio
\* stays open. A terminal may run forever on its own, and the user may never
\* act again.
Fairness ==
    /\ WF_vars(PiStep)
    /\ SF_vars(PRequest /\ call' = NoCall)
    /\ WF_vars(CompactDone)
    /\ \A t \in Terminals : WF_vars(TEnd(t) /\ (term[t] = "killing" \/ phase = "ended"))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------

\* A terminal that settles on its own wakes the model with its final state.
CompletionWakesAgent ==
    \A t \in Terminals : howSettled[t] = "enqueued" ~> t \in known.completions

\* A terminal that bg_kill ended reaches the model with its final state.
KillReachesAgent ==
    \A t \in Terminals : howSettled[t] = "consumed" ~> t \in known.completions

\* A notification reaches the model, unless its terminal settles first, whose completion
\* carries the same output, or the session ends.
NotificationReachesAgent ==
    \A t \in Terminals :
        t \in noted ~> (t \in known.notifications \/ term[t] = "settled" \/ phase = "ended")

\* No end and no notification reaches the model in two messages.
NoDoubleWake ==
    \A t \in Terminals : sentCompletions[t] <= 1 /\ sentNotifications[t] <= 1

\* An unattended run shuts down with a terminal still running only after the model has read
\* MaxIdleSettleWaits still-running notices without calling a tool in between.
UnattendedRunOutwaitsTerminals ==
    (phase = "ended" /\ \E t \in Terminals : Active(t)) => idleWaits > MaxIdleSettleWaits

=============================================================================
