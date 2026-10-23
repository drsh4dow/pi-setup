# Development

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
the vendored [anti-slop plugins](../oxlint/anti-slop/UPSTREAM.md) fail on
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

## Setup notes

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

[`agent/mcp.json`](../agent/mcp.json) is Pi's user-level MCP configuration. It
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

Custom keybindings: `Ctrl-P` and `Ctrl-N` move through selectors, `Alt-P`
cycles the enabled models, and `Ctrl-Alt-M` toggles Fast mode.

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
[`agent/trust.example.json`](../agent/trust.example.json) shows the trust-file
shape without machine-specific paths.

Pi reads `agent/settings.json` and writes machine-local state into it, so Git
ignores that file. The repository defaults live in
[`agent/default.settings.json`](../agent/default.settings.json). To share a
setting, change the default file and copy the setting into your own
`agent/settings.json`.

## pstack concepts in Pi

Many skills took their ideas from
[pstack](https://github.com/cursor/plugins/tree/main/pstack), which targets
Cursor. This table maps pstack's Cursor concepts to their Pi counterparts, for
reading a pstack skill next to its counterpart here.

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
