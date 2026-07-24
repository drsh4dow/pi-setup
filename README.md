# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi): a strict system prompt, local TypeScript extensions, model defaults, themes, keybindings, and a small set of reusable prompts.

This repository is meant to live at `~/.pi`. The extensions are vendored here and loaded directly by Pi; they are not separate packages to install.

## Defaults

- Primary model: `openai-codex/gpt-5.6-sol` with high thinking
- Additional model: `opencode-go/kimi-k3`
- Child-agent model: `openai-codex/gpt-5.6-sol`
- Theme: Catppuccin Mocha; Gruvbox Dark Hard is also included
- Automatic context compaction enabled
- GPT Fast mode enabled

The agent's behavior and engineering standards are defined in [`agent/SYSTEM.md`](agent/SYSTEM.md). In short: act autonomously, investigate before editing, prefer simple and deep designs, verify before claiming success, and preserve user-owned work.

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

Pi automatically discovers the extensions, prompts, and themes under `~/.pi/agent`. No `pi install` commands are needed for this setup.

## Included tools and extensions

| Extension | What it adds |
| --- | --- |
| `questions` | `ask_questions`, an interactive questionnaire with predefined or free-form answers |
| `delegate` | `delegate_run` for one new child, `delegate_session` for existing children, and `delegate_workflow` for two or more predetermined tasks |
| `background-terminals` | `bg_start`, `bg_status`, `bg_list`, and `bg_kill` for up to eight running and 32 tracked session-scoped processes |
| `process-status` | `/ps` lists active work (Ctrl+O shows all tracked entries); `/ps <id>` shows a bounded detail snapshot with recent activity |
| `web-access` | `web_search`, `fetch_content`, and `get_search_content` for Exa search, pages and PDFs, GitHub repositories, and video analysis |
| `gpt-fast-mode` | `/fast` and `Ctrl-Alt-M` to toggle OpenAI's priority service tier for supported GPT models |
| `shake-images` | `/shake-images` to retain only the newest two images in model context for the current session |
| `skill-visibility` | `/skill-visibility` to choose which loaded skills are discoverable by the model |
| `session-timer` | Per-run and cumulative session timing in the status bar |
| `tps-tracker` | Live and final output-token throughput |
| `ui-moto` | A compact model and project header |

Delegation uses the parent model unless `delegate.model` is configured in [`agent/settings.json`](agent/settings.json). Invalid, unavailable, or unauthenticated child models fall back to the parent model.

## Web access

Set credentials in the environment before starting Pi:

```bash
export EXA_API_KEY="..."       # web search and ordinary URL/PDF extraction
export GEMINI_API_KEY="..."    # YouTube and local-video analysis
```

GitHub access works without Exa. `git` enables shallow public-repository clones, while an authenticated `gh` CLI adds private-repository access. Video frame extraction can also use `ffmpeg`, `ffprobe`, and `yt-dlp` when installed.

See [`agent/extensions/web-access/README.md`](agent/extensions/web-access/README.md) for limits and implementation details.

## Prompts and shortcuts

Prompt templates:

- `/beautify-dirty-worktree` — audit uncommitted code for simpler, more native structure without changing behavior
- `/handoff [focus]` — write a redacted handoff document to the operating system's temporary directory

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

`verify` runs TypeScript type checking, Effect diagnostics, Biome, delegate, background-terminal, and web-access tests. GitHub Actions runs the same command on pushes and pull requests. Live web-access smoke tests are opt-in:

```bash
PI_WEB_ACCESS_LIVE=1 node --test agent/extensions/web-access/test/live.test.ts
```

## License

MIT. See [`LICENSE`](LICENSE).
