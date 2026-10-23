# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi). It
lives at `~/.pi` and holds a minimal system prompt, vendored TypeScript
extensions, skills, prompts, themes, and model defaults. Pi discovers everything
under `~/.pi/agent` on its own, so nothing here is installed as a package.

[`agent/SYSTEM.md`](agent/SYSTEM.md) replaces Pi's system prompt for every
model. It sets the agent's baseline behavior. The skills hold the
procedures for specific kinds of work, and `principle-engineering-standards` holds the
code standards.

## How I work

The nature of the task decides the path. Some tasks are just a conversation,
some are research, and some are implementation that I do directly in the
session.

When I understand the scope well, or just want the agent to come up with a
plan, I ask it to research the problem and propose one. I correct the plan, then
rewind with a handoff, so implementation starts from the corrected plan instead
of the research that produced it.

Rewinding keeps a conclusion and drops the path that led to it. Besides plans, I
use it after side branches where I investigate, discuss, or settle a question.
Pressing Escape twice on an empty editor opens the session tree (`/tree` does
the same), and I pick the point where the research or detour started. Pi can
summarize the branch I'm leaving, or I run `/handoff`, `/copy` the result, and
paste it at that point. I usually stay in the same session.

### Take a ticket to a PR

The agent leans autonomous, so I name a stop at each stage where a
wrong ticket or a wrong design would be expensive. The agent waits at every
stop I name.

**1. Check the ticket.** The agent reads the code and plays the ticket back
before it designs anything, so a wrong premise shows up early.

```text
Ticket: <paste it, or gh issue view 123>.
Read the code it touches. Restate the goal, the problem, and what the ticket
assumes about the system. Flag anything that contradicts the code or looks
wrong. Don't design or change anything yet.
```

**2. Review the design.** The agent runs `how` and `architect`, then stops
with the design. I read the usage sketch first, because awkward call sites mean
the types are wrong.

```text
Implement it. Architect it with a checkpoint: show me the usage sketch, the
types, the rationale, and the open questions, then stop. Don't write
implementation code until I approve the design.
```

**3. Approve the PR.** The agent delegates the code, verifies it on the real
app, and commits. It opens the PR only after I see the result.

```text
Approved. Build it against the sketch and verify it. Commit locally and show
me the diff summary and the evidence before you open the PR.
```

### Start a new project

With no existing code, the expensive mistake is the wrong data model, so I
review the design before anything else exists. The examples follow one project,
a web app where an on-call team logs incidents and reads a weekly summary.

1. Sharpen the idea. I say who the project is for and how I'll know it works.

   ```text
   /skill:sharpen
   New project: a web app where an on-call team of five logs incidents and
   reads a weekly summary. It works when someone logs an incident in under a
   minute and Monday's summary lists every incident from the past week.
   Don't write code yet.
   ```

2. Ask for the design with a stop. Architect skips grounding here because there
   is no system to study.

   ```text
   Architect the core data model and module map with a checkpoint. Show me the
   usage sketch, the types, the rationale, and the open questions, then stop.
   ```

   I push back on the design in plain words until the types fit every case.

   ```text
   An incident can be reopened. Model its status so a reopened incident keeps
   its earlier resolution, then redo the sketch.
   ```

3. Scaffold the checks before any feature.

   ```text
   Scaffold the project from the approved design: strict types, lint, a verify
   command, and an AGENTS.md that names it. No features yet.
   ```

4. Build the first feature with the ticket flow above.

   ```text
   Ticket: log an incident. A team member enters a title, a severity, and a
   start time, and the incident appears at the top of the list.
   ```

5. Once a user can reach that feature, generate the verify skill. It writes
   `.agents/skills/verify-<app>/`, which Pi discovers on its own. Earlier, it
   has nothing to drive.

   ```text
   /skill:create-verification-skill
   ```

6. Add the rest one ticket at a time. Every few features, run
   `/skill:maintain-verification-skill` to add them to the feature map.

   ```text
   Ticket: weekly summary. Every Monday, the summary page lists last week's
   incidents grouped by severity, with time to resolve for each.
   ```

### Work in a large legacy codebase

The agent can't understand millions of lines, so I keep it on the slice the
ticket touches and make it prove behavior on the running app.

