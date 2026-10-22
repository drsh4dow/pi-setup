# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi). It
lives at `~/.pi` and holds a short system prompt, vendored TypeScript
extensions, five skills, themes, and model defaults. Pi discovers everything
under `~/.pi/agent` on its own, so nothing here is installed as a package.

[`agent/SYSTEM.md`](agent/SYSTEM.md) replaces Pi's system prompt for every
model. It holds a short preface and the rules for choosing and combining tools.
The `prompt-context` extension adds back the tool descriptions and guidelines
that Pi drops when a custom prompt replaces its own.

## Defaults

- Model: `anthropic/claude-opus-5-5` with high thinking and Fast mode on.
- `Alt-P` cycles the enabled models: `anthropic/claude-opus-5-5`,
  `anthropic/claude-fable-5-1`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`,
  and `opencode-go/glm-5.3-flash`.
- Subagents run `claude-opus-5-5`, exploration runs `claude-haiku-5-5`, and
  reviews of work from another model family run `gpt-6.1-sol`. Thinking tops
  out at `high`. The table lives in the
  [`subagents`](agent/skills/subagents/SKILL.md) skill.
- Compaction is Pi's built-in one. Opus reserves 700K tokens, so it compacts
  well before its context window fills.
- Codemode is on alongside the direct tools.
- The TUI runs fullscreen with Catppuccin Mocha. Gruvbox Dark Hard is included.

Custom keybindings:

- `Ctrl-P` / `Ctrl-N` move through selectors.
- `Alt-P` cycles enabled models.
- `Ctrl-Alt-M` toggles Fast mode.

## Install

Install [Vite+](https://viteplus.dev/guide/), then clone this repository into
Pi's global configuration directory. Vite+ selects the pinned Bun and Node
versions from `package.json`:

```bash
git clone https://github.com/drsh4dow/pi-setup.git ~/.pi
cd ~/.pi
vp install
vp install -g @earendil-works/pi-coding-agent
pi
```

If `~/.pi` already exists, move or merge it before cloning. Use `/login` inside
Pi to authenticate model providers.

`vp install` patches Vite+'s Oxlint for Effect diagnostics, builds the
standalone CLI binaries under `.build/bin` for the current platform, and
copies `agent/default.settings.json` to `agent/settings.json` when that file
does not exist. It does not patch the Pi runtime.

To share the skills with tools that read `~/.agents/skills`, link them:

```bash
mkdir -p ~/.agents
ln -s ../.pi/agent/skills ~/.agents/skills
```

If `~/.agents/skills` already exists, merge the skills you want to keep into
`agent/skills` and move the original directory aside first.

The `web-search` extension registers the Perplexity and Exa MCP servers. Set
`PERPLEXITY_API_KEY` and `EXA_API_KEY` before you start Pi. From a repository,
`pi mcp add -l` adds a project server to `.pi/mcp.json`, and `/mcp` inspects it.
Do not install `pi-mcp-adapter` alongside native MCP: it replaces Pi's session
implementation, while the shell-level `pi mcp` commands keep using native MCP.

## What's included

`agent/scripts/verify-docs.ts` checks the inventories below against the
tracked and untracked, non-ignored files.

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for
  session-owned processes, plus `emit-to-pi` notifications
- `build-bin-path`: puts `.build/bin` (`pi-subagent` and `emit-to-pi`)
  on the PATH of every command Pi runs, the `bash` tool included
- `delegate-guard`: keeps subagents two tiers deep. A subagent launched without
  `subagents/owner.md` is a delegate and may run no `pi --print` or `pi -p`
  launch. An owner, a subagent a playbook hands a whole unit such as a PR, may
  launch only delegates.
  It checks `bash`, `bg_start`, and codemode alike
- `fast-mode`: `/fast` and `Ctrl-Alt-M` toggle Fast mode for the models listed
  under `fastMode` in `agent/settings.json`, and the footer shows `⚡ Fast` while
  it is on. A provider entry with `subagentsEnabled: false` skips sessions
  named `subagent: …`
- `herdr-agent-state`: Herdr pane state and Pi session reporting
- `herdr-bg-indicator`: reports running background terminals, such as `2 bg`,
  as the `$bg` Herdr pane token. Herdr shows it only where a sidebar row names
  it, for example `rows = [["state_icon", "machine", "workspace", "tab", "$bg"],
  ["agent"]]` under `[ui.sidebar.agents]` in `~/.config/herdr/config.toml`
- `process-status`: `/ps` views of background terminals and the `session_usage`
  tool
- `prompt-context`: restores active-tool snippets and guidelines, which Pi
  omits when a custom system prompt replaces its own
- `sacrifice-preference`: marks spawned work as the preferred target under Linux
  memory pressure
- `session-timer`: branch duration since the first user message, with clock
  footers on responses
- `skill-visibility`: `/skill-visibility` controls which loaded skills the model
  can discover, and skills marked `user-invokable: false` stay out of `/skill:`
  autocomplete
- `subagents`: the `pi-subagent` launcher runs a subagent as a read-only Pi
  chat in its own Herdr pane, listed under its parent in the agents sidebar.
  Outside Herdr it runs `pi --print`. It also runs `pi --print` where the pane
  cannot match it: a terminal on stdin, an extension command as the task, or a
  missing model, login, or catalog entry
- `tps-tracker`: live and final output-token throughput
- `ui-moto`: compact model and project status header
- `web-search`: registers the Perplexity and Exa MCP servers behind the
  `web-search` skill. Only `perplexity_search` and `web_fetch_exa` are
  reachable, and only from codemode. Needs `PERPLEXITY_API_KEY` and
  `EXA_API_KEY`

`agent/extensions/herdr-agent-state.ts` carries local patches. Updating Herdr's
integration overwrites it, so restore the repository version afterwards and run
`/reload` in affected sessions.

### Differences from `pi --print` in Herdr

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

### Installed skills

- `background-terminals`
- `docs-search`
- `pi-harness`
- `subagents`
- `web-search`

### Installed themes

- `catppuccin-mocha`
- `gruvbox-dark-hard`

## Repository layout

```text
agent/
├── SYSTEM.md          # system prompt: preface and tool rules
├── default.settings.json  # models, thinking level, compaction, and theme
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # agent workflows and references
└── themes/            # Catppuccin and Gruvbox themes
oxlint/                # vendored anti-slop lint plugins
```

Runtime state and secrets, such as `auth.json`, sessions, run history, and
trusted local paths, are ignored and must not be committed.
[`agent/trust.example.json`](agent/trust.example.json) shows the trust-file
shape without machine-specific paths.

Pi reads `agent/settings.json` and writes machine-local state into it, so Git
ignores that file. The repository defaults live in
[`agent/default.settings.json`](agent/default.settings.json). To share a
setting, change the default file and copy the setting into your own
`agent/settings.json`.

## Development

Use `vp` for dependencies and scripts. Bun is the package manager, and Node runs
the test suites directly from TypeScript.

```bash
vp install
vp run verify
```

`verify`, like CI, runs credential-free formatting, lint, type,
diagnostic-enforcement, and behavioral checks. Its tasks live in
`vite.config.ts`. Suites replay from cache when their inputs are unchanged, and
`vp run --no-cache verify` reruns everything. Live Pi integration tests
need provider credentials and run separately with `vp run test:e2e`. Run them
after you upgrade Pi.

`agent/scripts/verify-skills.ts` checks the skill packages under
`agent/skills/` and `.agents/skills/`. It loads them with Pi's own
`DefaultResourceLoader`, the loader a session in this checkout uses, so it sees
the same skills, including untracked and nested ones and each tree's layout
rules. It fails on every diagnostic Pi reports, for example frontmatter that is
not valid YAML, an empty description, or two skills with the same name. It also
fails when a skill's `name` differs from its directory name, and when Pi loads
no skill at all. It fails when a file under the `scripts/` directory of a skill
that Pi loads starts with `#!` but is not
executable, either in the git index or on disk, and names the
`chmod +x <path> && git add <path>` command that fixes it. The check ignores settings, including the packages that
settings install, so the untracked `agent/settings.json` cannot change its
result. It also ignores `~/.agents/skills/` and does not load extensions.

