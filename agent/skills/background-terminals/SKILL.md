---
name: background-terminals
description: Use for long-running, non-interactive commands.
user-invokable: false
---

Use `bg_start` for servers, watchers, and other commands that will outlive the current step. Use `bash` for quick commands and checks. A background terminal has no stdin, so its command must run without prompts or interaction.

Before starting a server or watcher, check `bg_list` for an existing copy. Give each new terminal a distinct title. After it starts, return to useful work. Pi queues a best-effort completion notice. Call `bg_status` only when you need current output or state, and call `bg_kill` when the process is stuck or no longer needed. `/ps` lists active terminals and subagents.

## Limits

Each stream retains only its newest 256 KiB. Redirect output to a file when the full log must survive. The session can run eight terminals and track 32. Once history is full, a new terminal evicts the oldest settled entry, never a running one.

Terminals belong to the current parent Pi session. Shutdown, reload, resume, fork, or a new session stops them. A terminal started by a delegated child remains visible to the parent until it is killed or the parent session ends. Windows cleanup is best effort after the tracked shell exits.

Background commands and delegated children share one worktree. Run concurrent mutations only when each process owns disjoint files and build artifacts. Before finishing the task, keep each live terminal for a stated current need or stop it with `bg_kill`.
