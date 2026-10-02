# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi): a strict
system prompt, local TypeScript extensions, model defaults, themes, keybindings,
and a small set of reusable prompts.

This repository is meant to live at `~/.pi`. The extensions are vendored here
and loaded directly by Pi; they are not separate packages to install.

## Defaults

- Primary model: `openai-codex/gpt-6-astra` with high thinking
- Additional models: `openai-codex/gpt-6-sol`, `opencode-go/kimi-k3`
- Child-agent model: `openai-codex/gpt-6-luna` with high thinking
- Theme: Catppuccin Mocha; Gruvbox Dark Hard is also included
- Pi's built-in compaction with default settings
- GPT Fast mode enabled
- Codemode enabled in `on` mode alongside the direct tools

Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as this setup's active system
prompt. It defines the agent's behavior and engineering standards.

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

Use `/login` inside Pi to authenticate model providers. If `~/.pi` already
exists, move or merge it before cloning.

`vp install` uses Bun, patches Vite+'s Oxlint for Effect diagnostics, and builds
standalone CLI binaries under `.build/bin`. It does not patch the Pi runtime.
The binaries are generated for the current platform and are not committed.

Keep the direct `typebox` dependency aligned with Pi's exact version.
Tool-schema validation shares types with Pi; independently upgrading TypeBox can
make those types incompatible.

Pi automatically discovers the extensions, skills, prompts, and themes under
`~/.pi/agent`. No `pi install` commands are needed for this setup.

Native MCP is opt-in; this setup configures no servers. Use `pi mcp add -l` from
a repository to add a project server to `.pi/mcp.json`, then inspect it with
`/mcp`. Keep existing CLIs unless a server adds useful capabilities. Do not
install `pi-mcp-adapter` alongside native MCP: it replaces Pi's session
implementation, while shell-level `pi mcp` commands still use native MCP.

Codemode can batch, chain, and filter tool results without MCP. Direct tools
remain available for simple calls. Scripts call the registered tools, including
the local `bash` override; they do not replace `bg_start` or its completion
notifications. Earlier tool side effects are not undone if a script fails.

Skills live in this repository under `agent/skills`. To share them with tools
that read `~/.agents/skills`, create a symlink:

```bash
mkdir -p ~/.agents
ln -s ../.pi/agent/skills ~/.agents/skills
```

If `~/.agents/skills` already exists, merge any skills you want to keep into
`agent/skills`, then move the original directory aside before creating the link.

## Installed components

The inventories below are checked against tracked and untracked, non-ignored
setup files by `agent/scripts/verify-docs.ts`.

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for
  session-owned processes, plus `emit-to-pi` notifications
- `gpt-fast-mode`: `/fast` and `Ctrl-Alt-M` for supported OpenAI API and Codex
  models
- `herdr-agent-state`: Herdr pane state and Pi session reporting, with idle
  reconciliation independent of background processes
- `process-status`: `/ps` views for background terminals and the `session_usage`
  tool
- `prompt-context`: Restores active-tool snippets and guidelines in custom
  system prompts
- `sacrifice-preference`: Marks spawned work as the preferred target under Linux
  memory pressure
- `session-timer`: Branch duration from the first user message, with persistent
  clock footers on new text responses
- `skill-visibility`: `/skill-visibility` controls which loaded skills the model
  can discover
- `tps-tracker`: Live and final output-token throughput
- `ui-moto`: Compact model and project status header

`agent/extensions/herdr-agent-state.ts` is locally patched. Herdr integration
updates overwrite it; restore the repository version and run `/reload` in
affected Pi sessions after updating Herdr's integration.

The `prompt-context` extension adds active-tool snippets and guidelines to
custom system prompts as a structured section. Pi's project context, skills,
appended instructions, and other extension sections remain intact, including MCP
summaries added afterward. Stock system prompts remain unchanged. Excluded tools
contribute no injected guidance. Context refreshes at `before_agent_start`; tool
changes during an active run appear in the next run's injected context.
Extensions that force a complete system prompt override structured sections. Run
`/reload` in existing sessions to load the extension changes and enable
codemode.

Use `bash` by default. Use `bg_start` for services and watchers, explicitly
requested subagent work, or finite commands alongside useful independent work. A
finite command's natural exit wakes the owner with its actual exit status,
including success. Use `emit-to-pi` only for actionable events while a command
keeps running. A notification never settles the command.

