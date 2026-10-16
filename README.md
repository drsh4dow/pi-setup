# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi). It
lives at `~/.pi` and holds a strict system prompt, vendored TypeScript
extensions, skills, prompts, themes, and model defaults. Pi discovers everything
under `~/.pi/agent` on its own, so nothing here is installed as a package.

[`agent/SYSTEM.md`](agent/SYSTEM.md) replaces Pi's system prompt for every
model. It sets the agent's behavior and engineering standards. The skills hold
the procedures for specific kinds of work.

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

## Defaults

- Model: `anthropic/claude-opus-5-5` with high thinking and Fast mode on.
- `Alt-P` cycles the enabled models: `anthropic/claude-opus-5-5`,
  `anthropic/claude-fable-5-1`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`,
  and `opencode-go/glm-5.3-flash`.
- Subagents run `claude-opus-5-5`. Review and design panels pair it with
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
registers the Git filter for `agent/settings.json`. It does not patch the Pi
runtime.

To share the skills with tools that read `~/.agents/skills`, link them:

```bash
mkdir -p ~/.agents
ln -s ../.pi/agent/skills ~/.agents/skills
```

If `~/.agents/skills` already exists, merge the skills you want to keep into
`agent/skills` and move the original directory aside first.

Native MCP is opt-in, and this setup configures no servers. From a repository,
`pi mcp add -l` adds a project server to `.pi/mcp.json`, and `/mcp` inspects it.
Do not install `pi-mcp-adapter` alongside native MCP: it replaces Pi's session
implementation, while the shell-level `pi mcp` commands keep using native MCP.

## What's included

`agent/scripts/verify-docs.ts` checks the inventories below against the
tracked and untracked, non-ignored files.

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for
  session-owned processes, plus `emit-to-pi` notifications
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
- `tps-tracker`: live and final output-token throughput
- `ui-moto`: compact model and project status header
- `web-search`: registers the Perplexity and Exa MCP servers behind the
  `web-search` skill. Only `perplexity_search` and `web_fetch_exa` are
  reachable, and only from codemode. Needs `PERPLEXITY_API_KEY` and
  `EXA_API_KEY`

`agent/extensions/herdr-agent-state.ts` carries local patches. Updating Herdr's
integration overwrites it, so restore the repository version afterwards and run
`/reload` in affected sessions.

### Installed skills

`wizard` and `writing-for-agents` are vendored from
[`mattpocock/skills` at `6fd9479`](https://github.com/mattpocock/skills/tree/6fd947921b935b7e1e69293a200400f0fdd5c15f/skills).

Every skill whose name also appears in pstack is ported from it. See
[pstack](#pstack).

- `architect`
- `arena`
- `automate-me`
- `background-terminals`
- `benchmark-checklist`
- `blast-radius`
- `bro`
- `correct`
- `create-verification-skill`
- `docs-search`
- `dumpfile`
- `figure-it-out`
- `frontend-design`
- `how`
- `in-your-own-words`
- `interrogate`
- `ketchup`
- `mailbox`
- `maintain-verification-skill`
- `no-comments`
- `pi-harness`
- `poteto-help`
- `principle-attack-the-premise`
- `principle-boundary-discipline`
- `principle-build-the-lever`
- `principle-encode-lessons-in-structure`
- `principle-exhaust-the-design-space`
- `principle-experience-first`
- `principle-explain-the-number`
- `principle-fix-root-causes`
- `principle-foundational-thinking`
- `principle-guard-the-context-window`
- `principle-laziness-protocol`
- `principle-make-operations-idempotent`
- `principle-migrate-callers-then-delete-legacy-apis`
- `principle-minimize-reader-load`
- `principle-model-the-domain`
- `principle-never-block-on-the-human`
- `principle-outcome-oriented-execution`
- `principle-prove-it-works`
- `principle-redesign-from-first-principles`
- `principle-separate-before-serializing-shared-state`
- `principle-sequence-verifiable-units`
- `principle-subtract-before-you-add`
- `principle-test-behavior-not-implementation`
- `principle-type-system-discipline`
- `recall`
- `reflect`
- `sharpen`
- `show-me-your-work`
- `subagents`
- `swarm`
- `tdd`
- `teach`
- `technical-writing`
- `typescript-best-practices`
- `unslop`
- `web-search`
- `why`
- `wizard`
- `writing-for-agents`
- `writing-good-tickets`

### Installed prompts

- `deslop`: simplify a completed work package
- `handoff`: compact the conversation into a message for a fresh agent
- `wait-what`: ask for a re-pitch of a message that did not land

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

The system prompt and most skills come from
[pstack at `99743e9`](https://github.com/cursor/plugins/tree/99743e9c151c8537cbbf1f98bb38f34ef3368453/pstack),
Lauren Tan's Cursor plugin. [`agent/SYSTEM.md`](agent/SYSTEM.md) is its
`poteto-mode` skill rewritten as a system prompt, and
[`agent/poteto/`](agent/poteto/) holds that skill's playbooks, references, and
scripts. The scripts are vendored as-is: lint, format, and type checks skip
them. Not ported: `setup-pstack`, `make-bot-ui`, the `poteto-agent` wrapper,
the worktree-cleanup playbook, and the Benny automations.

[`agent/scripts/pstack-port.ts`](agent/scripts/pstack-port.ts) does the
mechanical part of the port: file placement, relative links, frontmatter, and
`/skill:name` commands. The Cursor-specific parts are local edits, mapped as
follows:

| pstack on Cursor                                                       | Pi                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task` subagents, `subagent_type`, `poteto-agent`, `run_in_background` | `pi --print` subagents started with `bg_start`, per the `subagents` skill. Every subagent already runs `SYSTEM.md`.                                           |
| `readonly: true`                                                       | The assignment's write scope says the subagent changes nothing.                                                                                               |
| Cloud agents and cloud VMs                                             | Local subagents, each in its own git worktree with its own ports and state.                                                                                   |
| Resuming a subagent                                                    | `pi --print --session <file>` on its session file.                                                                                                            |
| `comment-sicko` agent                                                  | `no-comments/references/comment-sicko.md`, passed with `--append-system-prompt`.                                                                              |
| `pstack-models.mdc`, `/setup-pstack`, Grok and Cursor model slugs      | The role's row in the `subagents` model table, passed as `--model` and `--thinking`.                                                                          |
| `AskQuestion`                                                          | A plain question at the end of the reply.                                                                                                                     |
| Todolist                                                               | A Markdown checklist in the reply, as `SYSTEM.md` defines it.                                                                                                 |
| `/loop`                                                                | A background terminal whose completion wakes the agent: the watcher command for an event, `sleep <seconds>` for a cadence. Terminals end with the Pi session. |
| `control-ui`                                                           | The `agent-browser` skill.                                                                                                                                    |
| `control-cli`                                                          | The `background-terminals` skill, with tmux for TUIs.                                                                                                         |
| `create-skill`                                                         | The `writing-for-agents` skill.                                                                                                                               |
| `/deslop`                                                              | The [`deslop`](agent/prompts/deslop.md) prompt, read and applied by the agent.                                                                                |
| `agent-transcripts/`                                                   | Pi session files: `$PI_SESSION_FILE` and the other sessions in its directory.                                                                                 |
| `/poteto-mode` and the `poteto-mode` skill                             | `agent/SYSTEM.md`, loaded for every session.                                                                                                                  |
| `.cursor/skills/`                                                      | `.agents/skills/`                                                                                                                                             |
| Cursor's built-in babysit, Plan Mode, and Custom Modes                 | Removed.                                                                                                                                                      |

