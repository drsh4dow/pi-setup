# Pi setup

My global configuration for [Pi](https://github.com/earendil-works/pi). It
lives at `~/.pi`. Pi discovers everything under `~/.pi/agent` on its own.

[`agent/SYSTEM.md`](agent/SYSTEM.md) replaces Pi's system prompt. It holds a
short preface and the rules for choosing and combining tools. The
`prompt-context` extension adds back the tool descriptions that Pi drops when
a custom prompt replaces its own.

## Install

Install [Vite+](https://viteplus.dev/guide/), then run:

```bash
git clone https://github.com/drsh4dow/pi-setup.git ~/.pi
cd ~/.pi
vp install
vp install -g @earendil-works/pi-coding-agent
pi
```

`vp install` builds `pi-subagent` and `emit-to-pi` into `.build/bin` and
copies `agent/default.settings.json` to `agent/settings.json` when that file
does not exist. Use `/login` inside Pi to authenticate model providers. Set
`PERPLEXITY_API_KEY` and `EXA_API_KEY` for the `web-search` extension.

## What's included

`agent/scripts/verify-docs.ts` checks these lists against the files.

### Installed extensions

- `background-terminals`: `bg_start`, `bg_status`, `bg_list`, and `bg_kill`
- `build-bin-path`: puts `.build/bin` on the `PATH` of every command
- `delegate-guard`: stops a delegate subagent from launching subagents
- `fast-mode`: `/fast` and `Ctrl-Alt-M` toggle Fast mode
- `herdr-agent-state`: Herdr pane state, with local patches
- `herdr-bg-indicator`: the `$bg` Herdr pane token
- `process-status`: `/ps` and the `session_usage` tool
- `prompt-context`: restores tool descriptions under a custom system prompt
- `sacrifice-preference`: makes earlyoom kill spawned work before the session
- `session-timer`: branch duration and response clocks
- `skill-visibility`: `/skill-visibility`
- `subagents`: the `pi-subagent` launcher
- `tps-tracker`: output-token throughput
- `ui-moto`: the model and project header
- `web-search`: the Perplexity and Exa MCP servers

### Installed skills

- `background-terminals`
- `docs-search`
- `pi-harness`
- `subagents`
- `web-search`

### Installed themes

- `catppuccin-mocha`
- `gruvbox-dark-hard`

## Development

```bash
vp install
vp run verify
```

`verify` runs formatting, lint, type checks, and the extension tests. Run
`vp run test:e2e` after you upgrade Pi. It needs provider credentials. The
TLA+ models under `.agents/skills/verify-subagent-run/` and
`.agents/skills/verify-terminal-delivery/` check the `subagents` and
`background-terminals` extensions.

## License

MIT. See [`LICENSE`](LICENSE).
