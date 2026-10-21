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
EXTENDS Naturals, Sequences, FiniteSets

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
    killWait,     \* session.ts pendingKillResults: a bg_kill call waits on the terminal, and holds its end once settled
    noted,        \* terminals that have sent their notification
    pendingCompletions,  \* completions in delivery.pending
    pendingNotifications, \* notifications in delivery.pending
    waiter,       \* delivery.settleWaiter: "none", "waiting", or "woken"
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

vars == <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
          madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits,
          compacting, aborted>>

piVars == <<phase, steer, deferred, ctx, aborted>>

TypeOK ==
    /\ term \in [Terminals -> {"unstarted", "running", "killing", "settled"}]
    /\ howSettled \in [Terminals -> {"none", "enqueued", "held", "unreported"}]
    /\ killWait \in [Terminals -> {"none", "waiting", "settled"}]
    /\ call.tool # "bg_kill_wait" => killWait = [t \in Terminals |-> "none"]
    /\ noted \subseteq Terminals
    /\ pendingCompletions \subseteq Terminals
    /\ pendingNotifications \subseteq Terminals
    /\ waiter \in {"none", "waiting", "woken"}
    /\ phase = "tools" => waiter = "none"
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

\* Counts every message that carries a terminal's item, so one flush that sends an item in
\* two messages counts it twice.
CountMessages(sent, msgs, field) ==
    [t \in Terminals |-> Min(2, sent[t] + Cardinality({i \in 1..Len(msgs) : t \in msgs[i][field]}))]

MergeAll(msgs) ==
    [completions |-> UNION {msgs[i].completions : i \in 1..Len(msgs)},
     notifications |-> UNION {msgs[i].notifications : i \in 1..Len(msgs)}]

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

\* The messages drain builds from the pending ends pe and notifications pn, in order: the
\* notifications of terminals without a pending end, then the ends with their terminals'
\* notifications.
\* code: agent/extensions/background-terminals/delivery.ts drain "const batch = this.batch(\"notification\") ?? this.batch(\"completion\");"
\* code: agent/extensions/background-terminals/delivery.ts drain "this.consume(batch.details.ids);"
\* code: agent/extensions/background-terminals/delivery.ts batch "if (item.kind === \"notification\" && carriedIds.has(item.id)) continue;"
\* code: agent/extensions/background-terminals/delivery.ts batch "const carried = item.kind === \"completion\" ? this.carriedNotifications(item.snapshot) : [];"
\* code: agent/extensions/background-terminals/delivery.ts carriedNotifications "const notifications = this.pendingNotifications(snapshot.id);"
\* code: agent/extensions/background-terminals/delivery.ts batch "ids.push(item.id, ...carried.map((notification) => notification.id));"
Batches(pe, pn) ==
    SelectSeq(<<[completions |-> {}, notifications |-> pn \ pe],
                [completions |-> pe, notifications |-> pn \cap pe]>>,
              LAMBDA m : m # NoMessage)

\* code: agent/extensions/background-terminals/delivery.ts flush "deliverAs: \"steer\","
RECURSIVE SendAll(_, _)
SendAll(s, msgs) == IF msgs = <<>> THEN s ELSE SendAll(SendToPi(s, Head(msgs)), Tail(msgs))

FlushFrom(s, pe, pn) ==
    LET msgs == Batches(pe, pn)
    IN
    /\ ApplyPi(SendAll(s, msgs))
    /\ pendingCompletions' = {}
    /\ pendingNotifications' = {}
    /\ sentCompletions' = CountMessages(sentCompletions, msgs, "completions")
    /\ sentNotifications' = CountMessages(sentNotifications, msgs, "notifications")

Flush(pe, pn) == FlushFrom(PiState, pe, pn)

Hold(pe, pn) ==
    /\ pendingCompletions' = pe
    /\ pendingNotifications' = pn
    /\ UNCHANGED <<phase, steer, deferred, ctx, aborted, sentCompletions, sentNotifications>>

-----------------------------------------------------------------------------

\* code: agent/extensions/background-terminals/session.ts join "wait.snapshot = snapshot;"
\* code: agent/extensions/background-terminals/session.ts join "client.delivery.enqueue(snapshot);"
\* code: agent/extensions/background-terminals/delivery.ts queue "this.pending.set(item.id, item);"
\* code: agent/extensions/background-terminals/delivery.ts queue "if (this.settleWaiter) {"
\* code: agent/extensions/background-terminals/delivery.ts queue "if (item.kind === \"completion\" || this.context.isIdle())"
\* code: agent/extensions/background-terminals/manager.ts settle "if (this.lifecycle.kind === \"running\") this.onSettled?.(snapshot);"
TEnd(t) ==
    /\ Active(t)
    /\ term' = [term EXCEPT ![t] = "settled"]
    /\ IF phase = "ended" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "unreported"]
         /\ UNCHANGED <<killWait, pendingCompletions, pendingNotifications, waiter, piVars, sentCompletions,
                        sentNotifications>>
       ELSE IF killWait[t] = "waiting" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "held"]
         /\ killWait' = [killWait EXCEPT ![t] = "settled"]
         /\ Hold(pendingCompletions, pendingNotifications)
         /\ UNCHANGED waiter
       ELSE IF waiter # "none" THEN
         /\ howSettled' = [howSettled EXCEPT ![t] = "enqueued"]
         /\ waiter' = "woken"
         /\ Hold(pendingCompletions \cup {t}, pendingNotifications)
         /\ UNCHANGED killWait
       ELSE
         /\ howSettled' = [howSettled EXCEPT ![t] = "enqueued"]
         /\ Flush(pendingCompletions \cup {t}, pendingNotifications)
         /\ UNCHANGED <<killWait, waiter>>
    /\ UNCHANGED <<noted, call, madeCalls, known, idleWaits, compacting>>

