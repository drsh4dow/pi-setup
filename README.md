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
| `aoauth` | Anthropic OAuth login support |
| `background-terminals` | `bg_start`, `bg_status`, `bg_wait`, `bg_list`, and `bg_kill` for session-owned processes, plus `emit-to-pi` notifications |
| `codex-accounts` | Named Codex account selection |
| `compaction` | Dense handoffs and automatic continuation after proactive compaction |
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

Delegation uses the parent model unless `delegate.model` is configured in [`agent/settings.json`](agent/settings.json). A project's `.pi/delegate.json` can override that default with `{"model":"provider/model-id"}`; lookup checks the run's effective `cwd`, then the parent session's project, so an external worktree does not discard the session's choice. An explicit `delegate_run.model` overrides every file. Invalid, unavailable, or unauthenticated configured models fall back to the parent model, while an invalid explicit override fails the run. Every run has one hard ceiling of 60 minutes or 60,000,000 reported tokens, regardless of effort; a run that settles abnormally hands back the child's last messages so it can be re-briefed. Delegate runs have no aggregate concurrency or retention limit: each starts immediately and remains inspectable until the parent session ends. Children share the same worktree without write isolation unless `cwd` points them at one the caller prepared, so parallel mutations can otherwise conflict. A child's background terminals are its own: they never appear in the parent's list and are terminated when the child settles.

A delegate stays running through its handoff, compaction, and requested continuation. The internal handoff is not a completed task result. A failed boundary compaction reports an error rather than a successful handoff.

Use `bg_status` for immediate inspection. Its bounded observations distinguish the first read, changed state/output, and unchanged evidence; elapsed time alone is not a change. When blocked on a command, use `bg_wait` with its ID instead of polling or sleeping. It returns the settled result immediately if already available. Cancelling the wait leaves the command running; `bg_kill` terminates it. A successful wait consumes the completion notice so it is not delivered again. Full logs still require explicit redirection.

The `edit-feedback` extension preserves Pi's built-in matching, batch atomicity, and cancellation. Rejected edits include bounded candidate line locations and recovery guidance from the original file. These are navigation hints, never permission to apply an ambiguous replacement.

### Installed skills

- `babysit-pr`
- `create-verification-skill`
- `docs-search`
- `dumpfile`
- `maintain-verification-skill`
- `using-subagents`
- `web-search`
- `writing-good-prs`
- `writing-good-tickets`

### Installed CLI tools

- [`dumpfile`](cli/dumpfile/README.md) publishes screenshots, recordings, and other review evidence to immutable public R2 URLs. Run `./cli/dumpfile/setup.sh` once to provision Cloudflare and install the command.

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
