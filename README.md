# Pi

Personal dotfiles for [Pi](https://github.com/earendil-works/pi). Opinionated, public-safe config for people who want my defaults without my local secrets.

- Engine: `openai-codex/gpt-5.5`, high thinking.
- Taste: *suckless*, *A Philosophy of Software Design*, *The Pragmatic Programmer*.
- Human owns direction. Agent owns evidence.

Behavior contract: [`agent/SYSTEM.md`](agent/SYSTEM.md).

## Install

```bash
git clone https://github.com/drsh4dow/.pi ~/.pi
npm i -g @earendil-works/pi-coding-agent
pi install npm:pi-questions
pi install npm:pi-delegate
pi install npm:pi-web-minimal
pi install npm:pi-notify
npm i -g agent-browser && agent-browser install  # optional, for the agent-browser skill
```

Local-only files are ignored. Copy examples when you need them:

```bash
cp ~/.pi/web-search.example.json ~/.pi/web-search.json
cp ~/.pi/agent/trust.example.json ~/.pi/agent/trust.json
```

Never commit real API keys, auth files, run history, telemetry, or trusted local paths.

## Validate changes

```bash
bun install
bun run verify
```

Installation patches TypeScript-Go with the Effect language service. CI runs the same typecheck, Effect diagnostics, Biome check, and web-access tests.

## Loop

1. `/do-plan <task>` — read-only. Explores, researches, interviews, emits a plan.
2. Approve or revise. To deepen the plan, run `/skill:grill-with-docs`.
3. `/do-work proceed with the plan` — small slices, each verified before claiming done.
4. Review diff + evidence. Commit only on accept.

## Prompts ([`agent/prompts/`](agent/prompts))

Prompts are for deterministic triggers. Skills are injected into context, so they are better for behavior that must trigger automatically.

## Extensions

- `pi-questions` — `ask_questions` TUI.
- `pi-delegate` — `delegate` to isolated child sessions. The only subagent primitive. Set its model globally in `~/.pi/agent/settings.json`; unavailable or invalid models fall back to the parent model:
  ```json
  { "delegate": { "model": "provider/model-id" } }
  ```
- `pi-web-minimal` — web, code, docs, URL, and GitHub retrieval.
- `pi-notify` — desktop notifications.

## Web search setup

`pi-web-minimal` reads `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "...",
  "context7ApiKey": "..."
}
```

Environment alternatives:

- `EXA_API_KEY`
- `CONTEXT7_API_KEY`

Tools exposed: `web_search`, `code_search`, `documentation_search`, `fetch_content`, `get_search_content`.

## License

MIT. See [`LICENSE`](LICENSE).
