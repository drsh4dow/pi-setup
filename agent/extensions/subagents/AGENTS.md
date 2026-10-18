# subagents

A TLA+ model checks that no process of a subagent run outlives its launcher. It cites lines in this directory. After a change here, run `.agents/skills/verify-subagent-run/scripts/check` from the checkout root, and follow [`verify-subagent-run`](../../../.agents/skills/verify-subagent-run/SKILL.md) when it fails or when the change adds, removes, or reorders a step of a run.
