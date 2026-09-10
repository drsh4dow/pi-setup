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

Pi loads [`agent/SYSTEM.md`](agent/SYSTEM.md) as this setup's active system prompt. It defines the agent's behavior and engineering standards.

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
| `background-terminals` | `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for session-owned processes, plus `emit-to-pi` notifications |
| `codex-accounts` | Labeled Codex logins, weekly-allowance selection, session account pins, and `/codex-usage` |
| `edit-feedback` | Bounded line-numbered context and recovery hints for rejected edits |
| `gpt-fast-mode` | `/fast` and `Ctrl-Alt-M` for supported OpenAI API and Codex models |
| `herdr-agent-state` | Herdr pane state and Pi session reporting, with idle reconciliation independent of background processes |
| `process-status` | `/ps` views for background terminals and session token/cost accounting |
| `prompt-context` | Restores active-tool snippets and guidelines in custom system prompts |
| `sacrifice-preference` | Marks spawned work as the preferred target under Linux memory pressure |
| `session-timer` | Per-run and cumulative session timing in the status bar |
| `skill-visibility` | `/skill-visibility` controls which loaded skills the model can discover |
| `tps-tracker` | Live and final output-token throughput |
| `ui-moto` | Compact model and project status header |

[Codex account setup](agent/extensions/codex-accounts/README.md) enables multiple ChatGPT logins behind `openai-codex`. Each new session selects the account with the most weekly allowance and keeps it across model changes and resume. Without account configuration, the existing Codex login continues working.

`agent/extensions/herdr-agent-state.ts` is locally patched. Herdr integration updates overwrite it; restore the repository version and run `/reload` in affected Pi sessions after updating Herdr's integration.

The `prompt-context` extension supplements custom system prompts with active-tool snippets and guidelines from Pi's resolved prompt inputs. It preserves Pi's project context, skills, appended instructions, and earlier extension changes. Stock system prompts remain unchanged. Excluded tools contribute no injected guidance. Context refreshes at `before_agent_start`; tool changes during an active run appear in the next run's injected context. Reload existing sessions with `/reload` after installing it.

Use `bash` by default. Use `bg_start` for services and watchers. Use it for finite commands when there is useful independent work to do. A finite command's natural exit wakes the owner with its actual exit status, including success. Use `emit-to-pi` only for actionable events while a command keeps running. A notification never settles the command.

Use `bg_status` for immediate inspection, not polling. Its bounded observations distinguish the first read, changed state/output, and unchanged evidence; elapsed time alone is not a change. Completion and `emit-to-pi` events wake the owner. When no useful independent work remains, answer the user. Use `bg_kill` to terminate a command. Full logs still require explicit redirection.

The `edit-feedback` extension preserves Pi's built-in matching, batch atomicity, and cancellation. Rejected edits include bounded candidate line locations and recovery guidance from the original file. These are navigation hints, never permission to apply an ambiguous replacement.

### Installed skills

- `babysit-pr`
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
- `implement`
- `implement-spec`
- `improve-codebase-architecture`
- `maintain-verification-skill`
- `principle-attack-the-premise`
- `principle-boundary-discipline`
- `principle-build-the-lever`
- `principle-encode-lessons-in-structure`
- `principle-exhaust-the-design-space`
- `principle-experience-first`
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
- `prototype`
- `research`
- `resolving-merge-conflicts`
- `show-me`
- `tdd`
- `to-spec`
- `to-tickets`
- `typescript-best-practices`
- `unslop`
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