1. Start Pi at the repository root and name the package in every prompt. Pi
   discovers skills only in the root `.agents/skills/`, so verify skills go
   there.
2. Make the package runnable and drivable before the first change. Each app
   gets its own `verify-<app>` skill.

   ```text
   /skill:create-verification-skill
   Scope: <the service or package>. If it doesn't build or start, tell me
   exactly why before you generate anything.
   ```

3. Map the slice, and ask why for anything that looks pointless. Old code often
   has a reason nobody remembers.

   ```text
   How does <subsystem> handle <what the ticket touches>? Then, why is
   <odd part> built this way? Cite the code and the history. Change nothing.
   ```

4. Take the ticket through the flow above. Stage 1 matters most here, because
   tickets often describe how the code used to work.
5. Run `/skill:blast-radius` on any diff I don't trust before it merges.
6. When a verify run fails because the app changed rather than broke, run
   `/skill:maintain-verification-skill`.
7. Clean up through the tickets, not in one sweep. `/skill:correct` turns a
   mistake agents repeat into a type, lint, or test, and it fails only on new
   cases of a pattern that is already common.

## Defaults

- Model: `anthropic/claude-opus-5-5` with high thinking and Fast mode on.
- `Alt-P` cycles the enabled models: `anthropic/claude-opus-5-5`,
  `anthropic/claude-fable-5-1`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`,
  and `opencode-go/glm-5.3-flash`.
- Subagents run `claude-opus-5-5`, and scouting roles run `claude-haiku-5-5`.
  Thinking tops out at `high`. Review and design panels pair Opus with
  `gpt-6.1-sol`. The role table lives in the
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

[`agent/mcp.json`](agent/mcp.json) is Pi's user-level MCP configuration. It
connects the Perplexity and Exa servers behind the `web-search` skill and reads
their keys from `PERPLEXITY_API_KEY` and `EXA_API_KEY`. Each server is hidden
except for the one tool the skill uses, `perplexity_search` or `web_fetch_exa`,
and that tool is reachable only from codemode. Tools a vendor adds later,
including Perplexity's per-token Agent API tools, therefore stay unreachable.
Git tracks this file, so write credentials as `${NAME}` references and never as
literal values. From a repository, `pi mcp add -l` adds a project server to
`.pi/mcp.json`, and `/mcp` inspects it.
Do not install `pi-mcp-adapter` alongside native MCP: it replaces Pi's session
implementation, while the shell-level `pi mcp` commands keep using native MCP.

## What's included

`scripts/verify-docs.ts` checks the inventories below against the
tracked and untracked, non-ignored files.

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for
  session-owned processes, plus `emit-to-pi` notifications
- `build-bin-path`: puts `.build/bin` (`pi-subagent`, `emit-to-pi`, `dumpfile`)
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
- `herdr-worktrees`: inside Herdr, each checkout that appears under
  `.worktrees/<branch>` or `.worktrees/<repo>/<branch>` of the session's
  directory opens as a Herdr workspace, grouped under its repository
- `process-status`: `/ps` views of background terminals and the `session_usage`
  tool
- `prompt-context`: restores Pi's `<tools>` and `<rules>` sections with the
  stock wording, which Pi omits when a custom system prompt replaces its own
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

`agent-browser` is adapted from the
[`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser)
skill.