\* code: agent/extensions/background-terminals/delivery.ts queue "this.settleWaiter();"
\* code: agent/extensions/background-terminals/delivery.ts enqueueNotification "kind: \"notification\","
\* code: agent/extensions/background-terminals/manager.ts appendNotification "this.onNotification?.({"
TNotify(t) ==
    /\ Notifies
    /\ t \notin noted
    /\ Active(t)
    /\ phase # "ended"
    /\ noted' = noted \cup {t}
    /\ IF waiter # "none" THEN
         /\ waiter' = "woken"
         /\ Hold(pendingCompletions, pendingNotifications \cup {t})
       ELSE IF IsIdle THEN
         /\ Flush(pendingCompletions, pendingNotifications \cup {t})
         /\ UNCHANGED waiter
       ELSE
         /\ Hold(pendingCompletions, pendingNotifications \cup {t})
         /\ UNCHANGED waiter
    /\ UNCHANGED <<term, howSettled, killWait, call, madeCalls, known, idleWaits, compacting>>

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
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, steer, deferred,
                   sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* An aborted response ends the loop, and _handlePostAgentRun skips agent_before_settle.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _startRun "if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))"
PRequestAborted ==
    /\ phase = "request"
    /\ aborted
    /\ phase' = "settling"
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
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
    /\ UNCHANGED <<howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, madeCalls, steer, deferred,
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
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingNotifications, waiter, madeCalls, steer, deferred,
                   known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* The call registers its kill wait before termination starts, so a settle during the
\* wait is held for the tool result.
\* code: agent/extensions/background-terminals/session.ts join "else pendingKillResults.set(id, { calls: 1, snapshot: undefined });"
\* code: agent/extensions/background-terminals/manager.ts terminate "yield* this.signalTree(id, false);"
ToolKillSignal ==
    /\ phase = "tools"
    /\ call.tool = "bg_kill"
    /\ term' = IF term[call.t] = "running" THEN [term EXCEPT ![call.t] = "killing"] ELSE term
    /\ killWait' = [killWait EXCEPT ![call.t] = "waiting"]
    /\ call' = [call EXCEPT !.tool = "bg_kill_wait"]
    /\ UNCHANGED <<howSettled, noted, pendingCompletions, pendingNotifications, waiter, phase, madeCalls, steer,
                   deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* The result carries the end of a terminal that settled during the wait, and the
