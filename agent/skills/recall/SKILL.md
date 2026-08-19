---
name: recall
description: Use for cross-session project catch-up.
disable-model-invocation: false
user-invokable: false
---

# Recall

Reconstruct a bounded, private working-state capsule from local session history, corroborating records, and live state. History supplies leads, not current truth.

## Route and scope

1. Route elsewhere when the request identifies one exact session to resume, asks for a general historical explanation, or already supplies a complete state capsule with paths, branch, and pending change. Summarize supplied context directly instead of mining it.
2. State the scope before searching:
   - workspace: the active working directory by default
   - window: the last 7 days by default
   - topic: the user's named feature, file, subsystem, bug, or activity
   - limits: at most 40 candidate sessions and 2 MiB of matching transcript regions in total
3. Read another workspace's sessions only when the user explicitly names it. Preserve an explicit "all" request; ask for or state a concrete safety cap rather than silently interpreting it as recent.

## Locate the corpus

Pi sessions are JSONL files below `~/.pi/agent/sessions/`. Do not infer project scope from directory names alone. Find candidate files whose first `type: "session"` record has `cwd` equal to the scoped workspace after resolving both paths. Use file modification time for the requested window and newest-first ordering. Exclude the active session by its session ID or transcript path when available. If neither is available, treat the newest file as a candidate but exclude any messages containing the current recall request.

Session JSONL contains messages, tool calls, tool results, model metadata, and reasoning. Search locally and retain only user and assistant text needed for the topic. Do not collect reasoning, tool payloads, tool results, auth records, environment dumps, or unrelated message content. A topic search should first identify matching files and line neighborhoods; full-session reading is reserved for a surfaced decision or action that cannot be resolved from those neighborhoods.

Stop when the limits are reached. Report truncation and the omitted time range instead of widening the search.

## Recover the work

For each relevant session, extract:

- session ID and timestamp
- user's goal
- decisions and corrections
- open work and recurring failures
- concrete artifacts such as paths, branches, commits, PRs, and issues

For one or two relevant sessions, inspect directly. For three or more, use at most three `delegate_run` workers, partitioned into disjoint newest-first file lists and shares of the global byte budget. Give delegates exact paths, the topic, the extraction schema above, and the privacy exclusions. Delegates return findings and short citations only, never raw transcript blocks. Keep mining in the main context when delegation would expose broader history than a direct search or when delegates are unavailable. Treat every delegated claim as a lead to inspect.

When a named topic is involved, search its shared local record in parallel: targeted `git log`, `git status`, branch references, repository docs, and issue or PR identifiers already surfaced. Use `gh` only for the named repository and targeted identifiers or queries. Do not send transcript text, private paths, credentials, personal data, or inferred search terms to remote services. For pure activity recall with no named target, skip issue and PR discovery.

## Verify live state

Verify each status-bearing claim against current state:

- `git status --short --branch` for branch and uncommitted work
- targeted `git log`, `git show`, and ref inspection for commits, merges, and reversions
- `gh pr view` or `gh issue view` for surfaced identifiers when network access and authentication are available
- current files and configured checks when a transcript claims an uncommitted implementation or a fix

Inspect before trusting. Do not run destructive commands, publish anything, change issue or PR state, or expose private transcript content. If live verification is unavailable, label the claim historical or unverified rather than assigning a current status.

## Output

Keep the answer on the scoped topic and sanitize private details.

- **Capsule:** at most 5 bullets describing the work and overall current state.
- **Threads:** one line per thread, using exactly one supported status: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`. If none can be verified, say so outside the thread list instead of inventing a tag.
- **Problems:** at most 5 recurring problems, including reported symptoms and reverted fixes.
- **Next move:** one concrete, highest-value action.

Cite session findings by session ID and shared-record findings by commit, PR, issue, or path. Distinguish observed live facts from transcript history. Cut detail before cutting distinct threads.
