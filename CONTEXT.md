# Pi Dotfiles

Opinionated configuration and extensions that define how Pi behaves and exposes local tools.

## Language

### Session continuity

**Compaction Boundary**:
The earlier of 85% of the active model's context window and 250,000 tokens. Crossing it triggers one Handoff Turn followed by compaction at the end of the current model/tool turn; another cannot start until observed usage first falls below the boundary.
_Avoid_: Overflow threshold, fixed context limit

**Handoff Turn**:
The single extra turn injected when the Compaction Boundary is crossed, in which the acting model writes its own Model Handoff before compaction runs.
_Avoid_: Summarization pass, pre-compaction hook

**Model Handoff**:
The handoff the acting model writes to its future self during the Handoff Turn, embedded verbatim as the compaction summary: objective, Stance Labels, state, next action, and continuation choice. Newer retained messages override it; deterministic filtering removes recognized credentials, personal data, and secret paths. When no Model Handoff exists — manual compaction, overflow, or a malformed reply — a summarizer produces the same structure from the transcript alone.
_Avoid_: Dense handoff, resume contract, transcript summary

**Stance Label**:
The per-artifact label in a Model Handoff — editing, reviewing, executing, or reference — recording the session's relationship to a file or skill so a resumed model does not mistake a work object for instructions to follow.
_Avoid_: Role, file mode

**Compaction Continuation**:
At most one automatic recovery turn after boundary-triggered compaction, sent only when the Model Handoff chose continue; done and ask-user suppress it and leave the session waiting for the user. Boundary compactions that fell back to a summarizer always continue. Manual compaction remains user-controlled, while overflow recovery remains a retry of the interrupted turn.
_Avoid_: Auto-retry, automatic handoff

**Retained Conversation Tail**:
Approximately 30,000 tokens of the newest raw conversation kept alongside the compaction summary. The system prompt, tool definitions, and summary are outside this budget.
_Avoid_: Total compacted context, summary budget

**Overflow Recovery**:
Pi's last-resort compaction and retry when a model call exceeds its context window before boundary compaction can run. It preserves the interrupted turn rather than creating a Compaction Continuation.
_Avoid_: Compaction Continuation, proactive compaction

### Delegation

**Delegate Trail**:
The bounded, ordered record of a child's recent activity: the messages it exchanged and the tool calls it made, interleaved. Message history and tool history are bounded separately, so neither can evict the other.
_Avoid_: Transcript, full history, conversation

**Delegate Task Brief**:
A self-contained assignment stating a child's objective, scope, mutation authority, constraints, verification, and expected result. It supplies what the child cannot get from the project's own context files.
_Avoid_: Workspace intent, inherited context

**Delegate Output Format**:
Advisory free-text guidance for presenting a Delegate Run's result. Correct and complete information takes precedence over exact conformance.
_Avoid_: Schema, structured output contract

**Delegate Run**:
One newly created child carrying out one Delegate Task Brief, either blocking or in the background. A Model Handoff and its requested Compaction Continuation belong to that same run; the handoff alone is not its completed result.
_Avoid_: Orchestration task, Delegate batch

**Delegate Chain**:
A sequence of Delegate Runs in which the parent uses each completed result to compose the next Delegate Task Brief.
_Avoid_: Automatic handoff, child-to-child delegation

**Parallel Delegation**:
Delegate Runs issued together, allowed to execute concurrently, and settled independently.
_Avoid_: Delegate batch, parallel plan

**Blocking Delegate Run**:
A Delegate Run that returns only after its child settles. This is the default form.
_Avoid_: Synchronous orchestration

**Background Delegate Run**:
A Delegate Run that returns its identity immediately and delivers its result after the child settles.
_Avoid_: Non-blocking orchestration, detached Delegate

**Delegate Session**:
The parent-session-scoped record of one delegated child, retained after settlement for inspection, steering, waiting, or cancellation where applicable.
_Avoid_: Orchestration plan, resumable Delegate

**Delegate Effort**:
The reasoning depth chosen for a Delegate Run. It selects the child's thinking level and nothing else.
_Avoid_: Time budget, task size, cost tier

**Execution Ceiling**:
The single hard limit on wall time and reported tokens that terminates any Delegate Run, identical at every Delegate Effort.
_Avoid_: Soft limit, effort budget, convergence window

**Delegate Progress**:
The latest bounded activity line for a running Delegate Run: the tool in flight, or the sentence the child is writing.
_Avoid_: Tool counts, thrash signal

**Termination Checkpoint**:
The retained Delegate Trail tail handed to the parent when a Delegate Run settles abnormally, in place of a result.
_Avoid_: Partial result, crash dump, flush

**Delegate Worktree**:
A caller-prepared directory that a Delegate Run executes in. The parent creates, populates, and integrates it; delegation only points the child at it.
_Avoid_: Isolation mode, managed worktree, sandbox

### Codex accounts

**Codex Account**:
One ChatGPT subscription login for the OpenAI Codex provider — a user-given label plus its OAuth credential set — selectable independently of the plan that bills it.
_Avoid_: Profile, subscription, auth entry

**Primary Codex Account**:
The Codex Account held by the built-in Codex provider identity. It needs no alias and is the ambient default.
_Avoid_: Main account, default login

**Codex Account Alias**:
A distinct provider identity carrying exactly one non-primary Codex Account, making that account selectable anywhere a model is chosen — the model selector, the model cycle, and the delegate model setting alike.
_Avoid_: Secondary profile, credential slot, sub-account

### Local tools

**Session Usage**:
The cumulative provider-reported USD cost of one Pi session and every Delegate Run it owns, including settled Delegate Runs. It is split into main-thread and aggregate delegate cost; exact totals extend through the latest completed provider response.
_Avoid_: Running cost, live cost, token budget

**Session Response Archive**:
A bounded collection of text responses retained for later retrieval within one Pi session, including resumed use of that same session.
_Avoid_: Response cache, response storage

**Sacrifice Preference**:
The standing choice that work a session spawns is preferred for termination before the session itself under system memory pressure. No memory ceiling constrains spawned work.
_Avoid_: Memory cap, resource limit, OOM guard

**Terminal Ownership**:
The session that started a background terminal holds it: the terminal, its output, its notifications, and its share of concurrency capacity belong to that session and end with it. No session's usage can exhaust another's.
_Avoid_: Shared terminal pool, inherited terminal, global slot budget

**Terminal Notification**:
An explicit message from a running background command that wakes the terminal's owning session without settling the command. Ordinary process output remains passive.
_Avoid_: Completion notice, streamed output, global notification
