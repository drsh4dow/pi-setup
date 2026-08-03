# Pi Dotfiles

Opinionated configuration and extensions that define how Pi behaves and exposes local tools.

## Language

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
One newly created child carrying out one Delegate Task Brief, either blocking or in the background.
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

### Local tools

**Session Usage**:
The cumulative provider-reported USD cost of one Pi session and every Delegate Run it owns, including settled Delegate Runs. It is split into main-thread and aggregate delegate cost; exact totals extend through the latest completed provider response.
_Avoid_: Running cost, live cost, token budget

**Session Response Archive**:
A bounded collection of text responses retained for later retrieval within one Pi session, including resumed use of that same session.
_Avoid_: Response cache, response storage

**Terminal Ownership**:
The session that started a background terminal holds it: the terminal, its output, its completion notice, and its share of concurrency capacity belong to that session and end with it. No session's usage can exhaust another's.
_Avoid_: Shared terminal pool, inherited terminal, global slot budget