\* terminal's unread notification, so it counts as a message for NoDoubleWake.
\* code: agent/extensions/background-terminals/index.ts bg_kill "notifications: delivery.takeNotifications(result.id),"
\* code: agent/extensions/background-terminals/session.ts join "for (const id of ids) pendingKillResults.delete(id);"
\* code: agent/extensions/background-terminals/index.ts bg_kill "if (Exit.isSuccess(exit)) terminalSession.consume(ids);"
ToolKillDone ==
    LET taken == pendingNotifications \cap {call.t}
    IN
    /\ phase = "tools"
    /\ call.tool = "bg_kill_wait"
    /\ term[call.t] = "settled"
    /\ pendingCompletions' = pendingCompletions \ {call.t}
    /\ pendingNotifications' = pendingNotifications \ taken
    /\ ctx' = [completions |-> ctx.completions \cup {call.t}, notifications |-> ctx.notifications \cup taken]
    /\ sentCompletions' = IF killWait[call.t] = "settled" THEN Count(sentCompletions, {call.t}) ELSE sentCompletions
    /\ sentNotifications' = Count(sentNotifications, taken)
    /\ killWait' = [killWait EXCEPT ![call.t] = "none"]
    /\ EndCall
    /\ UNCHANGED <<term, howSettled, noted, waiter, madeCalls, steer, deferred,
                   known, idleWaits, compacting, aborted>>

\* The call ends without a result, so it hands an end that settled during the wait to
\* delivery.
\* code: agent/extensions/background-terminals/index.ts bg_kill "else abandoned = terminalSession.abandonKill(ids);"
\* code: agent/extensions/background-terminals/session.ts join "if (wait.snapshot) client.delivery.enqueue(wait.snapshot);"
\* code: agent/extensions/background-terminals/index.ts abortedKillReasons "delivered: \"termination is not cancelled, and its end will be delivered to you\","
ToolKillAborted ==
    /\ phase = "tools"
    /\ call.tool = "bg_kill_wait"
    /\ aborted
    /\ call' = NoCall
    /\ killWait' = [killWait EXCEPT ![call.t] = "none"]
    /\ IF killWait[call.t] = "settled"
         THEN FlushFrom([PiState EXCEPT !.phase = "turnEnd"], pendingCompletions \cup {call.t}, pendingNotifications)
         ELSE /\ phase' = "turnEnd"
              /\ UNCHANGED <<pendingCompletions, pendingNotifications, steer, deferred, ctx, aborted,
                             sentCompletions, sentNotifications>>
    /\ UNCHANGED <<term, howSettled, noted, waiter, madeCalls, known, idleWaits, compacting>>

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
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
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
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
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
\* code: agent/extensions/background-terminals/delivery.ts waitForDelivery "if (this.pending.size > 0) return Effect.void;"
\* code: agent/extensions/background-terminals/delivery.ts waitForDelivery "this.settleWaiter = done;"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "yield* delivery.waitForDelivery(options.settleWaitMs ?? SETTLE_WAIT_MS, ctx.signal);"
BSStart ==
    /\ phase = "beforeSettle"
    /\ IF WaitsAtSettle /\ \E t \in Terminals : Active(t)
         THEN /\ waiter' = IF pendingCompletions \cup pendingNotifications = {} THEN "waiting" ELSE "woken"
              /\ phase' = "settleWait"
              /\ UNCHANGED <<ctx, steer>>
         ELSE /\ UNCHANGED waiter
              /\ Decide(FALSE, ctx)
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, call, madeCalls, deferred,
                   known, sentCompletions, sentNotifications, idleWaits, compacting, aborted>>

\* The wait ends when an item was pending or queued, or SETTLE_WAIT_MS passed.
\* code: agent/extensions/background-terminals/delivery.ts takePending "this.drain((batch) => {"
\* code: agent/extensions/background-terminals/delivery.ts drain "this.consume(batch.details.ids);"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "const entries = delivery.takePending();"
\* code: agent/extensions/background-terminals/index.ts agent_before_settle "if (idleSettleWaits > MAX_IDLE_SETTLE_WAITS) return undefined;"
BSWake ==
    LET msgs == Batches(pendingCompletions, pendingNotifications)
        hasItems == msgs # <<>>
    IN
    /\ phase = "settleWait"
    /\ waiter' = "none"
    /\ pendingCompletions' = {}
    /\ pendingNotifications' = {}
    /\ sentCompletions' = CountMessages(sentCompletions, msgs, "completions")
    /\ sentNotifications' = CountMessages(sentNotifications, msgs, "notifications")
    /\ idleWaits' = IF hasItems THEN 0 ELSE Min(idleWaits + 1, MaxIdleSettleWaits + 1)
    /\ Decide(hasItems \/ idleWaits + 1 <= MaxIdleSettleWaits, Merge(ctx, MergeAll(msgs)))
    /\ UNCHANGED <<term, howSettled, killWait, noted, call, madeCalls, deferred, known, compacting, aborted>>

