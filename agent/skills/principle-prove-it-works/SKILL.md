---
name: principle-prove-it-works
description: "Apply after completing a task, before declaring it done."
disable-model-invocation: false
user-invokable: false
---

# Prove It Works

Verify every task output by checking the real thing directly. Do not infer from proxies, self-reports, or "it compiles."

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output freshness, agent self-reports, cached screenshots) feels cheaper than direct observation. Acting on a wrong inference costs far more than checking the source.

Check the real thing, not a proxy:
- Check process liveness directly, not indirectly through derived state
- Read the actual value, not a cached or derived representation
- When verification fails, suspect the observation method before suspecting the system

## Script the check a reviewer must rerun

A check a reviewer must rerun is a lever: build and commit it per [Build the Lever](../principle-build-the-lever/SKILL.md).
