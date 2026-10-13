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

When the scope is large or has unknowns, I reach for grilling. It is usually one
closed run in a single session:

1. `/skill:grill-with-docs` interviews me until every decision is settled and
   records ADRs and glossary terms along the way. I use `/skill:grill-me` only
   when the session should leave no artifacts and I just want to untangle my
   own thinking.
2. `/skill:to-spec` publishes the settled design as a spec issue. The grilling
   is its input, so nothing is rewound in between.
3. `/skill:to-tickets <spec issue>` breaks the spec into tracer-bullet tickets,
   filed as sub-issues of the spec with blocking edges between them.

Then `/skill:implement-spec <spec issue>` works through the ticket graph. Each
ready ticket gets an implementer subagent, every ticket lands on one integration
branch, and a `code-review` pass closes the work.

The spec and ticket skills read each repository's issue tracker configuration.
Run `/skill:setup-matt-pocock-skills` once per repository to create it.

## Defaults

- Model: `anthropic/claude-opus-5-5` with high thinking and Fast mode on.
- `Alt-P` cycles the enabled models: `anthropic/claude-opus-5-5`,
  `anthropic/claude-fable-5-1`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`,
  and `opencode-go/glm-5.3-flash`.
- Subagents run `claude-opus-5-5` for implementation and design, and
  `gpt-6.1-sol` for research and review.
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
- `process-status`: `/ps` views of background terminals and the `session_usage`
  tool
- `prompt-context`: restores active-tool snippets and guidelines, which Pi
  omits when a custom system prompt replaces its own
- `sacrifice-preference`: marks spawned work as the preferred target under Linux
  memory pressure
- `session-timer`: branch duration since the first user message, with clock
  footers on responses
- `skill-visibility`: `/skill-visibility` controls which loaded skills the model
  can discover
- `tps-tracker`: live and final output-token throughput
- `ui-moto`: compact model and project status header

`agent/extensions/herdr-agent-state.ts` carries local patches. Updating Herdr's
integration overwrites it, so restore the repository version afterwards and run
`/reload` in affected sessions.

### Installed skills

The Matt Pocock skills and their supporting files are vendored from
[`mattpocock/skills` at `6fd9479`](https://github.com/mattpocock/skills/tree/6fd947921b935b7e1e69293a200400f0fdd5c15f/skills).

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
- `implement-spec`
- `improve-codebase-architecture`
- `mailbox`
- `maintain-verification-skill`
- `pi-harness`
- `pr`
- `principle-migrate-callers-then-delete-legacy-apis`
- `prototype`
- `research`
- `retro`
- `setup-matt-pocock-skills`
- `subagents`
- `tdd`
- `teach`
- `to-spec`
- `to-tickets`
- `typescript-best-practices`
- `web-search`
- `wizard`
- `writing-for-agents`
- `writing-good-commits`
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

## Repository layout

```text
agent/
├── SYSTEM.md          # system prompt
├── settings.json      # models, thinking level, compaction, and theme
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
cli/
└── dumpfile/          # R2 upload CLI, signer Worker, tests, and setup wizard
docs/
└── agents/            # issue tracker, triage, and domain conventions
tools/
└── oxlint/            # vendored anti-slop lint plugins
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
the vendored [anti-slop plugins](tools/oxlint/anti-slop/UPSTREAM.md) fail on
warnings.

Keep these versions aligned when upgrading:

- `typebox` matches Pi's exact version, because tool schemas share types with
  Pi.
- `@oxlint/plugins` stays compatible with the Oxlint version that
  `vp toolchain` reports.
- Vite+ and `@effect/tsgo` move together.

`vp run build:cli` compiles `emit-to-pi`, `babysit-pr`, and `dumpfile` with Bun.
Background terminals put `.build/bin` on their command search path.

## License

MIT. See [`LICENSE`](LICENSE).
