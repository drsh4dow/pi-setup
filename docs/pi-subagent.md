# `pi-subagent` in Herdr

Inside Herdr, `pi-subagent` matches `pi --print` on stdout bytes and the exit
code. On every exit path it also closes its pane, removes its run directory,
and leaves no process behind. The differences below are known and accepted.

- **Partial report on Escape.** Someone who presses Escape in the child pane
  aborts the run. The launcher then exits 2 and prints the latest assistant
  text as a partial report.
- **Launcher log lines.** The launcher writes its own `pi-subagent <timestamp>`
  lines to stderr, such as the pane it started and the tab it closed.
- **Delayed and capped stderr.** Child stderr reaches the caller only after Pi
  exits. The launcher forwards the first 64 KiB and then one line saying the
  rest was dropped.
- **Diagnostics shown only in the pane.** Startup warnings, such as a
  `--models` pattern that matches nothing, and extension errors show in the
  pane, not on stderr. The exception is a run the child hands back to
  `pi --print`, which reports them on stderr as usual.
- **Generic failure for some submit errors.** Pi can reject the task for a
  reason the child's checks miss, such as a stored OAuth credential that cannot
  be refreshed. The run then fails after 30 s with "Pi did not start the task",
  where `pi --print` prints Pi's own error at once.
- **Hand-back cost.** A hand-back opens the pane for about 0.7 s first, so
  extension startup runs twice. With `--fork` it leaves an extra fork file, and
  with `--name` on an existing session it adds a duplicate `session_info`
  entry.
- **Input handlers.** If an extension's `input` handler returns `handled` for
  the task, the run exits 1 after 30 s, where `pi --print` exits 0. The task
  also reaches `input` handlers with `source: "extension"`, not
  `"interactive"`. No extension in this repository has an `input` handler.
- **Late deferred prompts.** The report waits for prompts that `agent_settled`
  handlers defer only when those handlers run before the `subagents`
  extension's handler. A prompt from a later handler runs after the report is
  written.
- **Discovery signal.** The child sends the task after the first autocomplete
  rebuild that follows resource discovery, or after 10 s. A discovery handler
  that adds an autocomplete provider, or discovery that takes over 10 s, lets
  the task arrive before discovered skills and prompts are installed. The
  extensions in this repository add none during discovery.
- **A descendant that starts first.** A Pi that an extension starts before the
  child's own `session_start` handler runs inherits the run's environment. It
  leaves the run to the child, because only the child has the run's
  `--subagent-run` argument. A wrapper that forks Pi, such as a Volta shim,
  passes the argument on. An extension that starts Pi with the child's own
  arguments starts a Pi that can claim the run before the child does.
- **A shutdown that hangs after SIGKILL.** When a `session_shutdown` handler
  never returns, a descendant Pi can outlive a launcher that is killed by
  SIGKILL during its release. So can the child itself when the `pi` command
  forks Pi, as a Volta shim does.
- **Rebound dialog cancel key.** The child cancels an extension dialog by
  sending Escape. If `tui.select.cancel` is rebound away from Escape, every
  dialog stays open and fails the run after 5 s.
- **Missing session cwd and early exit 0.** With a `--session` file whose cwd
  no longer exists, the run fails after 60 s, where `pi --print` fails at once.
  A Pi that exits 0 before it reports makes the launcher exit 1.
- **SIGKILL before the pane child starts.** A launcher killed by SIGKILL
  after it creates its run directory and before the pane child starts leaves
  the directory behind, with the launcher's environment in `launch.json`. It
  can also leave a pane with only a shell in it. The next `pi-subagent` run,
  or the next Pi that starts in Herdr, removes the directory and closes the
  pane.
- **Pids in the sweep.** The sweep keeps a run directory while a process has
  the launcher's pid or the pane child's pid. When an unrelated process reuses
  that pid, the directory stays until that process exits. A launcher in another
  pid namespace that shares the runtime directory has a pid that means nothing
  here, so a sweep can remove its live run's directory.
- **SIGINT.** The launcher exits 130 on SIGINT, where `pi --print` dies by the
  signal. A caller that inspects the wait status sees the difference.
