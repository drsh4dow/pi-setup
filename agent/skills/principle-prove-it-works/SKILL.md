---
name: principle-prove-it-works
description: "Apply when choosing how to verify a change."
disable-model-invocation: false
user-invokable: false
---

# Prove It Works

The `<guardrails>` in the system prompt require checking the real thing before calling work done. This is the method.

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output freshness, agent self-reports, cached screenshots) feels cheaper than direct observation. Acting on a wrong inference costs far more than checking the source.

Check the real thing, not a proxy:
- Check process liveness directly, not indirectly through derived state
- Read the actual value, not a cached or derived representation
- When verification fails, suspect the observation method before suspecting the system

Keep the check honest:
- Give "could not run" its own exit code: `0` clean, `1` a violation, `2` could not run. Never let a `2` read as a `0`.
- For visual changes, take a "before" screenshot, make the change, take an "after" screenshot, and compare.
- After a clean run, don't repeat the same command unless the code has changed since — re-running on unchanged code adds no confidence.

## Script the check a reviewer must rerun

A check a reviewer must rerun is a lever: build and commit it per [Build the Lever](../principle-build-the-lever/SKILL.md).
