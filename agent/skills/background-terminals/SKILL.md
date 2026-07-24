---
name: background-terminals
description: Run and manage long-lived, non-interactive shell commands while continuing other work.
user-invokable: false
---

# Background Terminals

Use `bg_start` for long-running commands such as servers and watchers. Use `bash` for quick commands and checks. Background commands receive no stdin: never start an interactive command or anything that prompts.

Give each terminal a meaningful, distinct title and check `bg_list` before starting a server or watcher to avoid duplicates. After starting one, continue useful work rather than polling. Pi queues a best-effort completion follow-up; use `bg_status` only when current state or output is needed, and `bg_kill` when work is no longer needed or stuck. `/ps` cheaply lists active terminals alongside subagents and workflows.

Only the newest 256 KiB of stdout and stderr is retained per stream. At most eight terminals run concurrently and 32 are tracked; starting another after the history is full evicts the oldest settled terminal, never a running one. Redirect output explicitly to a suitable file when durable or full logs matter; the bg tools make no full-log promise.

Terminals are scoped to the current Pi session and are stopped on shutdown, reload, resume, fork, or new session. Inside a delegated child, they are also stopped before that child run releases its workspace lease. On Windows, descendant cleanup is best effort after the tracked shell PID has already exited. Do not overlap a parent-owned, workspace-mutating background command with any `delegate_run` or `delegate_workflow` job using `workspace=write`.
