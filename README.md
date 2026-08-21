# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi): a strict system prompt, local TypeScript extensions, model defaults, themes, keybindings, and a small set of reusable prompts.

This repository is meant to live at `~/.pi`. The extensions are vendored here and loaded directly by Pi; they are not separate packages to install.

## Defaults

- Primary model: `openai-codex/gpt-5.6-sol` with high thinking
- Additional model: `opencode-go/kimi-k3`
- Child-agent model: `openai-codex/gpt-5.6-sol`
- Theme: Catppuccin Mocha; Gruvbox Dark Hard is also included
- Dense handoff compaction at 85% context usage or 250k tokens, whichever comes first
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

`bun install` applies the repository's runtime patches to the local dependency and, when present, the active `pi` executable on `PATH`. Rerun it after updating Pi. Installation reports when no active Pi is available and still fails when the active version differs or a patched source file is missing.

Pi automatically discovers the extensions, skills, prompts, and themes under `~/.pi/agent`. No `pi install` commands are needed for this setup.

### Temporary quota recovery

When saving full command output fails with `EDQUOT`, Pi remains running and removes oldest temporary entries until it has freed the output observed at failure plus a 30% per-user quota reserve. It deletes disposable Pi output logs first. If those are insufficient, it deletes oldest user-owned top-level entries under `/tmp`, including unrelated checkouts or build trees. Paths visible through `/proc` as a working directory or open file of a live process are protected, and entries containing files owned by another user are skipped. The failed command must be retried because its complete output cannot be reconstructed after the write failure.

## Installed components

The inventories below are checked against git-tracked setup files by `agent/scripts/verify-docs.mjs`.

### Installed extensions

| Extension | What it adds |
| --- | --- |
| `aoauth` | OAuth support for configured providers |
| `background-terminals` | `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for session-owned processes |
| `codex-accounts` | Named Codex account selection |
| `compaction` | Dense handoffs and automatic continuation after proactive compaction |
| `delegate` | Blocking and background child-agent runs plus session inspection and control |
| `gpt-fast-mode` | `/fast` and `Ctrl-Alt-M` for supported OpenAI API and Codex models |
| `process-status` | `/ps` views for active work, worker tokens, and cost |
| `sacrifice-preference` | Model preference handling for sacrifice mode |
| `session-timer` | Per-run and cumulative session timing in the status bar |
| `skill-visibility` | `/skill-visibility` controls which loaded skills the model can discover |
| `tps-tracker` | Live and final output-token throughput |
| `ui-moto` | Compact model and project status header |

Delegation uses the parent model unless `delegate.model` is configured in [`agent/settings.json`](agent/settings.json). A project's `.pi/delegate.json` can override that default with `{"model":"provider/model-id"}`; lookup checks the run's effective `cwd`, then the parent session's project, so an external worktree does not discard the session's choice. An explicit `delegate_run.model` overrides every file. Invalid, unavailable, or unauthenticated configured models fall back to the parent model, while an invalid explicit override fails the run. Every run has one hard ceiling of 60 minutes or 60,000,000 reported tokens, regardless of effort; a run that settles abnormally hands back the child's last messages so it can be re-briefed. Delegate runs have no aggregate concurrency or retention limit: each starts immediately and remains inspectable until the parent session ends. Children share the same worktree without write isolation unless `cwd` points them at one the caller prepared, so parallel mutations can otherwise conflict. A child's background terminals are its own: they never appear in the parent's list and are terminated when the child settles.

### Installed skills

- `create-verification-skill`
- `maintain-verification-skill`
- `using-subagents`

### Installed prompts

- `beautify-dirty-worktree`
- `coderabbit`
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
├── SYSTEM.md          # agent behavior contract
├── settings.json      # models, thinking level, theme, and delegate model
├── keybindings.json
├── extensions/        # local tools, commands, and UI extensions
├── skills/            # reusable agent workflows and references
├── prompts/           # prompt templates
└── themes/            # Catppuccin and Gruvbox themes
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