Use `bg_status` for immediate inspection, not polling. Its bounded observations
distinguish the first read, changed state/output, and unchanged evidence;
elapsed time alone is not a change. Completion and `emit-to-pi` events wake the
owner. If the requested answer depends on a job and nothing independent remains,
give only a brief pending status and end the turn; deliver the answer after
completion. Do not repeat the background task while waiting. Completion messages
show status and output within a shared 24 KiB output budget; abbreviation is
marked, and `bg_status` exposes more retained output. Full commands and working
directories remain in `/ps` details. Use `bg_kill` to terminate a command. Full
logs still require explicit redirection.

### Installed skills

The installed Matt Pocock skills and their supporting files are vendored from
[`mattpocock/skills` at `3cca18b`](https://github.com/mattpocock/skills/tree/3cca18b368ae95cdbdebbff572ccafa662551015/skills).
The `tdd` and `implement` skills are locally adapted to align test selection and
verification with this setup's system prompt.

- `babysit-pr`
- `background-terminals`
- `code-review`
- `codebase-design`
- `create-verification-skill`
- `diagnosing-bugs`
- `docs-search`
- `domain-modeling`
- `dumpfile`
- `frontend-design`
- `grill-me`
- `grill-with-docs`
- `grilling`
- `implement`
- `improve-codebase-architecture`
- `mailbox`
- `maintain-verification-skill`
- `pi-harness`
- `principle-migrate-callers-then-delete-legacy-apis`
- `prototype`
- `research`
- `resolving-merge-conflicts`
- `subagents`
- `tdd`
- `to-spec`
- `to-tickets`
- `typescript-best-practices`
- `unslop`
- `web-search`
- `wizard`
- `writing-for-agents`
- `writing-good-commits`
- `writing-good-prs`
- `writing-good-tickets`

### Installed CLI tools

- [`dumpfile`](cli/dumpfile/README.md) publishes screenshots, recordings, and
  other review evidence to immutable public R2 URLs with opt-in provisioning of
  30-day object-age retention. Links are not permanent; deletion is
  asynchronous. Run `./cli/dumpfile/setup.sh` once to provision Cloudflare and
  install the command.

### Installed prompts

- `deslop`
- `handoff`
- `wait-what`

### Installed themes

- `catppuccin-mocha`
- `gruvbox-dark-hard`

## Shortcuts

Custom keybindings:

- `Ctrl-P` / `Ctrl-N` — move through selectors
- `Alt-P` — cycle enabled models
- `Ctrl-Alt-M` — toggle GPT Fast mode

## Repository layout

```text
agent/
├── SYSTEM.md          # active system prompt
├── settings.json      # models, thinking level, and theme
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # reusable agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
cli/
└── dumpfile/          # R2 upload CLI, signer Worker, tests, and setup wizard
```

Runtime state and secrets such as `auth.json`, sessions, API configuration, run
history, and trusted local paths are ignored. Do not commit them.
[`agent/trust.example.json`](agent/trust.example.json) documents the trust-file
shape without including machine-specific paths.

## Development

Use `vp` for dependency management and scripts. Bun is the package manager; Node
runs the existing test suites directly from TypeScript.

```bash
vp install
vp run verify
```

`verify` and CI run credential-free formatting, lint, type,
diagnostic-enforcement, and behavioral checks. The suites that exercise compiled
CLIs rebuild them first. Live Pi integration tests remain separate: with
provider credentials configured, run `vp run test:e2e`.

Use `vp check` for static checks, `vp check --fix` for supported fixes,
`vp lint` for linting, and `vp fmt` for formatting. Use `vp add`, `vp remove`,
and `vp update` for dependency changes. CI installs with
`vp install --frozen-lockfile`.

`vite.config.ts` owns formatting and lint policy. Vite+ supplies the only linter
and formatter: Oxlint and Oxfmt. Type-aware rules, Effect diagnostics, and the
vendored [anti-slop plugins](tools/oxlint/anti-slop/UPSTREAM.md) fail on
warnings. Native Node/test-runner and Cloudflare boundaries have scoped
Effect-native exceptions; type-safety and anti-slop rules remain enabled there.

Keep `@oxlint/plugins` compatible with the Oxlint version reported by
`vp toolchain`. Update Vite+ and `@effect/tsgo` together when their supported
versions change; do not install a second linter or formatter.

`vp run build:cli` compiles `emit-to-pi`, `babysit-pr`, and `dumpfile` with Bun.
Background terminals prepend `.build/bin` to their command search path. The
babysit-pr skill invokes its compiled binary directly. Source tests and
benchmarks remain TypeScript; no JavaScript source is maintained.

## License

MIT. See [`LICENSE`](LICENSE).