`.agents/skills/verify-subagent-run/scripts/check` model-checks the subagent
run lifecycle with TLA+. It needs Java 11 or newer and downloads TLC once, so
`verify` leaves it out. Run it after changing `agent/extensions/subagents/` or
upgrading Pi or Effect.

`.agents/skills/verify-terminal-delivery/scripts/check` model-checks how a
background terminal's completion and notifications reach the agent. Run it after
changing `agent/extensions/background-terminals/` or upgrading Pi. `verify`
runs only its citation step, which fails when a line that the model cites
changes.

Vite+ supplies the only linter and formatter, Oxlint and Oxfmt, and
`vite.config.ts` owns their policy. Type-aware rules, Effect diagnostics, and
the vendored [anti-slop plugins](oxlint/anti-slop/UPSTREAM.md) fail on
warnings.

Keep these versions aligned when upgrading:

- `typebox` matches Pi's exact version, because tool schemas share types with
  Pi.
- `@oxlint/plugins` stays compatible with the Oxlint version that
  `vp toolchain` reports.
- Vite+ and `@effect/tsgo` move together.

`vp run build:cli` compiles `pi-subagent` and `emit-to-pi` with
Bun. The `build-bin-path` extension puts `.build/bin` on the search path of
every command Pi runs.

## License

MIT. See [`LICENSE`](LICENSE).
