---
name: background-terminals
description: Use when running background services, watchers, subagents, or finite commands alongside independent work.
---

Background terminals have no interactive stdin, so commands must run without prompts or interaction.

Before starting a server or watcher, check `bg_list` for an existing copy. Give each new terminal a distinct, meaningful title. Continue genuinely independent work. If the requested answer depends on the job and nothing independent remains, give only a brief pending status and end the turn; deliver the answer after completion wakes you. Do not repeat the background task while waiting or poll for completion.

A codemode script has no timers and cannot wait for a terminal. End the script
after `bg_start` and let completion wake you.

Completion automatically wakes the owning agent with the real exit code. Run finite commands directly: a trailing notification command can mask their exit status. Use `emit-to-pi <message>` only for actionable intermediate events while a command keeps running; it never settles the command.

Completion messages contain status and output, with a shared 24 KiB output budget. Display abbreviation is marked; use `bg_status` for more retained output. Use `bg_status` when you need current output or state, and `bg_kill` when a process is stuck or no longer needed. `/ps` provides an interactive view of tracked terminals, including their full commands and working directories.

## Limits and ownership

Each stream retains only its newest 256 KiB. Redirect output to a file when the full log must survive. Each session can run eight terminals and track 32. Once history is full, a new terminal evicts the oldest settled entry, never a running one.

Terminals belong to the owning Pi session and stop when it shuts down. They are not persistent services independent of Pi. Windows descendant cleanup is best effort after the tracked shell exits.

Background commands share the worktree without write isolation. Run concurrent mutations only when each process owns disjoint files and build artifacts. Before finishing the task, keep each live terminal for a stated current need or stop it with `bg_kill`.