`wizard` and `writing-for-agents` come from
[Matt Pocock's skills](https://github.com/mattpocock/skills) and are maintained
here as this setup's own.

`setup-sh4dow-skills` is this setup's counterpart to Matt Pocock's
`setup-matt-pocock-skills`: it writes the per-repository config record
(tracker, domain docs, standards and guardrails) that the
engineering skills read, so they work the same in any project.

`codebase-design`, `domain-modeling`, `grill-with-docs`, `grilling`,
`improve-codebase-architecture`, `to-spec`, and `to-tickets` start from
[Matt Pocock's skills](https://github.com/mattpocock/skills), adapted so the
design step runs through `architect` and `arena`. Thanks, Matt.

Every skill whose name also appears in pstack is ported from it. See
[pstack](#pstack).

`babysit` revives pstack's Babysit playbook as a skill. It owns pstack's
`watch-pr` watcher under `agent/skills/babysit/scripts/`, with its own locked
dependencies and its Bugbot triage rubric.

`code-review`, `prototype`, and `research` start from Matt Pocock's skills of
the same names. `code-review` runs a panel of persona subagents. Its
personas draw on pstack's comment sicko and on
[Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills) (MIT):
its code reviewer, security auditor, test engineer, and code simplification
skill. It also absorbs the diff review of the retired `interrogate` skill,
whose design-sketch review now lives in `architect`.

`reflect` also covers Matt Pocock's `retro`: it can review any session and
routes each lesson either to a skill or to the project's agent environment.

- `agent-browser`
- `architect`
- `arena`
- `automate-me`
- `babysit`
- `background-terminals`
- `benchmark-checklist`
- `blast-radius`
- `code-review`
- `codebase-design`
- `correct`
- `create-formal-verification-skill`
- `create-verification-skill`
- `docs-search`
- `domain-modeling`
- `dumpfile`
- `frontend-design`
- `grill-with-docs`
- `grilling`
- `how`
- `improve-codebase-architecture`
- `mailbox`
- `maintain-formal-verification-skill`
- `maintain-verification-skill`
- `pi-harness`
- `principle-attack-the-premise`
- `principle-boundary-discipline`
- `principle-build-the-lever`
- `principle-encode-lessons-in-structure`
- `principle-engineering-standards`
- `principle-exhaust-the-design-space`
- `principle-experience-first`
- `principle-explain-the-number`
- `principle-fix-root-causes`
- `principle-laziness-protocol`
- `principle-make-operations-idempotent`
- `principle-minimize-reader-load`
- `principle-model-the-domain`
- `principle-prove-it-works`
- `principle-redesign-from-first-principles`
- `principle-separate-before-serializing-shared-state`
- `principle-sequence-verifiable-units`
- `principle-test-behavior-not-implementation`
- `prototype`
- `recall`
- `reflect`
- `research`
- `setup-sh4dow-skills`
- `sharpen`
- `subagents`
- `swarm`
- `tdd`
- `teach`
- `to-spec`
- `to-tickets`
- `typescript-best-practices`
- `unslop`
- `web-search`
- `why`
- `wizard`
- `writing-for-agents`
- `writing-good-commits`
- `writing-good-prs`
- `writing-good-tickets`

### Installed prompts

- `bro`: restate the last message in plain language, with no jargon
- `handoff`: compact the conversation into a message for a fresh agent
- `implement-chunk`: orchestrate a ticket and its sub-tickets through
  subagents to merge-ready PRs, then verify them live after merge
- `restate-sharpened`: load the sharpen skill and restate the user's goals and
  problem

### Installed CLI tools

- [`dumpfile`](cli/dumpfile/README.md) publishes screenshots, recordings, and
  other review evidence to immutable public R2 URLs. The links are not
  permanent, and setup can opt into 30-day object-age retention. Run
  `./cli/dumpfile/setup.sh` once to provision Cloudflare and install the
  command.

### Installed themes

- `catppuccin-mocha`
- `gruvbox-dark-hard`

## pstack

Most skills come from
[pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's
Cursor plugin. This setup no longer syncs from upstream; the ported files are
maintained here as its own. Not ported: `setup-pstack`, the `poteto-agent`
wrapper, and the Benny automations.

The port rewrote pstack's Cursor-specific parts for Pi, mapped as follows:

| pstack on Cursor                                                       | Pi                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task` subagents, `subagent_type`, `poteto-agent`, `run_in_background` | `pi-subagent` subagents started with `bg_start`, per the `subagents` skill. `poteto-agent` maps to the delegate kind. An owner is an owner-kind subagent in its own worktree. It has no VM or dashboard, so the agent store records its children. |
| `readonly: true`                                                       | The assignment's write scope says the subagent changes nothing.                                                                                                                                                                                   |
| Cloud agents and cloud VMs                                             | Local subagents, each in its own git worktree with its own ports and state.                                                                                                                                                                       |
| Resuming a subagent                                                    | `pi-subagent --session <file>` on its session file.                                                                                                                                                                                               |
| `pstack-models.mdc`, `/setup-pstack`, Grok and Cursor model slugs      | The role's row in the `subagents` model table, passed as `--model` and `--thinking`.                                                                                                                                                              |
| `AskQuestion`                                                          | A plain question at the end of the reply.                                                                                                                                                                                                         |
| Todolist                                                               | A Markdown checklist in the reply.                                                                                                                                                                                                                |
| `/loop`                                                                | A background terminal whose completion wakes the agent: the watcher command for an event, `sleep <seconds>` for a cadence. Terminals end with the Pi session.                                                                                     |
| `control-ui`                                                           | The `agent-browser` skill.                                                                                                                                                                                                                        |
| `control-cli`                                                          | The `background-terminals` skill, with tmux for TUIs.                                                                                                                                                                                             |
| `create-skill`                                                         | The `writing-for-agents` skill.                                                                                                                                                                                                                   |
| `agent-transcripts/`                                                   | Pi session files: `$PI_SESSION_FILE` and the other sessions in its directory.                                                                                                                                                                     |
| `.cursor/skills/`                                                      | `.agents/skills/`                                                                                                                                                                                                                                 |
| Cursor's built-in babysit                                              | The `babysit` skill.                                                                                                                                                                                                                              |
| Plan Mode and Custom Modes                                             | Removed.                                                                                                                                                                                                                                          |

## Repository layout

```text
agent/
├── SYSTEM.md          # minimal system prompt
├── default.settings.json  # models, thinking level, compaction, and theme
├── keybindings.json
├── mcp.json           # Perplexity and Exa servers for the web-search skill
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
scripts/               # repository checks
cli/
└── dumpfile/          # R2 upload CLI, signer Worker, tests, and setup wizard
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
`vp run --no-cache verify` reruns everything. `verify:babysit-scripts`
type-checks and tests the `babysit` skill's `watch-pr` against its own
`tsconfig.json` and locked dependencies. Live Pi integration tests
need provider credentials and run separately with `vp run test:e2e`. Run them
after you upgrade Pi.

`scripts/verify-skills.ts` checks the skill packages under
`agent/skills/` and `.agents/skills/`. It loads them with Pi's own
`DefaultResourceLoader`, the loader a session in this checkout uses, so it sees
the same skills, including untracked and nested ones and each tree's layout
rules. It fails on every diagnostic Pi reports, for example frontmatter that is
not valid YAML, an empty description, or two skills with the same name. It also
fails when a skill's `name` differs from its directory name, and when Pi loads
no skill at all. It fails when a file under the `scripts/` directory of a skill
that Pi loads starts with `#!` but is not executable, either in the git index
or on disk, and names the
`chmod +x <path> && git add <path>` command that fixes it. It fails on a
Markdown line that sends the agent to a skill Pi does not load, and names the
file and line. It reads the forms the skills use: "the **how** skill", "the
**laziness-protocol** and **minimize-reader-load** principle skills",
"**principle-boundary-discipline**", and `/skill:how`. The check ignores settings, including the packages that
settings install, so the untracked `agent/settings.json` cannot change its
result. It also ignores `~/.agents/skills/` and does not load extensions.

`scripts/verify-gates.ts` fails when unpushed work weakens a gate: a skipped or
deleted test, assertions removed from a test that stays, a new `@ts-ignore` or
lint disable, an empty `catch`, a loosened threshold or severity, or a check
removed from `package.json`, `vite.config.ts`, or a workflow, ignoring comment
lines. It reads the diff against the upstream merge base plus untracked files.
When the branch has no upstream, as on a new local branch or in CI, it uses the
merge base with the default branch (`origin/HEAD`, then `main` or `master`, remote first),
and only uncommitted changes when none exists. Eval fixtures under
`evals/*/{fixtures,changes,defects}/` hold deliberately weak code that verify
never runs, so it skips them. It reports a threshold change
it cannot classify instead of passing it. A finding passes only when an entry in
`scripts/verify-gates.exceptions.json` names its path glob and rule with a
reason, an owner, and an `until` date, and it fails again once that date has
passed. It exits 2 when it cannot run.

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

`vp run build:cli` compiles `pi-subagent`, `emit-to-pi`, and `dumpfile` with
Bun. The `build-bin-path` extension puts `.build/bin` on the search path of
every command Pi runs.

## License

MIT. See [`LICENSE`](LICENSE).
