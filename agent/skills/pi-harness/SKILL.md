---
name: pi-harness
description: Read before modifying or answering questions about the pi harness.
---

# Pi harness

Use the installed Pi documentation and examples to establish supported
behavior and APIs before answering or implementing.

## Locate the documentation

The current installation root is:
`/home/drsh4dow/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`

Under that root:

- `README.md` is the main documentation.
- `docs/` contains topic-specific documentation.
- `examples/` contains extensions, custom tools, and SDK examples.

Resolve `docs/...` and `examples/...` references against this installation
root, not the working directory. If the installation moves, locate the
package behind the active `pi` executable.

Prefer installed documentation for the running version. When targeting
another version, use its matching documentation and source.

## Read the relevant material

| Topic | Documentation and examples |
| --- | --- |
| General usage and configuration | `README.md` |
| Extensions and custom tools | `docs/extensions.md`, `examples/extensions/` |
| Themes | `docs/themes.md` |
| Skills | `docs/skills.md` |
| Prompt templates | `docs/prompt-templates.md` |
| TUI components | `docs/tui.md` |
| Keybindings | `docs/keybindings.md` |
| SDK integrations | `docs/sdk.md`, `examples/` |
| Custom providers | `docs/custom-provider.md` |
| Adding models | `docs/models.md` |
| Pi packages | `docs/packages.md` |
| Environment variables | `docs/environment-variables.md` |
| MCP servers | `docs/mcp.md` |
| Codemode, classifiers, and image models | `docs/codemode.md` |

Read each relevant Markdown file completely, continuing past truncated
tool output. Follow cross-references to related documentation needed for
the task, such as `tui.md` when implementing extension UI.

Before implementing, inspect the relevant examples and use Pi's documented
mechanisms. If the documentation leaves consequential behavior unclear,
inspect the matching source before assuming an API or adding a workaround.
