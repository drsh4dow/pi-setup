# Pi Dotfiles

Opinionated configuration and extensions that define how Pi behaves and exposes local tools.

## Language

### Codex accounts

**Codex Account**:
A separately authenticated ChatGPT account available for Codex requests, independent of the chosen model.
_Avoid_: Model, provider

**Codex Account Pin**:
The Codex Account assigned at a session's first Codex use and retained across resume and reload. New sessions and forks select independently; an unavailable pinned account does not trigger automatic reassignment.
_Avoid_: Model pin, per-prompt rotation

**Codex Weekly Allowance**:
The provider-reported percentage remaining in a Codex Account's weekly usage window, distinct from Session Usage.
_Avoid_: Session usage, token budget

### Local tools

**Session Usage**:
The cumulative provider-reported tokens and USD cost of one Pi session. It reports input, output, cache-read, cache-write, total-token, and USD fields through the latest completed provider response. A reported zero remains zero. Missing or invalid provider fields are unavailable, never estimated.
_Avoid_: Running cost, live cost, token budget, estimated cost

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
