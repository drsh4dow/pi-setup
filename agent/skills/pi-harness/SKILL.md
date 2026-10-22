---
name: pi-harness
description: Read before modifying, building on, or answering questions about the pi harness or its @earendil-works libraries (pi-ai, pi-durable, pi-mcp, pi-codemode, chord).
disable-model-invocation: false
user-invokable: false
---

# Pi harness

Locate the root of the running pi installation, `<pi>`:

```sh
d=$(readlink -f "${PI_PACKAGE_DIR:-$(command -v pi)}"); while [ "${d:-/}" != / ] && ! grep -Eqs '"name": *"@earendil-works/pi-coding-agent"' "$d/package.json"; do d=$(dirname "$d"); done; echo "${d:-/}"
```

Pi documentation:

- Main documentation: `<pi>/README.md`
- Additional docs: `<pi>/docs`
- Examples: `<pi>/examples` (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... and examples/... under `<pi>`, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
- The @earendil-works libraries live beside pi in `<pi>/..`, each with a README.md and dist/*.d.ts; files their npm packages omit live in the earendil-works/pi GitHub repository under packages/<name>/