To sync, check out the synced and the new upstream commits, run
`node agent/scripts/pstack-port.ts sync <new>/pstack <synced>/pstack`, resolve
the reported conflicts, port new upstream text in `poteto-mode/SKILL.md` into
`SYSTEM.md` by hand, and update the commit above. `vp run verify` runs
`pstack-port.ts check`, which fails on Cursor-only terms that a sync brings
back.

## Repository layout

```text
agent/
├── SYSTEM.md          # system prompt, ported from pstack's poteto-mode
├── poteto/            # pstack playbooks, references, and scripts
├── settings.json      # models, thinking level, compaction, and theme
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
cli/
└── dumpfile/          # R2 upload CLI, signer Worker, tests, and setup wizard
oxlint/                # vendored anti-slop lint plugins
```

Runtime state and secrets, such as `auth.json`, sessions, run history, and
trusted local paths, are ignored and must not be committed.
[`agent/trust.example.json`](agent/trust.example.json) shows the trust-file
shape without machine-specific paths.

Pi writes machine-local state into `agent/settings.json`, so Git sees that file
through [`agent/scripts/clean-settings.ts`](agent/scripts/clean-settings.ts).
Commits and diffs omit `deviceId`, `lastChangelogVersion`, and local-path
`packages`, and record Fast mode as on, whatever the working copy holds. A
checkout that changes the committed file overwrites the working copy: Pi
restores its own values, and local packages must be added again.

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
`vp run --no-cache verify` reruns everything. Live Pi integration tests need
provider credentials and run separately with `vp run test:e2e`.

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

`vp run build:cli` compiles `emit-to-pi` and `dumpfile` with Bun.
Background terminals put `.build/bin` on their command search path.

## License

MIT. See [`LICENSE`](LICENSE).