\* Pi clears _isAgentRunActive and emits agent_settled. Other extensions' handlers await I/O,
\* so other callbacks can run before and after this extension's handler.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _emitAgentSettled "await this._extensionRunner.emit({ type: \"agent_settled\", aborted });"
\* code: agent/extensions/background-terminals/index.ts agent_settled "pi.on(\"agent_settled\", () => Effect.runPromise(delivery.flush));"
PSettledHandler ==
    /\ phase = "settling"
    /\ FlushFrom([PiState EXCEPT !.phase = "settlingFlushed"], pendingCompletions, pendingNotifications)
    /\ UNCHANGED <<term, howSettled, killWait, noted, waiter, call, madeCalls, known, idleWaits, compacting>>

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
    /\ UNCHANGED <<term, howSettled, killWait, noted, waiter, call, madeCalls, known, sentCompletions, sentNotifications,
                   idleWaits, compacting>>

-----------------------------------------------------------------------------

UserPrompt ==
    /\ ~WaitsAtSettle
    /\ phase = "idle"
    /\ ApplyPi(StartRun(PiState, NoMessage))
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, call, madeCalls,
                   known, sentCompletions, sentNotifications, idleWaits, compacting>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js isCompacting "this._compactionAbortController !== undefined ||"
UserCompact ==
    /\ UserCanCompact
    /\ phase = "idle"
    /\ ~compacting
    /\ compacting' = TRUE
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, aborted>>

\* Compaction emits session_compact and compaction_end, and no agent_settled.
\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js _clearManualCompactionState "this._compactionAbortController = undefined;"
CompactDone ==
    /\ compacting
    /\ compacting' = FALSE
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, aborted>>

\* code: node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js abort "this._agentRunAbortRequested = true;"
Abort ==
    /\ UserCanAbort
    /\ phase \in RunPhases
    /\ ~aborted
    /\ aborted' = TRUE
    /\ UNCHANGED <<term, howSettled, killWait, noted, pendingCompletions, pendingNotifications, waiter, phase, call,
                   madeCalls, steer, deferred, ctx, known, sentCompletions, sentNotifications, idleWaits, compacting>>

-----------------------------------------------------------------------------

Init ==
    /\ term = [t \in Terminals |-> "unstarted"]
    /\ howSettled = [t \in Terminals |-> "none"]
    /\ killWait = [t \in Terminals |-> "none"]
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
    \A t \in Terminals : howSettled[t] = "held" ~> t \in known.completions

ReachesPi(t) ==
    \/ t \in known.completions
    \/ t \in ctx.completions
    \/ \E i \in 1..Len(steer) : t \in steer[i].completions
    \/ \E m \in deferred : t \in m.completions

\* After an abort, Pi keeps queued messages and the transcript for the user's next prompt,
\* so a terminal's end, including one bg_kill ended, only has to reach Pi.
EndReachesPi ==
    \A t \in Terminals : howSettled[t] \in {"enqueued", "held"} ~> ReachesPi(t)

\* A notification reaches the model, on its own or with the report of its terminal's end.
\* An unattended run always ends, so the session's end excuses nothing.
NotificationReachesAgent ==
    \A t \in Terminals : t \in noted ~> t \in known.notifications

\* No end and no notification reaches the model in two messages.
NoDoubleWake ==
    \A t \in Terminals : sentCompletions[t] <= 1 /\ sentNotifications[t] <= 1

\* An unattended run shuts down with a terminal still running only after the model has read
\* MaxIdleSettleWaits still-running notices without calling a tool in between.
UnattendedRunOutwaitsTerminals ==
    (phase = "ended" /\ \E t \in Terminals : Active(t)) => idleWaits > MaxIdleSettleWaits

=============================================================================
