# Pi Dotfiles

Opinionated configuration and extensions that define how Pi behaves and exposes local tools.

## Language

**Session Response Archive**:
A bounded collection of text responses retained for later retrieval within one Pi session, including resumed use of that same session.
_Avoid_: Response cache, response storage

**Delegate Conversation**:
The text messages exchanged through a delegated child session, excluding tool calls and execution diagnostics.
_Avoid_: Activity, diagnostics, tool history

**Delegate Task Brief**:
A self-contained assignment stating a child's objective, scope, mutation authority, constraints, verification, and expected result.
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
