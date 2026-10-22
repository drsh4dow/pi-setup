# pi-setup

Global Pi configuration, checked out at `~/.pi`. TypeScript extensions on
Effect 4, with Bun and Vite+ for tooling.

Every decision in this repository should improve the agent's experience of
the harness.

## Where to look

| Task            | Location                                                              |
| --------------- | --------------------------------------------------------------------- |
| System prompt   | `agent/SYSTEM.md`                                                     |
| Shared settings | `agent/default.settings.json`                                         |
| Extension       | `agent/extensions/<name>/index.ts` or `agent/extensions/<name>.ts`    |
| Skill           | `agent/skills/<name>/SKILL.md`                                        |
| Effect API      | `node_modules/effect/AGENTS.md`, then `ai-docs/` and `src/` beside it |
| Pi API          | the `pi-harness` skill                                                |
| Checks          | `vite.config.ts`                                                      |

## Rules

- Use `vp` for packages and scripts. Run `vp run verify` before you report a
  change.
- `agent/settings.json` and the runtime state under `agent/` are local and
  ignored. Never commit them.
- Issues live in `drsh4dow/pi-setup` on GitHub. Use the `gh` CLI.
