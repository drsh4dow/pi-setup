# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi): a strict system prompt, local TypeScript extensions, model defaults, themes, keybindings, and a small set of reusable prompts.

This repository is meant to live at `~/.pi`. The extensions are vendored here and loaded directly by Pi; they are not separate packages to install.

## Defaults

- Primary model: `openai-codex/gpt-5.6-sol` with high thinking
- Additional model: `opencode-go/kimi-k3`
- Child-agent model: `openai-codex/gpt-5.6-sol`
- Theme: Catppuccin Mocha; Gruvbox Dark Hard is also included
- Pi's built-in compaction with default settings
- GPT Fast mode enabled

Pi loads [`agent/APPEND_SYSTEM.md`](agent/APPEND_SYSTEM.md) as this setup's active system-prompt addition. It defines the agent's behavior and engineering standards.

## Install

Requires Node.js 22.19 or newer and [Bun](https://bun.sh). Install Pi and clone this repository into its global configuration directory:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
git clone https://github.com/drsh4dow/pi-setup.git ~/.pi
cd ~/.pi
bun install
pi
```

Use `/login` inside Pi to authenticate model providers. If `~/.pi` already exists, move or merge it before cloning.

`bun install` installs extension dependencies and enables Effect's TypeScript diagnostics. It does not patch the Pi runtime.

Pi automatically discovers the extensions, skills, prompts, and themes under `~/.pi/agent`. No `pi install` commands are needed for this setup.

Skills live in this repository under `agent/skills`. To share them with tools that read `~/.agents/skills`, create a symlink:

```bash
mkdir -p ~/.agents
ln -s ../.pi/agent/skills ~/.agents/skills
```

If `~/.agents/skills` already exists, merge any skills you want to keep into `agent/skills`, then move the original directory aside before creating the link.

## Installed components

The inventories below are checked against git-tracked setup files by `agent/scripts/verify-docs.mjs`.

### Installed extensions

| Extension | What it adds |
| --- | --- |
| `aoauth` | Anthropic OAuth login support |
| `delegate` | Blocking and background child-agent runs plus session inspection and control |
| `edit-feedback` | Bounded line-numbered context and recovery hints for rejected edits |
| `gpt-fast-mode` | `/fast` and `Ctrl-Alt-M` for supported OpenAI API and Codex models |
| `herdr-agent-state` | Herdr pane state and Pi session reporting, with idle reconciliation independent of background processes |
| `process-status` | `/ps` views for active work, worker tokens, and cost |
| `sacrifice-preference` | Marks spawned work as the preferred target under Linux memory pressure |
| `session-timer` | Per-run and cumulative session timing in the status bar |
| `skill-visibility` | `/skill-visibility` controls which loaded skills the model can discover |
| `tps-tracker` | Live and final output-token throughput |
| `ui-moto` | Compact model and project status header |

`agent/extensions/herdr-agent-state.ts` is locally patched. Herdr integration updates overwrite it; restore the repository version and run `/reload` in affected Pi sessions after updating Herdr's integration.

Delegation selects a model and reasoning profile from `delegate.fast` or `delegate.thorough` in [`agent/settings.json`](agent/settings.json). Each accepts `model` and `thinking`, for example `{"fast":{"model":"openai-codex/gpt-5.6-luna","thinking":"high"},"thorough":{"model":"openai-codex/gpt-6-astra","thinking":"low"}}`. Thinking accepts Pi's levels from `off` through `max`. Missing fields inherit from the next configuration source. Legacy `delegate.model` and `delegate.thinking` apply to both profiles, with profile-specific fields taking precedence within a file. Without configuration, delegates use the parent model and low reasoning for fast or high for thorough. A project's `.pi/delegate.json` can override that default with `{"model":"provider/model-id"}`; lookup checks the run's effective `cwd`, then the parent session's project, so an external worktree does not discard the session's choice. Project files also accept `fast` and `thorough` profiles. An explicit `delegate_run.model` overrides every file's model, retaining the selected profile's reasoning. Invalid, unavailable, or unauthenticated configured models fall back to the parent model, while an invalid explicit override fails the run. Every run has one hard ceiling of 60 minutes or 60,000,000 reported tokens, regardless of effort; a run that settles abnormally hands back the child's last messages so it can be re-briefed. Delegate runs have no aggregate concurrency or retention limit: each starts immediately and remains inspectable until the parent session ends. Children share the same worktree without write isolation unless `cwd` points them at one the caller prepared, so parallel mutations can otherwise conflict.

Children use normal Pi prompt discovery and the applicable `APPEND_SYSTEM.md`, plus a short [child role](agent/extensions/delegate/SYSTEM.md). A project's `.pi/DELEGATE_SYSTEM.md` still replaces the child's base prompt; the shared append policy and child role remain appended.

`delegate_session` with `action: "wait"` defaults to `mode: "all"`. Use `mode: "next"` to return one settled result without waiting for the others. Remove returned ids before waiting again. Unreturned children retain their background completion notifications; cancelling a wait leaves them running.

A delegate stays running through Pi's built-in automatic compaction and retries until its session settles.

The `edit-feedback` extension preserves Pi's built-in matching, batch atomicity, and cancellation. Rejected edits include bounded candidate line locations and recovery guidance from the original file. These are navigation hints, never permission to apply an ambiguous replacement.

### Installed skills

- `agent-browser`
- `blast-radius`
- `code-review`
- `codebase-design`
- `create-verification-skill`
- `diagnosing-bugs`
- `docs-search`
- `domain-modeling`
- `dumpfile`
- `grill-me`
- `grill-with-docs`
- `grilling`
- `how`
- `improve-codebase-architecture`
- `maintain-verification-skill`
- `prototype`
- `research`
- `resolving-merge-conflicts`
- `show-me`
- `tdd`
- `unslop`
- `using-subagents`
- `web-search`
- `why`
- `wizard`
- `writing-for-agents`
- `writing-good-prs`
- `writing-good-tickets`

### Installed CLI tools

- [`dumpfile`](cli/dumpfile/README.md) publishes screenshots, recordings, and other review evidence to immutable public R2 URLs with opt-in provisioning of 30-day object-age retention. Links are not permanent; deletion is asynchronous. Run `./cli/dumpfile/setup.sh` once to provision Cloudflare and install the command.

### Installed prompts

- `beautify-dirty-worktree`
- `handoff`
- `implement-orchestrator`

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
├── APPEND_SYSTEM.md   # active system-prompt addition
├── settings.json      # models, thinking level, theme, and delegate model
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # reusable agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
cli/
└── dumpfile/          # R2 upload CLI, signer Worker, tests, and setup wizard
```

Runtime state and secrets such as `auth.json`, sessions, API configuration, run history, and trusted local paths are ignored. Do not commit them. [`agent/trust.example.json`](agent/trust.example.json) documents the trust-file shape without including machine-specific paths.

## Development

Requires Bun. Install the pinned dependencies and run the complete check suite:

```bash
bun install
bun run verify
```

`verify` and GitHub Actions run credential-free type checks, diagnostics, formatting checks, and behavioral tests. They exclude the live Pi integration tests. Run those separately, with configured provider credentials, using `bun run test:e2e`.

## License

MIT. See [`LICENSE`](LICENSE).
