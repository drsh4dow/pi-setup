---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/skill:reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript: the Pi session file at `$PI_SESSION_FILE`. Do not glob across `~/.pi/agent/sessions/*/`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
echo "$PI_SESSION_FILE"
```

Pi leaves it unset for an ephemeral session. Then pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Start three subagents together, per the **subagents** skill. Reviewers use MCP tools to look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer run the role named below in the subagents skill's model table. Pick each subagent's thinking level for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role | Prompt template |
|---|---|---|
| Judgment | `reflect judgment, synthesizer` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `references/tooling-reviewer.md` |
| Divergent | `reflect divergent` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final report.

## 3. Synthesize

One subagent in the `reflect judgment, synthesizer` role. It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): write it under the **writing-for-agents** skill.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite the description per the Context pointers section of the **writing-for-agents** skill.
- `new skill via writing-for-agents: <kebab-name>`: create it under the **writing-for-agents** skill. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
