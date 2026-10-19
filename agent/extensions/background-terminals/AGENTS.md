# background-terminals

A TLA+ model checks that a terminal's end and its notifications reach the model of the session that started it. It cites lines in `delivery.ts`, `manager.ts`, `session.ts`, and `index.ts`, and `vp run verify` fails when a cited line changes. After a change to those files, run `.agents/skills/verify-terminal-delivery/scripts/check` from the checkout root, and follow [`verify-terminal-delivery`](../../../.agents/skills/verify-terminal-delivery/SKILL.md) when it fails or when the change adds, removes, or reorders a delivery step.
