---
name: principle-build-the-lever
description: "Apply when work will be reused in later sessions, rerun by a reviewer, or carried out by delegates: edits, migrations, analyses, checks."
disable-model-invocation: false
user-invokable: false
---

# Build the Lever

When work must be repeated in a later session, rerun by a reviewer, or carried out by delegates, build the tool that does or proves it instead of doing it by hand.

A codemod, generator, or script does the work the same way every time and reruns for free. The tool is one artifact a reviewer can read and rerun to check the work. Hand-done changes can only be re-verified by redoing them. A deterministic script turns "trust me" into "run this".

A lever outlives the session. Combining tool calls inside the current session is codemode's job (`<codemode>` in the system prompt), and that script is discarded when the session ends. Promote it to a lever once it must exist afterwards: another session will reuse it, a reviewer will rerun it, or delegates will follow it.

- Do the first unit by hand to learn the recipe, then build the tool. Prove it by rerunning it on that unit and diffing against your hand-done version. Make the lever safe to rerun.
- Codemod or script for edits, generator for repetitive files, a dump-to-sqlite query for analysis, a rerunnable check for verification.
- When you fan work out to subagents, write the lever as a skill they all read: the recipe, the verification contract, and the do-not-touch fences in one artifact. Keep it outside the delegates' write scope so they can't quietly edit the contract.
- Applying this principle produces a committed file. If you cited it and there is no codemod, script, generator, check, or delegate skill in the diff, you didn't apply it.

Per the [Laziness Protocol](../principle-laziness-protocol/SKILL.md), build the smallest script that does or proves the job, never a framework.

Distinct from [Encode Lessons in Structure](../principle-encode-lessons-in-structure/SKILL.md), which makes a recurring instruction a durable guardrail. This is throughput and reviewability on the work in front of you. For what a check must observe, see [Prove It Works](../principle-prove-it-works/SKILL.md).
